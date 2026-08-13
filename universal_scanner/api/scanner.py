# Copyright (c) 2026, Universal Scanner Contributors
# License: MIT
# ─────────────────────────────────────────────────────────────────────────────
# Universal Scanner — Core API
#
# Provides a clean, whitelisted API for:
#   • Scanning barcodes and recording the result
#   • Managing Scan Sessions (start, complete, cancel)
#   • Retrieving session summaries for consumption by other Frappe apps
#
# Design principles:
#   • Zero dependencies on any application-specific DocType or business logic
#   • All product resolution happens server-side (never trust the browser)
#   • Configurable via SCANNER_CONFIG to support different product DocTypes
#   • No stock ledger entries are created under any circumstance
# ─────────────────────────────────────────────────────────────────────────────

import frappe
from frappe import _
import frappe.utils


# ─── Scanner Configuration ────────────────────────────────────────────────────
#
# This dict controls how the scanner resolves a raw barcode value to a product.
# Default: ERPNext Item → Item Barcode child table.
#
# To adapt for a different product DocType (e.g. "Blood Product" or "Vehicle"),
# another Frappe app can monkey-patch this dict at import time:
#
#   from universal_scanner.api import scanner as us
#   us.SCANNER_CONFIG["product_doctype"] = "Blood Product"
#   us.SCANNER_CONFIG["product_id_field"] = "blood_product_code"
#   ...
#
# Keys:
#   product_doctype      – DocType that represents a scannable product
#   product_id_field     – Field containing the unique product identifier
#   product_name_field   – Field containing the human-readable product name
#   barcode_doctype      – DocType (or child table) that maps barcodes to products
#   barcode_field        – Field in barcode_doctype holding the raw barcode string
#   barcode_parent_field – Field in barcode_doctype linking to product_doctype
#   uom_field            – Optional field for stock unit of measure

SCANNER_CONFIG = {
    "product_doctype": "Item",
    "product_id_field": "item_code",
    "product_name_field": "item_name",
    "barcode_doctype": "Item Barcode",
    "barcode_field": "barcode",
    "barcode_parent_field": "parent",
    "uom_field": "stock_uom",
}

# ─── Debounce ─────────────────────────────────────────────────────────────────
# Minimum time (milliseconds) that must elapse before the SAME barcode can be
# scanned again in the same session.  This prevents accidental double-triggers
# from keyboard-emulating scanners that emit multiple events.
# Set to 0 to disable.
DEBOUNCE_MS = 300


def validate_ean_checksum(barcode):
    """
    Validates standard EAN-13 or EAN-8 checksum.
    Returns True if valid checksum or if barcode is not standard EAN-8/13 length.
    Guards that string type and leading zeros are preserved.
    """
    barcode = str(barcode or "").strip()
    if not barcode or not barcode.isdigit():
        return False
    if len(barcode) not in (8, 13):
        return True  # Non-standard EAN length, skip check

    digits = [int(d) for d in barcode]
    check_digit = digits[-1]
    payload = digits[:-1]

    if len(barcode) == 13:
        # EAN-13: Odd indices * 1, Even indices * 3 (0-indexed: even idx * 1, odd idx * 3)
        total = sum(d * (1 if i % 2 == 0 else 3) for i, d in enumerate(payload))
    else:
        # EAN-8: Odd indices * 3, Even indices * 1 (0-indexed: even idx * 3, odd idx * 1)
        total = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(payload))

    calculated = (10 - (total % 10)) % 10
    return calculated == check_digit


# ─────────────────────────────────────────────────────────────────────────────
# Public Whitelisted API
# ─────────────────────────────────────────────────────────────────────────────


