# Copyright (c) 2026, Universal Scanner Contributors
# License: MIT
# ─────────────────────────────────────────────────────────────────────────────
# Migration patch to populate Scan Session Product child table from existing logs.
# ─────────────────────────────────────────────────────────────────────────────

from universal_scanner.api.scanner import rebuild_session_products


def execute():
    rebuild_session_products()
