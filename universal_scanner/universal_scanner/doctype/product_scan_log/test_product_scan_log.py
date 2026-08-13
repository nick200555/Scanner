# Copyright (c) 2026, Universal Scanner Contributors
# License: MIT
# ─────────────────────────────────────────────────────────────────────────────
# Tests for scan_product API and Product Scan Log DocType.
#
# These tests create real ERPNext Items with barcodes, run the scanner API,
# and verify quantity accumulation, audit trail, and session validation.
#
# Run with:
#   bench run-tests --app universal_scanner
# ─────────────────────────────────────────────────────────────────────────────

import time
import unittest

import frappe

from universal_scanner.api.scanner import (
    create_scan_log,
    find_product_by_barcode,
    get_product_scan_count,
    get_session_summary,
    scan_product,
)

# ─── Test Fixtures ────────────────────────────────────────────────────────────
# Use unique barcodes that will not conflict with real data
_TEST_BARCODE_1 = "US-TEST-BC-001-AAAAA"
_TEST_BARCODE_2 = "US-TEST-BC-002-BBBBB"
_TEST_BARCODE_3 = "US-TEST-BC-003-CCCCC"
_NONEXISTENT_BARCODE = "US-TEST-BC-NONEXISTENT-99999"


class TestProductScanLog(unittest.TestCase):
    """
    Integration tests for the scanner API.

    Requires ERPNext (for Item / Item Barcode DocTypes).
    Creates and tears down test Items and Scan Sessions automatically.
    """

    @classmethod
    def setUpClass(cls):
        """Create test Items with barcodes once for the whole test class."""
        frappe.set_user("Administrator")
        cls._created_items = []
        cls._created_sessions = []

        cls.item1_code = "US-TEST-ITEM-001"
        cls.item2_code = "US-TEST-ITEM-002"
        cls.item3_code = "US-TEST-ITEM-003"

        cls._create_test_item(cls.item1_code, "US Test Item Alpha", _TEST_BARCODE_1)
        cls._create_test_item(cls.item2_code, "US Test Item Beta", _TEST_BARCODE_2)
        cls._create_test_item(cls.item3_code, "US Test Item Gamma", _TEST_BARCODE_3)

    @classmethod
    def tearDownClass(cls):
        """Remove all test data in the correct FK order."""
        for session in cls._created_sessions:
            frappe.db.delete("Product Scan Log", {"scan_session": session})
            frappe.delete_doc(
                "Scan Session", session, force=True, ignore_missing=True
            )

        for item_code in cls._created_items:
            frappe.db.delete("Item Barcode", {"parent": item_code})
            frappe.delete_doc("Item", item_code, force=True, ignore_missing=True)

        frappe.db.commit()

    @classmethod
    def _create_test_item(cls, item_code, item_name, barcode):
        """Insert a minimal ERPNext Item with a single barcode."""
        if frappe.db.exists("Item", item_code):
            frappe.db.delete("Item Barcode", {"parent": item_code})
            frappe.delete_doc("Item", item_code, force=True)

        doc = frappe.new_doc("Item")
        doc.item_code = item_code
        doc.item_name = item_name
        doc.item_group = "Products"
        doc.stock_uom = "Nos"
        doc.is_stock_item = 1
        doc.append("barcodes", {"barcode": barcode, "barcode_type": "EAN"})
        doc.insert(ignore_permissions=True)
        frappe.db.commit()
        cls._created_items.append(item_code)

    @classmethod
    def _make_session(cls, status="Active"):
        """Create a Scan Session for use in tests."""
        doc = frappe.new_doc("Scan Session")
        doc.status = status
        doc.started_by = frappe.session.user
        doc.started_at = frappe.utils.now()
        doc.description = "Automated test session"
        doc.insert(ignore_permissions=True)
        frappe.db.commit()
        cls._created_sessions.append(doc.name)
        return doc.name

    # ─── Barcode Lookup Tests ─────────────────────────────────────────────────

    def test_find_product_by_valid_barcode(self):
        """A valid barcode returns the correct Item code and name."""
        result = find_product_by_barcode(_TEST_BARCODE_1)
        self.assertIsNotNone(result, "Expected a product for a valid barcode")
        self.assertEqual(result["item_code"], self.item1_code)
        self.assertEqual(result["item_name"], "US Test Item Alpha")

    def test_find_product_by_second_barcode(self):
        """A second valid barcode resolves to the correct distinct Item."""
        result = find_product_by_barcode(_TEST_BARCODE_2)
        self.assertIsNotNone(result)
        self.assertEqual(result["item_code"], self.item2_code)

    def test_find_product_invalid_barcode_returns_none(self):
        """An unknown barcode returns None, not an exception."""
        result = find_product_by_barcode(_NONEXISTENT_BARCODE)
        self.assertIsNone(result)

    # ─── Scan Quantity Accumulation Tests ─────────────────────────────────────

    def test_first_scan_returns_quantity_1(self):
        """The very first scan of a barcode in a fresh session gives quantity=1."""
        session = self._make_session()
        r = scan_product(barcode=_TEST_BARCODE_1, session=session)
        self.assertTrue(r["success"], msg=str(r))
        self.assertEqual(r["quantity"], 1)
        self.assertEqual(r["scan_count"], 1)

    def test_repeated_scans_accumulate_correctly(self):
        """3 scans of the same barcode must give quantity=3, scan_count=3."""
        session = self._make_session()

        r1 = scan_product(barcode=_TEST_BARCODE_2, session=session)
        self.assertTrue(r1["success"])
        self.assertEqual(r1["quantity"], 1)

        time.sleep(0.4)   # respect 300ms debounce
        r2 = scan_product(barcode=_TEST_BARCODE_2, session=session)
        self.assertTrue(r2["success"])
        self.assertEqual(r2["quantity"], 2)

        time.sleep(0.4)
        r3 = scan_product(barcode=_TEST_BARCODE_2, session=session)
        self.assertTrue(r3["success"])
        self.assertEqual(r3["quantity"], 3)
        self.assertEqual(r3["scan_count"], 3)

    def test_scan_creates_individual_log_records(self):
        """Each physical scan must create a separate Product Scan Log row."""
        session = self._make_session()
        for _ in range(3):
            scan_product(barcode=_TEST_BARCODE_3, session=session)
            time.sleep(0.4)

        count = frappe.db.count(
            "Product Scan Log",
            {"scan_session": session, "barcode": _TEST_BARCODE_3},
        )
        self.assertEqual(count, 3, "Expected 3 individual log records for 3 scans")

    def test_each_log_record_has_quantity_1(self):
        """Every Product Scan Log record must have quantity=1 regardless of history."""
        session = self._make_session()
        scan_product(barcode=_TEST_BARCODE_1, session=session)

        logs = frappe.db.get_all(
            "Product Scan Log",
            filters={"scan_session": session, "barcode": _TEST_BARCODE_1},
            fields=["name", "quantity"],
        )
        for log in logs:
            self.assertEqual(
                log["quantity"], 1,
                f"Log {log['name']} has quantity={log['quantity']}, expected 1"
            )

    # ─── Unknown Barcode Tests ────────────────────────────────────────────────

    def test_scan_unknown_barcode_returns_failure(self):
        """Scanning an unknown barcode returns success=False and PRODUCT_NOT_FOUND."""
        session = self._make_session()
        r = scan_product(barcode=_NONEXISTENT_BARCODE, session=session)
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], "PRODUCT_NOT_FOUND")

    # ─── Session Validation Tests ─────────────────────────────────────────────

    def test_scan_rejected_on_completed_session(self):
        """Scanning on a Completed session raises ValidationError."""
        session = self._make_session(status="Active")
        frappe.db.set_value("Scan Session", session, "status", "Completed")
        frappe.db.commit()
        with self.assertRaises(frappe.ValidationError):
            scan_product(barcode=_TEST_BARCODE_1, session=session)

    def test_scan_rejected_on_cancelled_session(self):
        """Scanning on a Cancelled session raises ValidationError."""
        session = self._make_session(status="Active")
        frappe.db.set_value("Scan Session", session, "status", "Cancelled")
        frappe.db.commit()
        with self.assertRaises(frappe.ValidationError):
            scan_product(barcode=_TEST_BARCODE_1, session=session)

    def test_scan_rejected_on_nonexistent_session(self):
        """Scanning with a non-existent session name raises DoesNotExistError."""
        with self.assertRaises(frappe.DoesNotExistError):
            scan_product(
                barcode=_TEST_BARCODE_1,
                session="SESSION-DOES-NOT-EXIST-99999",
            )

    # ─── Session Summary Tests ────────────────────────────────────────────────

    def test_session_summary_aggregates_correctly(self):
        """
        Session summary must return correct quantity per Item and correct total.

        Scan:  item1 x5,  item2 x3,  item3 x8  → total 16
        """
        session = self._make_session()

        for _ in range(5):
            create_scan_log(
                session=session,
                barcode=_TEST_BARCODE_1,
                item_code=self.item1_code,
                item_name="US Test Item Alpha",
            )

        for _ in range(3):
            create_scan_log(
                session=session,
                barcode=_TEST_BARCODE_2,
                item_code=self.item2_code,
                item_name="US Test Item Beta",
            )

        for _ in range(8):
            create_scan_log(
                session=session,
                barcode=_TEST_BARCODE_3,
                item_code=self.item3_code,
                item_name="US Test Item Gamma",
            )

        summary = get_session_summary(session)
        self.assertEqual(summary["total_units_scanned"], 16)
        self.assertEqual(summary["total_products"], 3)

        by_product = {p["product_id"]: p for p in summary["products"]}
        self.assertEqual(by_product[self.item1_code]["quantity"], 5)
        self.assertEqual(by_product[self.item1_code]["scan_count"], 5)
        self.assertEqual(by_product[self.item2_code]["quantity"], 3)
        self.assertEqual(by_product[self.item2_code]["scan_count"], 3)
        self.assertEqual(by_product[self.item3_code]["quantity"], 8)
        self.assertEqual(by_product[self.item3_code]["scan_count"], 8)

    def test_rebuild_session_products_migration(self):
        """rebuild_session_products safely populates session_products from historical logs."""
        from universal_scanner.api.scanner import rebuild_session_products

        session = self._make_session()
        create_scan_log(session=session, barcode=_TEST_BARCODE_1, item_code=self.item1_code, item_name="Alpha")
        create_scan_log(session=session, barcode=_TEST_BARCODE_1, item_code=self.item1_code, item_name="Alpha")
        create_scan_log(session=session, barcode=_TEST_BARCODE_2, item_code=self.item2_code, item_name="Beta")

        # Clear child table to simulate historical data created before child table existed
        doc = frappe.get_doc("Scan Session", session)
        doc.set("session_products", [])
        doc.total_products = 0
        doc.total_units_scanned = 0
        doc.save(ignore_permissions=True)

        rebuild_session_products(session)

        doc.reload()
        self.assertEqual(doc.total_products, 2)
        self.assertEqual(doc.total_units_scanned, 3)

    def test_session_summary_empty_for_new_session(self):
        """A new session with no scans returns an empty products list."""
        session = self._make_session()
        summary = get_session_summary(session)
        self.assertEqual(summary["total_units_scanned"], 0)
        self.assertEqual(summary["total_products"], 0)
        self.assertEqual(summary["products"], [])