@frappe.whitelist()
def scan_product(barcode, session):
    """
    Primary scan endpoint. Called by the Product Scanner page on every scan.

    Validates the session, resolves the barcode to a product, creates a
    Product Scan Log record (quantity=1), and returns the updated totals.

    Args:
        barcode (str): Raw barcode string from the scanner.
        session (str): Name of an Active Scan Session.

    Returns:
        dict: {
            success (bool),
            product_id, product_name, barcode, uom,
            quantity (int),   ← total scanned in this session
            scan_count (int), ← number of individual scan events
            session (str)
        }

    On unknown barcode:
        dict: {
            success: False,
            error: "PRODUCT_NOT_FOUND",
            message: str,
            barcode: str
        }
    """
    barcode = (barcode or "").strip()
    session = (session or "").strip()

    if not barcode:
        frappe.throw(_("Barcode is required."), frappe.ValidationError)
    if not session:
        frappe.throw(_("Session is required."), frappe.ValidationError)

    # Validate session exists and is Active
    _validate_session(session)

    # Server-side debounce guard
    if DEBOUNCE_MS > 0:
        _check_debounce(barcode, session)

    # Resolve barcode → product
    product = find_product_by_barcode(barcode)
    if not product:
        return {
            "success": False,
            "error": "PRODUCT_NOT_FOUND",
            "message": _("No product was found for barcode {0}").format(barcode),
            "barcode": barcode,
        }

    # Inherit warehouse from session
    warehouse = frappe.db.get_value("Scan Session", session, "warehouse") or ""

    # Record individual scan log for granular audit history
    create_scan_log(
        session=session,
        barcode=barcode,
        item_code=product["item_code"],
        item_name=product["item_name"],
        warehouse=warehouse,
    )

    # Update summarized session_products child table and total counters on Scan Session
    session_doc = frappe.get_doc("Scan Session", session)
    session_doc.add_or_update_product(
        item_code=product["item_code"],
        item_name=product["item_name"],
        barcode=barcode,
        uom=product.get("uom", ""),
        warehouse=warehouse,
        qty=1,
    )
    session_doc.save(ignore_permissions=True)
    frappe.db.commit()

    # Get updated item totals from the child table
    item_qty = 0
    item_scans = 0
    for row in (session_doc.session_products or []):
        if row.item_code == product["item_code"]:
            item_qty = row.quantity
            item_scans = row.scan_count
            break

    return {
        "success": True,
        "product_id": product["item_code"],
        "product_name": product["item_name"],
        "barcode": barcode,
        "uom": product.get("uom", ""),
        "quantity": item_qty,
        "scan_count": item_scans,
        "session": session,
        "session_totals": {
            "total_products": session_doc.total_products,
            "total_units_scanned": session_doc.total_units_scanned,
        },
    }


@frappe.whitelist()
def get_session_summary(session):
    """
    Returns an aggregated summary of all scans in a session.

    Designed to be called by external Frappe applications that want to consume
    scanner data (e.g. to create a Purchase Receipt or Stock Entry).
    """
    session = (session or "").strip()
    if not session:
        frappe.throw(_("Session is required."), frappe.ValidationError)

    if not frappe.db.exists("Scan Session", session):
        frappe.throw(
            _("Scan Session '{0}' does not exist.").format(session),
            frappe.DoesNotExistError,
        )

    frappe.has_permission("Scan Session", "read", session, throw=True)
    session_doc = frappe.get_doc("Scan Session", session)

    products = []
    if session_doc.session_products:
        for p in session_doc.session_products:
            products.append(
                {
                    "product_id": p.item_code,
                    "product_name": p.item_name,
                    "barcode": p.barcode,
                    "quantity": int(p.quantity or 0),
                    "scan_count": int(p.scan_count or 0),
                    "uom": p.uom or "",
                    "warehouse": p.warehouse or "",
                }
            )
    else:
        # Fallback to aggregation query from logs if child table hasn't been populated yet
        rows = frappe.db.sql(
            """
            SELECT
                item_code           AS product_id,
                item_name           AS product_name,
                barcode,
                SUM(quantity)       AS quantity,
                COUNT(name)         AS scan_count
            FROM
                `tabProduct Scan Log`
            WHERE
                scan_session = %(session)s
            GROUP BY
                item_code, item_name, barcode
            ORDER BY
                scan_count DESC
            """,
            {"session": session},
            as_dict=True,
        )
        for row in rows:
            row["quantity"] = int(row["quantity"])
            row["scan_count"] = int(row["scan_count"])
        products = rows

    total_units = sum(p["quantity"] for p in products)
    total_products = len(products)

    return {
        "session": session,
        "status": session_doc.status,
        "products": products,
        "total_products": total_products,
        "total_units_scanned": total_units,
    }


def rebuild_session_products(session_name=None):
    """
    Rebuilds session_products child table and summary fields from Product Scan Log
    for one or all sessions. Ensures existing logs are safely migrated without data loss.
    """
    if not frappe.db.table_exists("Scan Session Product"):
        return

    filters = {}
    if session_name:
        filters["name"] = session_name

    sessions = frappe.db.get_all("Scan Session", filters=filters, pluck="name")

    for sname in sessions:
        doc = frappe.get_doc("Scan Session", sname)
        if not doc.meta.has_field("session_products"):
            continue

        logs = frappe.db.sql(
            """
            SELECT
                item_code,
                item_name,
                barcode,
                warehouse,
                SUM(quantity) AS quantity,
                COUNT(name) AS scan_count
            FROM `tabProduct Scan Log`
            WHERE scan_session = %(session)s
            GROUP BY item_code, item_name, barcode, warehouse
            """,
            {"session": sname},
            as_dict=True,
        )

        doc.set("session_products", [])
        for log in logs:
            doc.append(
                "session_products",
                {
                    "item_code": log["item_code"],
                    "item_name": log["item_name"],
                    "barcode": log["barcode"],
                    "quantity": int(log["quantity"] or 0),
                    "scan_count": int(log["scan_count"] or 0),
                    "warehouse": log.get("warehouse") or doc.warehouse or "",
                },
            )

        doc.recalculate_totals()
        doc.save(ignore_permissions=True)

    frappe.db.commit()


