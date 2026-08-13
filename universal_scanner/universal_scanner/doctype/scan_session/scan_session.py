# Copyright (c) 2026, Universal Scanner Contributors
# License: MIT
# ─────────────────────────────────────────────────────────────────────────────
# Scan Session DocType controller.
# Manages session lifecycle: Draft → Active → Completed / Cancelled,
# and maintains summarized product counts in the session_products child table.
# ─────────────────────────────────────────────────────────────────────────────

import frappe
from frappe import _
from frappe.model.document import Document


class ScanSession(Document):

    # ─── Lifecycle Hooks ──────────────────────────────────────────────────────

    def before_insert(self):
        """Set defaults that should be present on the very first save."""
        if not self.started_by:
            self.started_by = frappe.session.user
        if self.status == "Active" and not self.started_at:
            self.started_at = frappe.utils.now()

    def validate(self):
        """Run all validation rules on every save."""
        self._validate_status_transition()
        self._set_timestamps()
        self.recalculate_totals()

    def on_trash(self):
        """
        Cascade-delete child scan logs when a session is deleted.
        This keeps orphan Product Scan Log records from accumulating.
        """
        frappe.db.delete("Product Scan Log", {"scan_session": self.name})

    # ─── Summary & Product Helpers ───────────────────────────────────────────

    def recalculate_totals(self):
        """Recalculate summary totals from the session_products child table."""
        products = self.session_products or []
        self.total_products = len(products)
        self.total_units_scanned = sum(int(p.quantity or 0) for p in products)

    def add_or_update_product(self, item_code, item_name, barcode, uom="", warehouse="", qty=1):
        """
        Adds a new product row or increments an existing row in session_products.

        One row per product is maintained.
        """
        if self.status != "Active":
            frappe.throw(
                _("Cannot scan items into a '{0}' session. Session must be Active.").format(self.status),
                frappe.ValidationError,
            )

        existing_row = None
        for row in (self.session_products or []):
            if row.item_code == item_code:
                existing_row = row
                break

        if existing_row:
            existing_row.quantity = int(existing_row.quantity or 0) + qty
            existing_row.scan_count = int(existing_row.scan_count or 0) + qty
            if barcode and not existing_row.barcode:
                existing_row.barcode = barcode
            if uom and not existing_row.uom:
                existing_row.uom = uom
            if warehouse and not existing_row.warehouse:
                existing_row.warehouse = warehouse
        else:
            self.append(
                "session_products",
                {
                    "item_code": item_code,
                    "item_name": item_name,
                    "barcode": barcode,
                    "quantity": qty,
                    "scan_count": qty,
                    "uom": uom or "",
                    "warehouse": warehouse or self.warehouse or "",
                },
            )

        self.recalculate_totals()

    # ─── Validation Helpers ───────────────────────────────────────────────────

    def _validate_status_transition(self):
        """
        Enforce valid status transitions to prevent accidental state regression.

        Allowed transitions:
          Draft     → Active, Cancelled
          Active    → Completed, Cancelled
          Completed → (no changes)
          Cancelled → (no changes)
        """
        if self.is_new():
            # Any status is valid on initial insert
            return

        old_status = frappe.db.get_value("Scan Session", self.name, "status")

        if old_status == "Completed" and self.status != "Completed":
            frappe.throw(
                _("A Completed session cannot be changed to '{0}'.").format(self.status),
                frappe.ValidationError,
            )

        if old_status == "Cancelled" and self.status != "Cancelled":
            frappe.throw(
                _("A Cancelled session cannot be changed."),
                frappe.ValidationError,
            )

    def _set_timestamps(self):
        """Auto-populate timestamps when status changes."""
        if self.status == "Active" and not self.started_at:
            self.started_at = frappe.utils.now()

        if self.status in ("Completed", "Cancelled") and not self.ended_at:
            self.ended_at = frappe.utils.now()
