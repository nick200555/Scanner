# Copyright (c) 2026, Universal Scanner Contributors
# License: MIT
# ─────────────────────────────────────────────────────────────────────────────
# Migration patch to populate Scan Session Product child table from existing logs.
# ─────────────────────────────────────────────────────────────────────────────

import frappe
from universal_scanner.api.scanner import rebuild_session_products


def execute():
    # Force schema reload before building child records during migrate
    frappe.reload_doc("universal_scanner", "doctype", "scan_session_product")
    frappe.reload_doc("universal_scanner", "doctype", "scan_session")
    rebuild_session_products()