@frappe.whitelist()
def start_scan_session(warehouse="", description=""):
    """
    Creates a new Scan Session and immediately activates it.

    Args:
        warehouse (str): Optional warehouse name (must exist in ERPNext).
        description (str): Optional label for this session.

    Returns:
        dict: {session: str, status: str, started_at: str}
    """
    frappe.has_permission("Scan Session", "create", throw=True)

    doc = frappe.new_doc("Scan Session")
    doc.status = "Active"
    doc.started_by = frappe.session.user
    doc.started_at = frappe.utils.now()
    doc.warehouse = (warehouse or "").strip()
    doc.description = (description or "").strip()
    doc.insert(ignore_permissions=False)
    frappe.db.commit()

    return {
        "session": doc.name,
        "status": doc.status,
        "started_at": str(doc.started_at),
    }


@frappe.whitelist()
def complete_scan_session(session):
    """
    Marks a Scan Session as Completed.
    No further scans will be accepted for a Completed session.

    Args:
        session (str): The Scan Session name.

    Returns:
        dict: {session: str, status: str, ended_at: str}
    """
    session = (session or "").strip()
    doc = _get_session_doc_for_write(session)

    if doc.status not in ("Active", "Draft"):
        frappe.throw(
            _("Session '{0}' is already {1} and cannot be completed.").format(
                session, doc.status
            ),
            frappe.ValidationError,
        )

    doc.status = "Completed"
    doc.ended_at = frappe.utils.now()
    doc.save(ignore_permissions=False)
    frappe.db.commit()

    return {"session": doc.name, "status": doc.status, "ended_at": str(doc.ended_at)}


@frappe.whitelist()
def cancel_scan_session(session):
    """
    Marks a Scan Session as Cancelled.

    Args:
        session (str): The Scan Session name.

    Returns:
        dict: {session: str, status: str}
    """
    session = (session or "").strip()
    doc = _get_session_doc_for_write(session)

    if doc.status == "Completed":
        frappe.throw(
            _("Session '{0}' is already Completed and cannot be cancelled.").format(session),
            frappe.ValidationError,
        )

    doc.status = "Cancelled"
    doc.ended_at = frappe.utils.now()
    doc.save(ignore_permissions=False)
    frappe.db.commit()

    return {"session": doc.name, "status": doc.status}


