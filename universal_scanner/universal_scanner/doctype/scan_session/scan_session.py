# Copyright (c) 2026, Universal Scanner Contributors
# License: MIT
# ─────────────────────────────────────────────────────────────────────────────
# Scan Session DocType controller.
# Manages session lifecycle: Draft → Active → Completed / Cancelled.
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

    def on_trash(self):
        """
        Cascade-delete child scan logs when a session is deleted.
        This keeps orphan Product Scan Log records from accumulating.
        """
        frappe.db.delete("Product Scan Log", {"scan_session": self.name})

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
