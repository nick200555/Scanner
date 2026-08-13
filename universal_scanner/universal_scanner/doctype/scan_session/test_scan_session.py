# Copyright (c) 2026, Universal Scanner Contributors
# License: MIT
# ─────────────────────────────────────────────────────────────────────────────
# Tests for the Scan Session DocType lifecycle.
# Run with: bench run-tests --app universal_scanner --module universal_scanner.universal_scanner.doctype.scan_session.test_scan_session
# ─────────────────────────────────────────────────────────────────────────────

import unittest

import frappe


class TestScanSession(unittest.TestCase):
    """Tests for the Scan Session DocType status lifecycle and validation."""

    def setUp(self):
        """Track documents created during each test for cleanup."""
        self._created_docs = []

    def tearDown(self):
        """Delete all test sessions created in this test."""
        for docname in reversed(self._created_docs):
            try:
                # Delete scan logs first (FK constraint)
                frappe.db.delete("Product Scan Log", {"scan_session": docname})
                frappe.delete_doc(
                    "Scan Session", docname, force=True, ignore_missing=True
                )
            except Exception:
                pass
        frappe.db.commit()

    # ─── Helpers ─────────────────────────────────────────────────────────────

    def _make_session(self, status="Active", warehouse=None, description=None):
        """Create and insert a test Scan Session."""
        doc = frappe.new_doc("Scan Session")
        doc.status = status
        doc.started_by = frappe.session.user
        if status == "Active":
            doc.started_at = frappe.utils.now()
        if warehouse:
            doc.warehouse = warehouse
        if description:
            doc.description = description
        doc.insert(ignore_permissions=True)
        frappe.db.commit()
        self._created_docs.append(doc.name)
        return doc

    # ─── Naming Tests ─────────────────────────────────────────────────────────

    def test_session_naming_prefix(self):
        """Session names must start with SESSION-."""
        doc = self._make_session()
        self.assertTrue(
            doc.name.startswith("SESSION-"),
            f"Expected SESSION- prefix, got: {doc.name}",
        )

    # ─── Status Tests ─────────────────────────────────────────────────────────

    def test_create_active_session(self):
        """A new session can be created with Active status."""
        doc = self._make_session(status="Active")
        self.assertEqual(doc.status, "Active")

    def test_create_draft_session(self):
        """A new session can be created with Draft status."""
        doc = self._make_session(status="Draft")
        self.assertEqual(doc.status, "Draft")

    def test_draft_can_be_activated(self):
        """A Draft session can be transitioned to Active."""
        doc = self._make_session(status="Draft")
        doc.status = "Active"
        doc.started_at = frappe.utils.now()
        doc.save(ignore_permissions=True)
        frappe.db.commit()
        self.assertEqual(
            frappe.db.get_value("Scan Session", doc.name, "status"), "Active"
        )

    def test_active_can_be_completed(self):
        """An Active session can be transitioned to Completed."""
        doc = self._make_session(status="Active")
        doc.status = "Completed"
        doc.ended_at = frappe.utils.now()
        doc.save(ignore_permissions=True)
        frappe.db.commit()
        self.assertEqual(
            frappe.db.get_value("Scan Session", doc.name, "status"), "Completed"
        )

    def test_active_can_be_cancelled(self):
        """An Active session can be transitioned to Cancelled."""
        doc = self._make_session(status="Active")
        doc.status = "Cancelled"
        doc.ended_at = frappe.utils.now()
        doc.save(ignore_permissions=True)
        frappe.db.commit()
        self.assertEqual(
            frappe.db.get_value("Scan Session", doc.name, "status"), "Cancelled"
        )

    # ─── Immutability Tests ───────────────────────────────────────────────────

    def test_completed_session_cannot_be_reactivated(self):
        """A Completed session cannot be set back to Active."""
        doc = self._make_session(status="Active")
        doc.status = "Completed"
        doc.ended_at = frappe.utils.now()
        doc.save(ignore_permissions=True)
        frappe.db.commit()

        doc.reload()
        doc.status = "Active"
        with self.assertRaises(frappe.ValidationError):
            doc.save(ignore_permissions=True)

    def test_completed_session_cannot_be_cancelled(self):
        """A Completed session cannot be moved to Cancelled."""
        doc = self._make_session(status="Active")
        doc.status = "Completed"
        doc.ended_at = frappe.utils.now()
        doc.save(ignore_permissions=True)
        frappe.db.commit()

        doc.reload()
        doc.status = "Cancelled"
        with self.assertRaises(frappe.ValidationError):
            doc.save(ignore_permissions=True)

    def test_cancelled_session_is_immutable(self):
        """A Cancelled session cannot be changed to any other status."""
        doc = self._make_session(status="Active")
        doc.status = "Cancelled"
        doc.ended_at = frappe.utils.now()
        doc.save(ignore_permissions=True)
        frappe.db.commit()

        doc.reload()
        doc.status = "Active"
        with self.assertRaises(frappe.ValidationError):
            doc.save(ignore_permissions=True)

    # ─── Timestamp Tests ──────────────────────────────────────────────────────

    def test_started_at_auto_set_on_active(self):
        """started_at is set automatically when status becomes Active."""
        doc = frappe.new_doc("Scan Session")
        doc.status = "Active"
        doc.started_by = frappe.session.user
        # Do NOT set started_at — let the controller do it
        doc.insert(ignore_permissions=True)
        frappe.db.commit()
        self._created_docs.append(doc.name)
        self.assertIsNotNone(doc.started_at)

    def test_ended_at_auto_set_on_complete(self):
        """ended_at is set automatically when session is completed."""
        doc = self._make_session(status="Active")
        doc.status = "Completed"
        doc.save(ignore_permissions=True)
        frappe.db.commit()
        doc.reload()
        self.assertIsNotNone(doc.ended_at)
