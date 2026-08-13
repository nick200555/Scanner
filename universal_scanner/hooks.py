# Copyright (c) 2026, Universal Scanner Contributors
# License: MIT
# ─────────────────────────────────────────────────────────────────────────────
# Frappe application hooks for universal_scanner.
# This app is completely independent — it does NOT hook into any other app's
# DocTypes, and has no dependencies on dehaat_procurement or any other
# custom Frappe application.
# ─────────────────────────────────────────────────────────────────────────────

from . import __version__ as app_version

app_name = "universal_scanner"
app_title = "Universal Scanner"
app_publisher = "Universal Scanner Contributors"
app_description = "Reusable barcode scanning and inventory counting application for Frappe/ERPNext"
app_email = "info@example.com"
app_license = "MIT"
app_version = "1.0.0"

# ─── Required Apps ────────────────────────────────────────────────────────────
# ERPNext is required for the Item/Item Barcode DocTypes used in product lookup.
# Remove "erpnext" here if you want to use with plain Frappe + custom item DocType.
required_apps = ["frappe", "erpnext"]

# ─── Fixtures ─────────────────────────────────────────────────────────────────
# Export the Scanner User role so it is created on bench migrate.
fixtures = [
    {
        "dt": "Role",
        "filters": [["name", "in", ["Scanner User"]]],
    },
]

# ─── Document Events ──────────────────────────────────────────────────────────
# No doc_events — the scanner is a passive counting tool.
# It does NOT hook into Purchase Orders, Stock Entries, or any ERPNext DocType.
doc_events = {}

# ─── Scheduled Tasks ──────────────────────────────────────────────────────────
scheduler_events = {}

# ─── Website Routes ───────────────────────────────────────────────────────────
website_route_rules = []

# ─── Permission Query Conditions ──────────────────────────────────────────────
permission_query_conditions = {}

# ─── Has Permission ───────────────────────────────────────────────────────────
has_permission = {}

# ─── App Includes (global JS/CSS loaded on every page) ────────────────────────
app_include_css = []
app_include_js = []

# ─── Web Include ──────────────────────────────────────────────────────────────
web_include_css = []
web_include_js = []

# ─── Override Whitelisted Methods ─────────────────────────────────────────────
override_whitelisted_methods = {}
