# Copyright (c) 2026, Universal Scanner Contributors
# License: MIT
# ─────────────────────────────────────────────────────────────────────────────
# Product Scan Log DocType controller.
# Represents a single physical barcode scan event (quantity always = 1).
# ─────────────────────────────────────────────────────────────────────────────

import frappe
from frappe import _
from frappe.model.document import Document


class ProductScanLog(Document):

    # ─── Lifecycle Hooks ──────────────────────────────────────────────────────

    def before_insert(self):
        """Set defaults before first save."""
        if not self.scanned_by:
            self.scanned_by = frappe.session.user
        if not self.scan_timestamp:
            self.scan_timestamp = frappe.utils.now()
        # Enforce quantity = 1 even before validate runs
        self.quantity = 1

    def validate(self):
        """Validate all fields before saving."""
        self._validate_session()
        self._validate_item()
        self._enforce_quantity()

    # ─── Validation Helpers ───────────────────────────────────────────────────

    def _validate_session(self):
        """Ensure the linked session exists and is currently Active."""
        if not self.scan_session:
            frappe.throw(_("Scan Session is required."), frappe.MandatoryError)

        if not frappe.db.exists("Scan Session", self.scan_session):
            frappe.throw(
                _("Scan Session '{0}' does not exist.").format(self.scan_session),
                frappe.DoesNotExistError,
            )

        status = frappe.db.get_value("Scan Session", self.scan_session, "status")
        if status != "Active":
            frappe.throw(
                _("Cannot add a scan log to a '{0}' session. Session must be Active.").format(status),
                frappe.ValidationError,
            )

    def _validate_item(self):
        """Ensure the referenced ERPNext Item exists."""
        if not self.item_code:
            frappe.throw(_("Item Code is required."), frappe.MandatoryError)

        if not frappe.db.exists("Item", self.item_code):
            frappe.throw(
                _("Item '{0}' does not exist.").format(self.item_code),
                frappe.DoesNotExistError,
            )

    def _enforce_quantity(self):
        """
        Each Product Scan Log record MUST have quantity = 1.
        One physical scan = one unit. Totals are computed by aggregation.
        This prevents any client from bypassing the counting audit trail.
        """
        if self.quantity != 1:
            self.quantity = 1
