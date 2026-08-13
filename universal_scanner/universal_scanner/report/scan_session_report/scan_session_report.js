// Copyright (c) 2026, Universal Scanner Contributors
// License: MIT
// ─────────────────────────────────────────────────────────────────────────────
// Scan Session Report Filters
// ─────────────────────────────────────────────────────────────────────────────

frappe.query_reports["Scan Session Report"] = {
    filters: [
        {
            fieldname: "scan_session",
            label: __("Scan Session"),
            fieldtype: "Link",
            options: "Scan Session",
        },
        {
            fieldname: "status",
            label: __("Status"),
            fieldtype: "Select",
            options: "\nDraft\nActive\nCompleted\nCancelled",
        },
        {
            fieldname: "from_date",
            label: __("From Date"),
            fieldtype: "Date",
        },
        {
            fieldname: "to_date",
            label: __("To Date"),
            fieldtype: "Date",
        },
    ],
};
