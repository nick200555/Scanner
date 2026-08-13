# Copyright (c) 2026, Universal Scanner Contributors
# License: MIT
# ─────────────────────────────────────────────────────────────────────────────
# Product Scanner page server-side controller.
# The actual scanner logic lives in universal_scanner/api/scanner.py.
# This file exists as required by Frappe's page architecture.
# ─────────────────────────────────────────────────────────────────────────────

import frappe


def get_context(context):
    """Minimal page context — the UI is built entirely in JavaScript."""
    context.no_cache = 1
