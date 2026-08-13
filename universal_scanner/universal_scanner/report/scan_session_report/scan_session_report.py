# Copyright (c) 2026, Universal Scanner Contributors
# License: MIT
# ─────────────────────────────────────────────────────────────────────────────
# Scan Session Report — Aggregates Scan Sessions with all scanned products.
# ─────────────────────────────────────────────────────────────────────────────

import frappe


def execute(filters=None):
    if not filters:
        filters = {}

    columns = get_columns()
    data = get_data(filters)

    return columns, data


def get_columns():
    return [
        {
            "fieldname": "scan_session",
            "label": "Scan Session",
            "fieldtype": "Link",
            "options": "Scan Session",
            "width": 180,
        },
        {
            "fieldname": "status",
            "label": "Status",
            "fieldtype": "Data",
            "width": 100,
        },
        {
            "fieldname": "started_at",
            "label": "Started At",
            "fieldtype": "Datetime",
            "width": 150,
        },
        {
            "fieldname": "warehouse",
            "label": "Warehouse",
            "fieldtype": "Link",
            "options": "Warehouse",
            "width": 140,
        },
        {
            "fieldname": "item_code",
            "label": "Item Code",
            "fieldtype": "Link",
            "options": "Item",
            "width": 150,
        },
        {
            "fieldname": "item_name",
            "label": "Item Name",
            "fieldtype": "Data",
            "width": 200,
        },
        {
            "fieldname": "barcode",
            "label": "Barcode",
            "fieldtype": "Data",
            "width": 150,
        },
        {
            "fieldname": "total_qty",
            "label": "Scanned Qty",
            "fieldtype": "Int",
            "width": 120,
        },
        {
            "fieldname": "total_scans",
            "label": "Scan Count",
            "fieldtype": "Int",
            "width": 110,
        },
    ]


def get_data(filters):
    conditions = []
    if filters.get("scan_session"):
        conditions.append("s.name = %(scan_session)s")
    if filters.get("status"):
        conditions.append("s.status = %(status)s")
    if filters.get("from_date"):
        conditions.append("s.started_at >= %(from_date)s")
    if filters.get("to_date"):
        conditions.append("s.started_at <= %(to_date)s")

    where_clause = (" WHERE " + " AND ".join(conditions)) if conditions else ""

    sql = f"""
        SELECT
            s.name AS scan_session,
            s.status AS status,
            s.started_at AS started_at,
            s.warehouse AS warehouse,
            l.item_code AS item_code,
            l.item_name AS item_name,
            l.barcode AS barcode,
            COALESCE(SUM(l.quantity), 0) AS total_qty,
            COUNT(l.name) AS total_scans
        FROM
            `tabScan Session` s
        LEFT JOIN
            `tabProduct Scan Log` l ON l.scan_session = s.name
        {where_clause}
        GROUP BY
            s.name, s.status, s.started_at, s.warehouse, l.item_code, l.item_name, l.barcode
        ORDER BY
            s.started_at DESC, s.name DESC, l.item_code ASC
    """
    rows = frappe.db.sql(sql, filters, as_dict=True)

    # Cast integer fields
    for row in rows:
        row["total_qty"] = int(row.get("total_qty") or 0)
        row["total_scans"] = int(row.get("total_scans") or 0)

    return rows
