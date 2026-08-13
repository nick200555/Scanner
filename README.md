# Universal Scanner

A **completely independent, reusable Frappe/ERPNext application** for barcode scanning and inventory counting.

The scanner's only responsibility:

```
Scan a barcode
      ↓
Identify the product
      ↓
Record the scan (audit trail)
      ↓
Quantity + 1
      ↓
Return Product ID + accumulated quantity
```

Other applications consume the scanner's output via its clean API. The scanner itself **never touches** the ERPNext stock ledger, Purchase Orders, Purchase Receipts, or any application-specific business logic.

---

## Table of Contents

1. [What it does](#1-what-it-does)
2. [Installation](#2-installation)
3. [Using the Scanner](#3-using-the-scanner)
4. [DocTypes](#4-doctypes)
5. [API Reference](#5-api-reference)
6. [Consuming Scanner Data from Another App](#6-consuming-scanner-data-from-another-app)
7. [Permissions](#7-permissions)
8. [Configuration](#8-configuration)
9. [Extension Points](#9-extension-points)
10. [Testing](#10-testing)
11. [Architecture](#11-architecture)
12. [License](#12-license)

---

## 1. What it does

| Feature | Detail |
|---|---|
| Barcode input | USB scanner, Bluetooth scanner, keyboard-emulating scanner, or manual entry |
| Product lookup | ERPNext `Item Barcode` → `Item` (configurable) |
| Scan recording | One `Product Scan Log` row per physical scan (quantity always = 1) |
| Session grouping | All scans in an activity belong to one `Scan Session` |
| Audit trail | Every individual scan is preserved forever; totals are computed by aggregation |
| Stock ledger | **Never touched.** Scanning is counting only. |
| API | Clean `@frappe.whitelist()` API for external consumption |

### What it does NOT do

- Create Stock Entries
- Create Purchase Receipts
- Create Delivery Notes
- Create Sales Invoices
- Modify any ERPNext stock balances

---

## 2. Installation

### Prerequisites

- A running Frappe Bench (Linux server)
- Frappe v14 or v15 (v16 compatible)
- ERPNext installed (for the `Item` / `Item Barcode` DocTypes)

### Install the app

```bash
# Navigate to your bench directory
cd /home/frappe/frappe-bench

# Get the app from the repository
bench get-app https://github.com/<your-org>/universal_scanner

# Install on your site
bench --site your-site.example.com install-app universal_scanner

# Run migrations to create the database tables
bench --site your-site.example.com migrate
```

### Verify installation

```bash
bench --site your-site.example.com list-apps
```

You should see `universal_scanner` in the output.

---

## 3. Using the Scanner

### Step 1: Open the scanner page

Navigate to:

```
https://your-site.example.com/app/product-scanner
```

### Step 2: Start a Scan Session

1. Click **+ New Session**
2. (Optional) Select a Warehouse
3. (Optional) Enter a description (e.g. "Morning stock count")
4. Click **▶ Start Session**

Or select an existing **Active** session from the dropdown.

### Step 3: Scan barcodes

The barcode input is automatically focused. Simply scan:

```
Scan 1 → ITEM-0001  Qty: 1
Scan 2 → ITEM-0001  Qty: 2
Scan 3 → ITEM-0001  Qty: 3
Scan 4 → ITEM-0002  Qty: 1
...
```

Each successful scan:
- Shows the **Product ID** and **Product Name** in the Last Scanned panel
- Updates the **session summary table** incrementally (no page reload)
- Creates one `Product Scan Log` record with quantity = 1

### Step 4: Complete the session

Click **✓ Complete** when done. The session is closed and no further scans are accepted.

### Scanner input compatibility

| Scanner type | Supported |
|---|---|
| USB barcode scanner (keyboard emulation) | ✅ Full support |
| Bluetooth barcode scanner (HID mode) | ✅ Full support |
| Keyboard wedge scanner | ✅ Full support |
| Manual keyboard entry + Enter | ✅ Supported |
| Camera-based scanning | Via browser camera (future) |

Most hardware scanners send the barcode followed by `Enter`. The input field captures this and triggers the scan automatically.

---

## 4. DocTypes

### Scan Session

Groups all scans performed in a single scanning activity.

| Field | Type | Description |
|---|---|---|
| `name` | Auto | `SESSION-YYYY-#####` (e.g. `SESSION-2026-00001`) |
| `status` | Select | `Draft` / `Active` / `Completed` / `Cancelled` |
| `started_by` | Link (User) | User who started the session |
| `started_at` | Datetime | When the session became Active |
| `ended_at` | Datetime | When the session was Completed or Cancelled |
| `warehouse` | Link (Warehouse) | Optional warehouse for the session |
| `description` | Small Text | Optional label |

**Status lifecycle:**

```
Draft → Active → Completed
           ↓
        Cancelled
```

Completed and Cancelled sessions are immutable.

### Product Scan Log

One row per physical barcode scan. **Quantity is always 1.**

| Field | Type | Description |
|---|---|---|
| `name` | Auto | `SCAN-YYYY-#######` |
| `scan_session` | Link (Scan Session) | Parent session |
| `barcode` | Data | Raw barcode string that was scanned |
| `item_code` | Link (Item) | Resolved ERPNext Item Code |
| `item_name` | Data | Item name (denormalised) |
| `quantity` | Int | Always `1` |
| `scan_timestamp` | Datetime | Exact time of scan |
| `scanned_by` | Link (User) | User who scanned |
| `warehouse` | Link (Warehouse) | Inherited from session |

Totals per product are computed by `SUM(quantity)` and `COUNT(name)` aggregation over the logs for a session.

---

## 5. API Reference

All API methods are whitelisted and callable from any Frappe client or server.

### `scan_product`

Primary scan endpoint. Called once per physical barcode scan.

```python
frappe.call(
    "universal_scanner.api.scanner.scan_product",
    args={
        "barcode": "8901234567890",
        "session": "SESSION-2026-00001",
    }
)
```

**Request:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `barcode` | string | ✅ | Raw barcode from scanner |
| `session` | string | ✅ | Active Scan Session name |

**Success response:**

```json
{
    "success": true,
    "product_id": "ITEM-0001",
    "product_name": "Urea 50 KG",
    "barcode": "8901234567890",
    "uom": "Bag",
    "quantity": 7,
    "scan_count": 7,
    "session": "SESSION-2026-00001"
}
```

**Failure response (unknown barcode):**

```json
{
    "success": false,
    "error": "PRODUCT_NOT_FOUND",
    "message": "No product was found for barcode 8901234567890",
    "barcode": "8901234567890"
}
```

---

### `get_session_summary`

Returns aggregated scan results for a session. Use this to consume scanner data from another app.

```python
frappe.call(
    "universal_scanner.api.scanner.get_session_summary",
    args={"session": "SESSION-2026-00001"}
)
```

**Response:**

```json
{
    "session": "SESSION-2026-00001",
    "products": [
        {
            "product_id": "ITEM-0001",
            "product_name": "Urea 50 KG",
            "barcode": "8901234567890",
            "quantity": 7,
            "scan_count": 7
        },
        {
            "product_id": "ITEM-0002",
            "product_name": "DAP 50 KG",
            "barcode": "8901234567891",
            "quantity": 4,
            "scan_count": 4
        }
    ],
    "total_units": 11
}
```

---

### `start_scan_session`

Creates a new Scan Session and immediately activates it.

```python
frappe.call(
    "universal_scanner.api.scanner.start_scan_session",
    args={
        "warehouse": "Main Warehouse - MG",   # optional
        "description": "Morning stock count", # optional
    }
)
```

**Response:**

```json
{
    "session": "SESSION-2026-00001",
    "status": "Active",
    "started_at": "2026-08-13 06:00:00.000000"
}
```

---

### `complete_scan_session`

Marks a session as Completed. No further scans accepted.

```python
frappe.call(
    "universal_scanner.api.scanner.complete_scan_session",
    args={"session": "SESSION-2026-00001"}
)
```

---

### `cancel_scan_session`

Cancels a session.

```python
frappe.call(
    "universal_scanner.api.scanner.cancel_scan_session",
    args={"session": "SESSION-2026-00001"}
)
```

---

### `get_active_sessions`

Returns all currently Active sessions.

```python
frappe.call("universal_scanner.api.scanner.get_active_sessions")
```

---

## 6. Consuming Scanner Data from Another App

Design pattern for another Frappe app (e.g. `dehaat_procurement`, `blood_bank`, `auto_dealer`) to consume scanner data:

### Server-side (Python)

```python
import frappe

def create_stock_entry_from_session(session_name):
    """
    Example: Consume scanner session data and create a Stock Entry.
    This code lives in the CONSUMING app, not in universal_scanner.
    """
    # Step 1: Get the session summary from the scanner
    summary = frappe.call(
        "universal_scanner.api.scanner.get_session_summary",
        session=session_name
    )
    # Or import directly (server-to-server within the same bench):
    from universal_scanner.api.scanner import get_session_summary
    summary = get_session_summary(session_name)

    # Step 2: Use the data however your app needs
    for product in summary["products"]:
        print(f"{product['product_id']} → {product['quantity']}")
        # e.g. create stock entry line items, purchase receipt items, etc.

    # Step 3: Complete the scanner session when done
    from universal_scanner.api.scanner import complete_scan_session
    complete_scan_session(session_name)
```

### Client-side (JavaScript)

```javascript
// In your consuming app's JS
function processScannedSession(sessionName) {
    frappe.call({
        method: "universal_scanner.api.scanner.get_session_summary",
        args: { session: sessionName },
        callback: function(r) {
            if (r.message) {
                var summary = r.message;
                summary.products.forEach(function(p) {
                    console.log(p.product_id, "→", p.quantity);
                    // Add to your form, create child rows, etc.
                });
            }
        }
    });
}
```

### Example integrations (future — NOT implemented in this app)

| Consuming App | Use Case |
|---|---|
| `dehaat_procurement` | Create Purchase Receipt from scanned GRN |
| `blood_bank` | Record blood bag inventory |
| `auto_dealer` | Count parts in a warehouse audit |
| `salon` | Count product stock |
| `manufacturing` | Record raw material consumption |

---

## 7. Permissions

### Built-in roles

| Role | Create Session | Read Session | Create Scan Log | Read Scan Log | Use Scanner Page |
|---|---|---|---|---|---|
| **Scanner User** | ✅ | ✅ | ✅ (via API) | ✅ | ✅ |
| **System Manager** | ✅ | ✅ | ✅ | ✅ | ✅ |

### Assigning the Scanner User role

1. Go to **Setup → Users**
2. Open the user record
3. Add **Scanner User** in the Roles table
4. Save

### Adding roles to the scanner page

If you need additional roles to access `/app/product-scanner`, edit:

```
universal_scanner/universal_scanner/universal_scanner/page/product_scanner/product_scanner.json
```

Add to the `roles` array:

```json
"roles": [
    { "role": "Scanner User" },
    { "role": "System Manager" },
    { "role": "Warehouse Executive" }
]
```

Then run `bench migrate`.

---

## 8. Configuration

### Default product lookup (ERPNext Item)

The scanner resolves barcodes using `SCANNER_CONFIG` in `universal_scanner/api/scanner.py`:

```python
SCANNER_CONFIG = {
    "product_doctype": "Item",
    "product_id_field": "item_code",
    "product_name_field": "item_name",
    "barcode_doctype": "Item Barcode",
    "barcode_field": "barcode",
    "barcode_parent_field": "parent",
    "uom_field": "stock_uom",
}
```

### Debounce setting

```python
DEBOUNCE_MS = 300  # milliseconds
```

Increase this if your scanner emits multiple events per trigger. Set to `0` to disable.

---

## 9. Extension Points

### Using a different product DocType

Patch `SCANNER_CONFIG` from your consuming app's `hooks.py` or at module import time:

```python
# In your app's hooks.py or a patch file:
from universal_scanner.api import scanner as us

us.SCANNER_CONFIG = {
    "product_doctype": "Blood Product",
    "product_id_field": "blood_product_code",
    "product_name_field": "product_name",
    "barcode_doctype": "Blood Product Barcode",
    "barcode_field": "barcode",
    "barcode_parent_field": "parent",
    "uom_field": "unit",
}
```

### Planned extension points (v2)

| Feature | Description |
|---|---|
| **Scanner Configuration DocType** | UI-based config per site — no code changes needed |
| **Camera scanning** | QuaggaJS / ZXing integration (isolated, optional) |
| **Quantity per scan** | Support scanning quantities > 1 for bulk input |
| **Webhook on complete** | Notify consuming apps when a session completes |
| **Export to CSV** | Export session summary to CSV/Excel |

---

## 10. Testing

### Run all tests

```bash
bench --site your-site.example.com run-tests --app universal_scanner
```

### Run a specific test module

```bash
# Session lifecycle tests
bench --site your-site.example.com run-tests \
    --module universal_scanner.universal_scanner.doctype.scan_session.test_scan_session

# Scanner API + Product Scan Log tests (requires ERPNext)
bench --site your-site.example.com run-tests \
    --module universal_scanner.universal_scanner.doctype.product_scan_log.test_product_scan_log
```

### Test coverage

| Test | Description |
|---|---|
| Session naming | `SESSION-` prefix enforced |
| Session lifecycle | Draft → Active → Completed / Cancelled |
| Session immutability | Completed/Cancelled sessions cannot be changed |
| Auto-timestamps | `started_at` and `ended_at` set automatically |
| Barcode lookup (valid) | Returns correct Item Code and Name |
| Barcode lookup (invalid) | Returns `None`, no exception |
| First scan | Returns quantity=1, scan_count=1 |
| Repeated scans | Returns quantity=N, scan_count=N |
| Individual log records | 3 scans → 3 separate `Product Scan Log` rows |
| Log quantity enforcement | Each row has quantity=1 |
| Unknown barcode | Returns `{success: false, error: "PRODUCT_NOT_FOUND"}` |
| Completed session | Scan raises `ValidationError` |
| Cancelled session | Scan raises `ValidationError` |
| Non-existent session | Raises `DoesNotExistError` |
| Session summary | Correct totals for 3 items (5+3+8=16) |
| Empty session summary | Returns `total_units: 0, products: []` |

---

## 11. Architecture

```
universal_scanner/                      ← Git root
│
├── setup.py / setup.cfg / MANIFEST.in  ← Python packaging
├── requirements.txt                    ← (empty — bench manages deps)
├── license.txt                         ← MIT
├── README.md                           ← This file
│
└── universal_scanner/                  ← Python package
    ├── __init__.py                     ← app version
    ├── hooks.py                        ← Frappe app hooks (no doc_events)
    ├── modules.txt                     ← "Universal Scanner"
    ├── patches.txt
    │
    ├── api/
    │   ├── __init__.py
    │   └── scanner.py                  ← All whitelisted API methods
    │                                     scan_product()
    │                                     get_session_summary()
    │                                     start_scan_session()
    │                                     complete_scan_session()
    │                                     cancel_scan_session()
    │                                     get_active_sessions()
    │
    ├── config/
    │   ├── __init__.py
    │   └── desktop.py                  ← Frappe workspace module icon
    │
    ├── public/                         ← Static assets (none currently)
    │
    └── universal_scanner/              ← Frappe module "Universal Scanner"
        ├── __init__.py
        │
        ├── doctype/
        │   ├── __init__.py
        │   ├── scan_session/
        │   │   ├── scan_session.json   ← DocType definition
        │   │   ├── scan_session.py     ← Controller (lifecycle/validation)
        │   │   └── test_scan_session.py
        │   │
        │   └── product_scan_log/
        │       ├── product_scan_log.json
        │       ├── product_scan_log.py ← Controller (quantity=1 enforced)
        │       └── test_product_scan_log.py
        │
        └── page/
            └── product_scanner/
                ├── product_scanner.json  ← Page definition (/app/product-scanner)
                ├── product_scanner.py    ← Minimal page context
                ├── product_scanner.html  ← Bootstrap container
                └── product_scanner.js   ← Full scanner UI (UniversalScanner class)
```

### Data flow

```
[Hardware Scanner]
        │ USB/Bluetooth/HID
        ↓
[Browser Input Field]  ← auto-focused, Enter-key trigger
        │ frappe.call()
        ↓
[universal_scanner.api.scanner.scan_product()]
        │ validate session
        │ check debounce
        │ find_product_by_barcode()  → Item Barcode → Item
        │ create_scan_log()          → INSERT Product Scan Log (qty=1)
        │ get_product_scan_count()   → SELECT SUM/COUNT
        ↓
[Response: {product_id, product_name, quantity, scan_count}]
        │
        ↓
[Browser UI]
  • Last Scanned panel updated (animated)
  • Session summary row updated in-place
  • Running total updated
  • Input cleared and refocused
  • Ready for next scan
```

---

## 12. License

MIT — see [license.txt](license.txt)

---

*Built as a reusable, independent Frappe application. Zero references to `dehaat_procurement` or any other custom application.*