@frappe.whitelist()
def get_active_sessions():
    """
    Returns a list of currently Active Scan Sessions.

    Returns:
        list of dict: [{name, description, warehouse, started_at, started_by}]
    """
    frappe.has_permission("Scan Session", "read", throw=True)

    return frappe.db.get_all(
        "Scan Session",
        filters={"status": "Active"},
        fields=["name", "description", "warehouse", "started_at", "started_by"],
        order_by="started_at desc",
        limit=100,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Internal Helpers (not whitelisted — not accessible from the browser)
# ─────────────────────────────────────────────────────────────────────────────


def find_product_by_barcode(barcode):
    """
    Resolves a raw barcode string to a product using SCANNER_CONFIG.

    Default behaviour:
      1. Look up the barcode in `Item Barcode` child table.
      2. Get the parent Item record.
      3. Verify the Item exists and is not disabled.

    Args:
        barcode (str): The raw barcode value to look up.

    Returns:
        dict or None: {item_code, item_name, uom} — or None if not found.
    """
    cfg = SCANNER_CONFIG

    # Step 1: Look up barcode in the barcode index table
    barcode_row = frappe.db.get_value(
        cfg["barcode_doctype"],
        {cfg["barcode_field"]: barcode},
        [cfg["barcode_parent_field"], "uom"],
        as_dict=True,
    )

    if not barcode_row:
        return None

    item_code = barcode_row.get(cfg["barcode_parent_field"])
    if not item_code:
        return None

    # Step 2: Fetch the product record
    fields_to_fetch = [cfg["product_id_field"], cfg["product_name_field"]]
    uom_field = cfg.get("uom_field")
    if uom_field and frappe.db.has_column(cfg["product_doctype"], uom_field):
        fields_to_fetch.append(uom_field)

    item = frappe.db.get_value(
        cfg["product_doctype"],
        {cfg["product_id_field"]: item_code},
        fields_to_fetch,
        as_dict=True,
    )

    if not item:
        return None

    # Step 3: Reject disabled items (if the field exists)
    if frappe.db.has_column(cfg["product_doctype"], "disabled"):
        if frappe.db.get_value(cfg["product_doctype"], item_code, "disabled"):
            return None

    # UOM: prefer the barcode-level UOM, fall back to item-level
    uom = barcode_row.get("uom") or (
        item.get(uom_field) if uom_field else ""
    )

    return {
        "item_code": item.get(cfg["product_id_field"]),
        "item_name": item.get(cfg["product_name_field"]),
        "uom": uom or "",
    }


def create_scan_log(session, barcode, item_code, item_name, warehouse=""):
    """
    Inserts one Product Scan Log record representing a single physical scan.

    quantity is always 1. Totals are computed by aggregating these records.

    Args:
        session (str): Active Scan Session name.
        barcode (str): Raw barcode value that was scanned.
        item_code (str): ERPNext Item Code resolved from the barcode.
        item_name (str): Item name (denormalised for display performance).
        warehouse (str): Optional warehouse (inherited from session).

    Returns:
        str: The name of the newly created Product Scan Log document.
    """
    doc = frappe.new_doc("Product Scan Log")
    doc.scan_session = session
    doc.barcode = barcode
    doc.item_code = item_code
    doc.item_name = item_name
    doc.quantity = 1  # enforced; also asserted by the DocType controller
    doc.scan_timestamp = frappe.utils.now()
    doc.scanned_by = frappe.session.user
    doc.warehouse = warehouse or ""
    doc.insert(ignore_permissions=True)
    frappe.db.commit()
    return doc.name


def get_product_scan_count(session, item_code):
    """
    Returns the aggregated quantity and scan count for one product in a session.

    Uses a single SQL query with SUM/COUNT for efficiency — suitable for
    sessions with thousands of scans without loading all records into Python.

    Args:
        session (str): Scan Session name.
        item_code (str): ERPNext Item Code.

    Returns:
        dict: {quantity: int, scan_count: int}
    """
    result = frappe.db.sql(
        """
        SELECT
            COALESCE(SUM(quantity), 0) AS quantity,
            COUNT(name)                AS scan_count
        FROM
            `tabProduct Scan Log`
        WHERE
            scan_session = %(session)s
            AND item_code = %(item_code)s
        """,
        {"session": session, "item_code": item_code},
        as_dict=True,
    )

    if result:
        return {
            "quantity": int(result[0]["quantity"]),
            "scan_count": int(result[0]["scan_count"]),
        }
    return {"quantity": 0, "scan_count": 0}


def _validate_session(session):
    """
    Verifies that a Scan Session exists and has status=Active.
    Raises appropriate Frappe exceptions if not.

    Also checks that the current user has read permission on the session.
    """
    if not frappe.db.exists("Scan Session", session):
        frappe.throw(
            _("Scan Session '{0}' does not exist.").format(session),
            frappe.DoesNotExistError,
        )

    status = frappe.db.get_value("Scan Session", session, "status")
    if status != "Active":
        frappe.throw(
            _(
                "Scan Session '{0}' is not active (status: {1}). "
                "Please select or start an Active session."
            ).format(session, status),
            frappe.ValidationError,
        )

    frappe.has_permission("Scan Session", "read", session, throw=True)


def _get_session_doc_for_write(session):
    """
    Fetches a Scan Session document after checking write permission.
    Raises DoesNotExistError if the session is not found.
    """
    if not frappe.db.exists("Scan Session", session):
        frappe.throw(
            _("Scan Session '{0}' does not exist.").format(session),
            frappe.DoesNotExistError,
        )
    frappe.has_permission("Scan Session", "write", session, throw=True)
    return frappe.get_doc("Scan Session", session)


def _check_debounce(barcode, session):
    """
    Rejects a scan if the same barcode was scanned in this session within
    DEBOUNCE_MS milliseconds.  Guards against hardware scanners that emit
    duplicate events from a single trigger press.

    Raises frappe.ValidationError if the debounce window has not expired.
    """
    cutoff = frappe.utils.add_to_date(
        frappe.utils.now_datetime(),
        seconds=-(DEBOUNCE_MS / 1000.0),
    )

    recent = frappe.db.sql(
        """
        SELECT COUNT(name) AS cnt
        FROM `tabProduct Scan Log`
        WHERE scan_session = %(session)s
          AND barcode      = %(barcode)s
          AND scan_timestamp >= %(cutoff)s
        """,
        {"session": session, "barcode": barcode, "cutoff": cutoff},
        as_dict=True,
    )

    if recent and int(recent[0]["cnt"]) > 0:
        frappe.throw(
            _(
                "Duplicate scan detected within {0}ms. "
                "Please wait before scanning the same barcode again."
            ).format(DEBOUNCE_MS),
            frappe.ValidationError,
        )
