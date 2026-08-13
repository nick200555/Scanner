// Copyright (c) 2026, Universal Scanner Contributors
// License: MIT
// ─────────────────────────────────────────────────────────────────────────────
// Product Scanner Page — Universal Scanner Frappe App
//
// Architecture:
//   • UniversalScanner class owns all state and DOM mutations
//   • frappe.call() for every API request (no direct DB access from JS)
//   • Session summary table updates only the affected row, not full reload
//   • Barcode input stays focused at all times for continuous scanning
//   • CSS is injected via a <style> tag to avoid build-step dependency
// ─────────────────────────────────────────────────────────────────────────────

frappe.pages['product-scanner'].on_page_load = function (wrapper) {
    var page = frappe.ui.make_app_page({
        parent: wrapper,
        title: __('Universal Product Scanner'),
        single_column: true,
    });

    var scanner = new UniversalScanner(page, wrapper);
    scanner.init();

    // Store reference for on_page_show
    wrapper._us_scanner = scanner;
};

frappe.pages['product-scanner'].on_page_show = function (wrapper) {
    if (wrapper._us_scanner) {
        wrapper._us_scanner.focusInput();
    }
};

frappe.pages['product-scanner'].on_page_hide = function (wrapper) {
    if (wrapper._us_scanner) {
        wrapper._us_scanner._stopCamera();
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// UniversalScanner — Main controller class
// ─────────────────────────────────────────────────────────────────────────────

var UniversalScanner = function (page, wrapper) {
    this.page = page;
    this.wrapper = wrapper;

    // Application state
    this.state = {
        session: null,            // Current Scan Session name (e.g. "SESSION-2026-00001")
        sessionStatus: null,      // "Active" | "Draft" | "Completed" | "Cancelled" | null
        sessionWarehouse: '',     // Warehouse inherited from session
        sessionData: {},          // item_code → {item_name, barcode, quantity, scan_count}
        totalUnits: 0,            // Running total for the current session
        lastScanTs: 0,            // JS-side debounce timestamp (Date.now())
        debounceMs: 300,          // Match server-side DEBOUNCE_MS
        isProcessing: false,      // Prevents overlapping scan requests
        cameraActive: false,      // Camera scanner active flag
        cameraStream: null,       // MediaStream from getUserMedia
        html5Qrcode: null,        // Html5Qrcode instance (legacy — kept for scanFile fallback)
        lastScannedBarcode: null, // Last successfully decoded EAN (for per-barcode debounce)
    };
};

UniversalScanner.prototype = {

    // ─── Entry Point ─────────────────────────────────────────────────────────

    init: function () {
        this._injectStyles();
        this._buildUI();
        this._bindEvents();
        this._setupBarcodeInput();
        this._setupPageButtons();
        this._loadActiveSessions();
    },

    // ─── CSS Injection ────────────────────────────────────────────────────────

    _injectStyles: function () {
        if (document.getElementById('us-styles')) return;

        var css = '\
/* ═══════════════════════════════════════════════════════════════════════════\
   Universal Scanner — Embedded Stylesheet\
   ═══════════════════════════════════════════════════════════════════════════ */\
\
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap");\
\
.us-wrap {\
    max-width: 1080px;\
    margin: 0 auto;\
    padding: 8px 20px 48px;\
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;\
}\
\
/* ── Header ── */\
.us-header {\
    display: flex;\
    align-items: center;\
    justify-content: space-between;\
    padding: 18px 0 20px;\
    margin-bottom: 20px;\
    border-bottom: 2px solid var(--border-color);\
}\
.us-header-left { display: flex; align-items: center; gap: 14px; }\
.us-brand-icon {\
    width: 48px; height: 48px;\
    background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);\
    border-radius: 14px;\
    display: flex; align-items: center; justify-content: center;\
    font-size: 24px;\
    box-shadow: 0 6px 20px rgba(99,102,241,0.35);\
    flex-shrink: 0;\
}\
.us-brand-title { margin: 0; font-size: 21px; font-weight: 800; color: var(--heading-color); letter-spacing: -0.4px; }\
.us-brand-sub { font-size: 13px; color: var(--text-muted); margin: 2px 0 0; }\
.us-user-chip {\
    display: flex; align-items: center; gap: 7px;\
    background: var(--control-bg);\
    border: 1px solid var(--border-color);\
    border-radius: 20px;\
    padding: 6px 14px;\
    font-size: 13px;\
    color: var(--text-muted);\
}\
\
/* ── Section label ── */\
.us-section-lbl {\
    font-size: 10px;\
    font-weight: 700;\
    text-transform: uppercase;\
    letter-spacing: 1.2px;\
    color: var(--text-muted);\
    margin-bottom: 10px;\
}\
\
/* ── Card ── */\
.us-card {\
    background: var(--card-bg);\
    border: 1.5px solid var(--border-color);\
    border-radius: 16px;\
    padding: 20px;\
    margin-bottom: 18px;\
}\
\
/* ── Session Panel ── */\
.us-session-grid {\
    display: grid;\
    grid-template-columns: 1fr auto;\
    gap: 20px;\
    align-items: start;\
}\
.us-session-fields { display: flex; flex-direction: column; gap: 14px; }\
.us-field-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }\
.us-field-lbl { font-size: 12px; font-weight: 600; color: var(--text-muted); min-width: 80px; flex-shrink: 0; }\
\
#us-session-select {\
    flex: 1; min-width: 200px; max-width: 360px;\
    border: 1.5px solid var(--border-color);\
    border-radius: 8px;\
    padding: 7px 10px;\
    font-size: 14px;\
    font-family: inherit;\
    background: var(--control-bg);\
    color: var(--text-color);\
    cursor: pointer;\
    transition: border-color 0.2s, box-shadow 0.2s;\
}\
#us-session-select:focus {\
    border-color: #6366f1;\
    outline: none;\
    box-shadow: 0 0 0 3px rgba(99,102,241,0.14);\
}\
\
/* Status badge */\
.us-badge {\
    display: inline-flex; align-items: center; gap: 6px;\
    font-size: 11px; font-weight: 700;\
    text-transform: uppercase; letter-spacing: 0.5px;\
    padding: 4px 12px; border-radius: 20px;\
}\
.us-badge-dot {\
    width: 6px; height: 6px; border-radius: 50%; background: currentColor;\
}\
.us-badge-active   { color: #10b981; background: rgba(16,185,129,.12); border: 1px solid rgba(16,185,129,.25); }\
.us-badge-active .us-badge-dot { animation: us-pulse 1.8s infinite; }\
.us-badge-draft    { color: #f59e0b; background: rgba(245,158,11,.12); border: 1px solid rgba(245,158,11,.25); }\
.us-badge-completed{ color: #6b7280; background: rgba(107,114,128,.12); border: 1px solid rgba(107,114,128,.2); }\
.us-badge-cancelled{ color: #ef4444; background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.25); }\
.us-badge-none     { color: var(--text-muted); background: var(--control-bg); border: 1px solid var(--border-color); }\
\
.us-wh-val { font-size: 13px; font-weight: 600; color: var(--text-color); }\
\
/* Session action buttons */\
.us-session-btns { display: flex; flex-direction: column; gap: 8px; }\
.us-btn {\
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;\
    padding: 9px 18px;\
    border-radius: 9px;\
    font-size: 13px; font-weight: 600;\
    font-family: inherit;\
    cursor: pointer;\
    border: none;\
    white-space: nowrap;\
    transition: transform 0.15s, box-shadow 0.15s, background 0.15s;\
    line-height: 1;\
}\
.us-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none !important; box-shadow: none !important; }\
.us-btn-primary  { background: #6366f1; color: #fff; }\
.us-btn-primary:not(:disabled):hover  { background: #4f46e5; transform: translateY(-1px); box-shadow: 0 5px 15px rgba(99,102,241,.3); }\
.us-btn-success  { background: #10b981; color: #fff; }\
.us-btn-success:not(:disabled):hover  { background: #059669; transform: translateY(-1px); box-shadow: 0 5px 15px rgba(16,185,129,.3); }\
.us-btn-danger   { background: transparent; color: #ef4444; border: 1.5px solid #ef4444; }\
.us-btn-danger:not(:disabled):hover   { background: rgba(239,68,68,.07); }\
\
/* ── Scanner Panel ── */\
.us-scan-card {\
    border: 2px solid var(--border-color);\
    border-radius: 16px;\
    padding: 22px;\
    margin-bottom: 18px;\
    background: var(--card-bg);\
    transition: border-color 0.25s;\
}\
.us-scan-card.us--scanning { border-color: #6366f1; }\
.us-scan-card.us--success  { border-color: #10b981; }\
.us-scan-card.us--error    { border-color: #ef4444; animation: us-shake 0.4s; }\
\
.us-input-wrapper {\
    display: flex; align-items: center; gap: 12px;\
    background: var(--control-bg);\
    border: 1.5px solid var(--border-color);\
    border-radius: 12px;\
    padding: 13px 16px;\
    cursor: text;\
    transition: border-color 0.2s, background 0.2s, box-shadow 0.2s;\
}\
.us-input-wrapper:focus-within {\
    border-color: #6366f1;\
    background: var(--card-bg);\
    box-shadow: 0 0 0 4px rgba(99,102,241,.1);\
}\
.us-input-icon { font-size: 22px; flex-shrink: 0; opacity: 0.45; transition: opacity 0.2s; }\
.us-input-wrapper:focus-within .us-input-icon { opacity: 1; }\
\
#us-barcode-input {\
    flex: 1;\
    border: none; outline: none;\
    background: transparent;\
    font-size: 18px; font-weight: 700;\
    font-family: inherit;\
    color: var(--text-color);\
    letter-spacing: 1.5px;\
    caret-color: #6366f1;\
}\
#us-barcode-input::placeholder {\
    font-size: 15px; font-weight: 400; letter-spacing: 0;\
    color: var(--text-muted); opacity: 0.65;\
}\
\
.us-scan-dot {\
    width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;\
    background: #10b981;\
    animation: us-pulse 2s infinite;\
    transition: background 0.25s;\
}\
.us-scan-dot.us--busy {\
    background: #6366f1; border-radius: 2px;\
    animation: us-spin 0.7s linear infinite;\
}\
.us-scan-dot.us--err { background: #ef4444; animation: none; }\
\
.us-camera-header {\
    display: flex;\
    align-items: center;\
    justify-content: space-between;\
    margin-bottom: 12px;\
}\
.us-cam-btn {\
    background: #6366f1; color: #fff;\
    border: none; border-radius: 8px;\
    padding: 7px 14px; font-size: 12px; font-weight: 700;\
    cursor: pointer;\
    display: inline-flex; align-items: center; gap: 6px;\
    transition: background 0.2s, transform 0.15s;\
}\
.us-cam-btn:hover { background: #4f46e5; transform: translateY(-1px); }\
.us-cam-btn.us-cam-stop { background: #ef4444; }\
.us-cam-btn.us-cam-stop:hover { background: #dc2626; }\
\
/* ── Camera Preview Wrapper ── */\
.us-camera-wrapper {\
    margin-bottom: 14px;\
    border-radius: 12px;\
    overflow: hidden;\
    border: 2px solid #6366f1;\
    background: #000;\
    max-width: 500px;\
    margin-left: auto;\
    margin-right: auto;\
}\
/* Live video element */\
#us-camera-video {\
    width: 100%;\
    display: block;\
    min-height: 240px;\
    object-fit: cover;\
    border-radius: 10px 10px 0 0;\
}\
/* Aiming overlay drawn on top of video */\
.us-cam-overlay {\
    position: relative;\
    background: #000;\
}\
.us-cam-overlay::after {\
    content: "";\
    position: absolute;\
    top: 50%; left: 50%;\
    transform: translate(-50%, -50%);\
    width: 70%; height: 38%;\
    border: 2.5px solid rgba(99,102,241,0.8);\
    border-radius: 6px;\
    box-shadow: 0 0 0 9999px rgba(0,0,0,0.35);\
    pointer-events: none;\
}\
/* Hidden canvas used for frame capture */\
#us-capture-canvas { display: none; }\
/* Camera action buttons row */\
.us-cam-actions {\
    display: flex;\
    gap: 10px;\
    justify-content: center;\
    padding: 12px;\
    background: rgba(0,0,0,0.7);\
    border-radius: 0 0 10px 10px;\
}\
/* Capture button — prominent */\
#us-capture-btn {\
    flex: 1;\
    max-width: 260px;\
    background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);\
    color: #fff;\
    border: none; border-radius: 10px;\
    padding: 13px 20px;\
    font-size: 15px; font-weight: 800;\
    cursor: pointer;\
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;\
    letter-spacing: 0.3px;\
    transition: background 0.2s, transform 0.12s, box-shadow 0.2s;\
    box-shadow: 0 4px 16px rgba(99,102,241,0.45);\
}\
#us-capture-btn:hover { background: linear-gradient(135deg,#4f46e5,#3730a3); transform: translateY(-1px); box-shadow: 0 6px 22px rgba(99,102,241,0.55); }\
#us-capture-btn:active { transform: translateY(1px); box-shadow: none; }\
#us-capture-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }\
/* Stop camera button inside preview */\
#us-stop-cam-btn {\
    background: transparent;\
    color: #ef4444;\
    border: 1.5px solid #ef4444;\
    border-radius: 10px;\
    padding: 13px 18px;\
    font-size: 13px; font-weight: 700;\
    cursor: pointer;\
    display: inline-flex; align-items: center; gap: 6px;\
    transition: background 0.15s;\
    white-space: nowrap;\
}\
#us-stop-cam-btn:hover { background: rgba(239,68,68,0.1); }\
/* Camera decode status line */\
#us-cam-status {\
    font-size: 12px; font-weight: 600;\
    color: rgba(255,255,255,0.75);\
    text-align: center;\
    padding: 5px 12px 0;\
    background: rgba(0,0,0,0.7);\
    min-height: 26px;\
    letter-spacing: 0.2px;\
}\
\
/* ── Camera debug preview panel ── */\
#us-debug-panel {\
    background: rgba(0,0,0,0.85);\
    border-radius: 0 0 10px 10px;\
    padding: 10px 12px;\
    border-top: 1px solid rgba(255,255,255,0.1);\
    font-size: 11px; font-family: monospace;\
    color: rgba(255,255,255,0.8);\
    display: none;\
}\
#us-debug-panel.us-dbg-visible { display: block; }\
.us-dbg-title {\
    font-size: 10px; font-weight: 700; text-transform: uppercase;\
    letter-spacing: 1px; color: rgba(99,102,241,0.9); margin-bottom: 6px;\
}\
.us-dbg-stage { margin: 2px 0; }\
.us-dbg-ok   { color: #10b981; }\
.us-dbg-fail { color: #ef4444; }\
.us-dbg-info { color: rgba(255,255,255,0.6); }\
.us-dbg-imgs {\
    display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap;\
}\
.us-dbg-img-wrap {\
    display: flex; flex-direction: column; align-items: center; gap: 3px;\
}\
.us-dbg-img-wrap img {\
    border: 1px solid rgba(255,255,255,0.2);\
    border-radius: 4px; max-height: 80px; max-width: 120px;\
    object-fit: contain; background: #000;\
}\
.us-dbg-img-label { font-size: 9px; color: rgba(255,255,255,0.5); }\
.us-feedback {\
    margin-top: 12px; min-height: 28px;\
    display: flex; align-items: center; gap: 8px;\
    font-size: 13px; border-radius: 8px; padding: 6px 10px;\
    transition: all 0.25s;\
}\
.us-fb-idle     { color: var(--text-muted); }\
.us-fb-scanning { color: #6366f1; background: rgba(99,102,241,.07); }\
.us-fb-success  { color: #10b981; background: rgba(16,185,129,.07); }\
.us-fb-error    { color: #ef4444; background: rgba(239,68,68,.07); }\
.us-fb-warn     { color: #f59e0b; background: rgba(245,158,11,.07); }\
\
/* ── Last Scanned ── */\
.us-last-card {\
    border: 1.5px solid var(--border-color);\
    border-radius: 16px;\
    overflow: hidden;\
    margin-bottom: 18px;\
    background: var(--card-bg);\
}\
.us-last-header {\
    display: flex; align-items: center; justify-content: space-between;\
    padding: 13px 18px;\
    border-bottom: 1px solid var(--border-color);\
}\
.us-last-header-ok  { background: linear-gradient(90deg, rgba(16,185,129,.07), transparent); }\
.us-last-header-err { background: linear-gradient(90deg, rgba(239,68,68,.07), transparent); }\
\
.us-scan-ok-label {\
    display: flex; align-items: center; gap: 8px;\
    font-size: 12px; font-weight: 800;\
    text-transform: uppercase; letter-spacing: 0.7px;\
    color: #10b981;\
}\
.us-scan-ok-label::before {\
    content: "✓"; width: 20px; height: 20px;\
    background: #10b981; color: #fff;\
    border-radius: 50%; display: flex; align-items: center; justify-content: center;\
    font-size: 11px; font-weight: 900;\
}\
.us-scan-err-label {\
    display: flex; align-items: center; gap: 8px;\
    font-size: 12px; font-weight: 800;\
    text-transform: uppercase; letter-spacing: 0.7px;\
    color: #ef4444;\
}\
.us-scan-err-label::before {\
    content: "✗"; width: 20px; height: 20px;\
    background: #ef4444; color: #fff;\
    border-radius: 50%; display: flex; align-items: center; justify-content: center;\
    font-size: 12px; font-weight: 900;\
}\
.us-scan-ts { font-size: 11px; color: var(--text-muted); font-family: monospace; }\
\
.us-last-body {\
    display: grid;\
    grid-template-columns: repeat(4, 1fr);\
    gap: 0;\
    padding: 0;\
}\
@media (max-width: 800px) {\
    .us-last-body { grid-template-columns: repeat(2, 1fr); }\
}\
.us-field {\
    padding: 16px 18px;\
    border-right: 1px solid var(--border-color);\
}\
.us-field:last-child { border-right: none; }\
.us-field-label {\
    font-size: 10px; font-weight: 700;\
    text-transform: uppercase; letter-spacing: 1px;\
    color: var(--text-muted); margin-bottom: 6px; display: block;\
}\
.us-field-val { font-size: 15px; font-weight: 600; color: var(--text-color); word-break: break-all; }\
.us-field-qty .us-field-val {\
    font-size: 42px; font-weight: 900;\
    color: #6366f1; line-height: 1;\
    font-variant-numeric: tabular-nums;\
}\
.us-qty-pop { animation: us-qty-pop 0.35s cubic-bezier(0.68,-0.55,0.265,1.55); }\
\
/* ── Session Summary Table ── */\
.us-table-card {\
    border: 1.5px solid var(--border-color);\
    border-radius: 16px;\
    overflow: hidden;\
    margin-bottom: 18px;\
    background: var(--card-bg);\
}\
.us-table-header {\
    display: flex; align-items: center; justify-content: space-between;\
    padding: 14px 18px;\
    border-bottom: 1px solid var(--border-color);\
    background: var(--subtle-bg, var(--control-bg));\
}\
.us-table-title {\
    margin: 0;\
    font-size: 12px; font-weight: 800;\
    text-transform: uppercase; letter-spacing: 0.9px;\
    color: var(--heading-color);\
}\
.us-total-chip {\
    font-size: 13px; font-weight: 800;\
    color: #6366f1;\
    background: rgba(99,102,241,.1);\
    border: 1px solid rgba(99,102,241,.2);\
    border-radius: 20px;\
    padding: 4px 14px;\
    font-variant-numeric: tabular-nums;\
    transition: all 0.3s;\
}\
.us-tbl {\
    width: 100%; border-collapse: collapse;\
    font-size: 14px;\
}\
.us-tbl th {\
    text-align: left;\
    font-size: 10px; font-weight: 700;\
    text-transform: uppercase; letter-spacing: 1px;\
    color: var(--text-muted);\
    padding: 9px 16px;\
    border-bottom: 1px solid var(--border-color);\
    background: var(--subtle-bg, var(--control-bg));\
}\
.us-tbl th.r { text-align: right; }\
.us-tbl td {\
    padding: 12px 16px;\
    border-bottom: 1px solid var(--border-color);\
    color: var(--text-color);\
    vertical-align: middle;\
    transition: background 0.2s;\
}\
.us-tbl tr:last-child td { border-bottom: none; }\
.us-tbl tbody tr:hover td { background: var(--control-bg); }\
.us-td-code { font-weight: 700; font-family: monospace; font-size: 13px; }\
.us-td-bc   { font-family: monospace; font-size: 11px; color: var(--text-muted); }\
.us-td-qty  { font-size: 20px; font-weight: 900; color: #6366f1; text-align: right; font-variant-numeric: tabular-nums; }\
.us-td-scans{ text-align: right; color: var(--text-muted); font-size: 13px; }\
\
.us-row-flash td { animation: us-row-flash 0.6s ease-out; }\
\
.us-empty {\
    text-align: center; padding: 36px 16px;\
    color: var(--text-muted);\
}\
.us-empty-icon { font-size: 36px; margin-bottom: 10px; opacity: 0.3; }\
.us-empty-msg  { font-size: 14px; }\
\
/* ── Spinner ── */\
.us-spinner {\
    display: inline-block;\
    width: 13px; height: 13px;\
    border: 2px solid currentColor;\
    border-top-color: transparent;\
    border-radius: 50%;\
    animation: us-spin 0.65s linear infinite;\
}\
\
/* ── Animations ── */\
@keyframes us-pulse {\
    0%,100% { opacity: 1; }\
    50%      { opacity: 0.35; }\
}\
@keyframes us-spin  { to { transform: rotate(360deg); } }\
@keyframes us-shake {\
    0%,100% { transform: translateX(0); }\
    20%     { transform: translateX(-7px); }\
    40%     { transform: translateX(7px); }\
    60%     { transform: translateX(-4px); }\
    80%     { transform: translateX(4px); }\
}\
@keyframes us-slide-in {\
    from { opacity: 0; transform: translateY(-10px); }\
    to   { opacity: 1; transform: translateY(0); }\
}\
@keyframes us-qty-pop {\
    0%   { transform: scale(1); }\
    50%  { transform: scale(1.35); }\
    100% { transform: scale(1); }\
}\
@keyframes us-row-flash {\
    0%   { background: rgba(99,102,241,.2); }\
    100% { background: transparent; }\
}\
.us-animate { animation: us-slide-in 0.3s ease-out; }\
';

        var s = document.createElement('style');
        s.id = 'us-styles';
        s.textContent = css;
        document.head.appendChild(s);
    },

    // ─── Build DOM ────────────────────────────────────────────────────────────

    _buildUI: function () {
        var self = this;
        var $body = $(this.wrapper).find('.page-content');
        $body.empty();

        var userName = frappe.session.user_fullname || frappe.session.user;

        $body.html(
            '<div class="us-wrap">' +

            /* Header */
            '<div class="us-header">' +
              '<div class="us-header-left">' +
                '<div class="us-brand-icon">📦</div>' +
                '<div>' +
                  '<p class="us-brand-title">Universal Product Scanner</p>' +
                  '<p class="us-brand-sub">Scan barcodes to record inventory counts</p>' +
                '</div>' +
              '</div>' +
              '<div class="us-user-chip">👤&nbsp;' + frappe.utils.escape_html(userName) + '</div>' +
            '</div>' +

            /* Session panel */
            '<div class="us-card">' +
              '<div class="us-section-lbl">Scan Session</div>' +
              '<div class="us-session-grid">' +
                '<div class="us-session-fields">' +
                  '<div class="us-field-row">' +
                    '<span class="us-field-lbl">Session</span>' +
                    '<select id="us-session-select">' +
                      '<option value="">— Select or create a session —</option>' +
                    '</select>' +
                    '<span id="us-status-badge" class="us-badge us-badge-none">' +
                      '<span class="us-badge-dot"></span>No Session' +
                    '</span>' +
                  '</div>' +
                  '<div class="us-field-row" id="us-wh-row" style="display:none">' +
                    '<span class="us-field-lbl">Warehouse</span>' +
                    '<span class="us-wh-val" id="us-wh-val"></span>' +
                  '</div>' +
                '</div>' +
                '<div class="us-session-btns">' +
                  '<button id="us-new-btn"      class="us-btn us-btn-primary">＋ New Session</button>' +
                  '<button id="us-complete-btn" class="us-btn us-btn-success" disabled>✓ Complete</button>' +
                  '<button id="us-cancel-btn"   class="us-btn us-btn-danger"  disabled>✗ Cancel</button>' +
                '</div>' +
              '</div>' +
            '</div>' +

            /* Barcode scanner */
            '<div class="us-scan-card" id="us-scan-card">' +
              '<div class="us-camera-header">' +
                '<div class="us-section-lbl" style="margin-bottom:0">Barcode Scanner</div>' +
                '<button id="us-cam-btn" class="us-cam-btn">📷 Start Camera</button>' +
              '</div>' +

              /* Camera preview — shown only when camera is active */
              '<div id="us-camera-wrapper" class="us-camera-wrapper" style="display:none">' +
                '<div class="us-cam-overlay">' +
                  /* Live video stream */
                  '<video id="us-camera-video" autoplay playsinline muted></video>' +
                '</div>' +
                /* Camera status text */
                '<div id="us-cam-status">🎯 Position EAN barcode inside the frame, then tap Capture</div>' +
                /* Action buttons row */
                '<div class="us-cam-actions">' +
                  '<button id="us-capture-btn">📷 CAPTURE &amp; SCAN EAN</button>' +
                  '<button id="us-stop-cam-btn">⏹ Stop Camera</button>' +
                '</div>' +
                /* Hidden canvas for frame grabbing */
                '<canvas id="us-capture-canvas"></canvas>' +
                /* Debug preview panel — shows captured/cropped frames + stage log */
                '<div id="us-debug-panel">' +
                  '<div class="us-dbg-title">📋 Decode Debug <button id="us-file-test-btn" style="float:right;font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.3);background:rgba(99,102,241,0.4);color:#fff;cursor:pointer;">📁 Test Static Image</button></div>' +
                  '<input type="file" id="us-test-file-input" accept="image/*" style="display:none" />' +
                  '<div id="us-dbg-stages"></div>' +
                  '<div class="us-dbg-imgs" id="us-dbg-imgs"></div>' +
                '</div>' +
              '</div>' +

              '<div class="us-input-wrapper" id="us-input-wrapper">' +
                '<span class="us-input-icon">🔍</span>' +
                '<input type="text" id="us-barcode-input"' +
                       ' placeholder="Scan barcode here…"' +
                       ' autocomplete="off" autocorrect="off"' +
                       ' autocapitalize="off" spellcheck="false" />' +
                '<span class="us-scan-dot" id="us-scan-dot"></span>' +
              '</div>' +
              '<div class="us-feedback us-fb-idle" id="us-feedback">' +
                '● Ready — focus input, scan with camera, or type barcode' +
              '</div>' +
            '</div>' +

            /* Last scanned product */
            '<div id="us-last-card" class="us-last-card" style="display:none">' +
              '<div class="us-last-header us-last-header-ok" id="us-last-header">' +
                '<span id="us-last-status" class="us-scan-ok-label">Product Scanned</span>' +
                '<span id="us-last-ts" class="us-scan-ts"></span>' +
              '</div>' +
              '<div class="us-last-body">' +
                '<div class="us-field">' +
                  '<span class="us-field-label">Product ID</span>' +
                  '<div class="us-field-val" id="us-last-code">—</div>' +
                '</div>' +
                '<div class="us-field">' +
                  '<span class="us-field-label">Product Name</span>' +
                  '<div class="us-field-val" id="us-last-name">—</div>' +
                '</div>' +
                '<div class="us-field">' +
                  '<span class="us-field-label">Barcode</span>' +
                  '<div class="us-field-val" id="us-last-bc">—</div>' +
                '</div>' +
                '<div class="us-field us-field-qty">' +
                  '<span class="us-field-label">Qty in Session</span>' +
                  '<div class="us-field-val" id="us-last-qty">0</div>' +
                '</div>' +
              '</div>' +
            '</div>' +

            /* Session summary table */
            '<div class="us-table-card">' +
              '<div class="us-table-header">' +
                '<h3 class="us-table-title">📋 Current Session</h3>' +
                '<span class="us-total-chip" id="us-total-chip">Total: 0 units</span>' +
              '</div>' +
              '<table class="us-tbl">' +
                '<thead><tr>' +
                  '<th>Product ID</th>' +
                  '<th>Product Name</th>' +
                  '<th>Barcode</th>' +
                  '<th class="r">Qty</th>' +
                  '<th class="r">Scans</th>' +
                '</tr></thead>' +
                '<tbody id="us-tbody">' +
                  '<tr><td colspan="5">' +
                    '<div class="us-empty">' +
                      '<div class="us-empty-icon">📭</div>' +
                      '<div class="us-empty-msg">No products scanned yet.<br>Select a session and start scanning.</div>' +
                    '</div>' +
                  '</td></tr>' +
                '</tbody>' +
              '</table>' +
            '</div>' +

            '</div>' // .us-wrap
        );
    },

    // ─── Event Binding ────────────────────────────────────────────────────────

    _bindEvents: function () {
        var self = this;

        $('#us-session-select').on('change', function () {
            self._onSessionChange($(this).val());
        });

        $('#us-new-btn').on('click', function () {
            self._showNewSessionDialog();
        });

        $('#us-complete-btn').on('click', function () {
            self._confirmCompleteSession();
        });

        $('#us-cancel-btn').on('click', function () {
            self._confirmCancelSession();
        });

        $('#us-cam-btn').on('click', function () {
            self._toggleCamera();
        });

        $('#us-capture-btn').on('click', function () {
            self._captureAndScan();
        });

        $('#us-stop-cam-btn').on('click', function () {
            self._stopCamera();
        });

        $('#us-file-test-btn').on('click', function (e) {
            e.stopPropagation();
            $('#us-test-file-input').click();
        });

        $('#us-test-file-input').on('change', function (e) {
            var file = e.target.files && e.target.files[0];
            if (file) {
                self._runStaticImageTest(file);
            }
        });

        // Click on wrapper → focus input
        $('#us-input-wrapper').on('click', function () {
            $('#us-barcode-input').focus();
        });
    },

    // ─── Barcode Input ────────────────────────────────────────────────────────

    _setupBarcodeInput: function () {
        var self = this;
        var $input = $('#us-barcode-input');

        // Enter key → fire scan
        $input.on('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                var val = $(this).val().trim();
                if (val) {
                    $(this).val('');
                    self._handleScan(val);
                }
            }
        });

        // Passive focus trap: any keypress not in a form element focuses input
        $(document).on('keydown.us_scanner', function (e) {
            var tag = (e.target.tagName || '').toLowerCase();
            if (['input', 'textarea', 'select', 'button'].indexOf(tag) === -1) {
                if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                    $input.focus();
                }
            }
        });

        this.focusInput();
    },

    focusInput: function () {
        setTimeout(function () {
            var el = document.getElementById('us-barcode-input');
            if (el) el.focus();
        }, 200);
    },

    // ─── Camera Barcode Scanner ───────────────────────────────────────────────
    //
    // Decoding library: ZXing-js  (@zxing/library UMD, via unpkg CDN)
    //   - Reliable EAN-13 / EAN-8 decoding from canvas/image elements
    //   - Fallback to html5-qrcode scanFile() when ZXing fails
    //
    // Three-pass decode strategy:
    //   Pass 1  — full captured video frame
    //   Pass 2  — cropped scan-box region (correctly scaled from display→video px)
    //   Pass 3  — 3× upscaled crop (improves success on small barcodes)
    //
    // Debug panel shows:
    //   - Per-stage status log
    //   - Thumbnail of the captured frame
    //   - Thumbnail of the cropped region
    // ──────────────────────────────────────────────────────────────────────────

    _toggleCamera: function () {
        if (this.state.cameraActive) {
            this._stopCamera();
        } else {
            this._startCamera();
        }
    },

    // Load ZXing-js from CDN (primary decoder, best EAN-13/8 support)
    _loadZxing: function (callback) {
        if (window.ZXing) { callback(null); return; }
        var s = document.createElement('script');
        s.src = 'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js';
        s.onload  = function () { callback(null); };
        s.onerror = function () { callback(new Error('ZXing CDN failed')); };
        document.head.appendChild(s);
    },

    // Load html5-qrcode as secondary fallback
    _loadHtml5QrcodeLibrary: function (callback) {
        if (window.Html5Qrcode) { callback(); return; }
        var s = document.createElement('script');
        s.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
        s.onload  = callback;
        s.onerror = callback; // continue even if it fails
        document.head.appendChild(s);
    },

    _startCamera: function () {
        var self = this;

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            frappe.msgprint(__('Camera not supported. Use Chrome on Android or desktop.'));
            return;
        }

        // Request high resolution for accurate barcode decoding
        var constraints = {
            video: {
                facingMode: { ideal: 'environment' },
                width:  { ideal: 1920 },
                height: { ideal: 1080 }
            },
            audio: false
        };

        navigator.mediaDevices.getUserMedia(constraints)
            .then(function (stream) {
                self.state.cameraActive = true;
                self.state.cameraStream = stream;

                var video = document.getElementById('us-camera-video');
                video.srcObject = stream;
                video.play().then(function () {
                    // Log actual camera resolution
                    var track = stream.getVideoTracks()[0];
                    if (track) {
                        var s = track.getSettings();
                        console.log('[Camera] track settings:', s);
                        console.log('[Camera] video dimensions:', video.videoWidth, 'x', video.videoHeight);
                    }
                }).catch(function () {});

                $('#us-camera-wrapper').show();
                $('#us-cam-btn').addClass('us-cam-stop').html('📷 Camera Active');
                $('#us-capture-btn').prop('disabled', false);
                $('#us-cam-status').text('🎯 Position EAN barcode inside the frame, then tap Capture');
                $('#us-debug-panel').removeClass('us-dbg-visible');

                // Pre-load both decoders
                self._loadZxing(function () {});
                self._loadHtml5QrcodeLibrary(function () {});
            })
            .catch(function (err) {
                var msg = (err && (err.message || String(err))) || 'Permission denied';
                frappe.msgprint(__('Camera error: {0}. Grant camera permission and try again.', [msg]));
            });
    },

    // ────────────────────────────────────────────────────────────────
    // _captureAndScan: main entry point
    // Stages 1–9 are logged to the debug panel.
    // ────────────────────────────────────────────────────────────────
    _captureAndScan: function () {
        var self = this;

        if (!this.state.cameraActive || !this.state.cameraStream) {
            frappe.msgprint(__('Camera is not active. Click "📷 Start Camera" first.'));
            return;
        }
        if (this.state.isProcessing) { return; }

        // ── Reset debug panel
        $('#us-dbg-stages').html('');
        $('#us-dbg-imgs').html('');
        $('#us-debug-panel').addClass('us-dbg-visible');
        $('#us-capture-btn').prop('disabled', true);
        $('#us-cam-status').text('⏳ Capturing frame…');

        var video  = document.getElementById('us-camera-video');
        var canvas = document.getElementById('us-capture-canvas');

        // ── STAGE 1: Capture video frame ──────────────────────────────────────────
        var vw = video.videoWidth;
        var vh = video.videoHeight;
        self._dbgStage(1, 'Camera frame captured', 'info',
            'video.videoWidth=' + vw + ' video.videoHeight=' + vh +
            ' | display=' + video.clientWidth + 'x' + video.clientHeight);

        if (!vw || !vh) {
            self._dbgStage(1, 'FAIL — video dimensions are 0. Camera not ready.', 'fail');
            self._captureReset('Camera not ready. Wait for the preview to load fully.');
            return;
        }

        // Draw full video frame to canvas at native resolution
        canvas.width  = vw;
        canvas.height = vh;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, vw, vh);

        // ── STAGE 2: Captured frame dimensions
        self._dbgStage(2, 'Canvas drawn — ' + canvas.width + 'x' + canvas.height + ' px', 'ok');

        // Show thumbnail of the captured frame
        self._dbgAddImage(canvas, 'Full frame');

        // ── Compute cropped scan-box region in VIDEO pixel coordinates ────────
        //
        // The .us-cam-overlay::after pseudo-element creates a centred rectangle
        //   70% wide × 38% tall of the DISPLAYED overlay element.
        // We must scale from display→video pixels:
        //   scaleX = videoWidth  / displayedWidth
        //   scaleY = videoHeight / displayedHeight
        //
        var overlay   = document.querySelector('.us-cam-overlay');
        var dispW     = overlay ? overlay.clientWidth  : video.clientWidth;
        var dispH     = overlay ? overlay.clientHeight : video.clientHeight;
        var scaleX    = vw / dispW;
        var scaleY    = vh / dispH;

        var boxW_disp = dispW * 0.70;
        var boxH_disp = dispH * 0.38;
        var boxX_disp = (dispW - boxW_disp) / 2;
        var boxY_disp = (dispH - boxH_disp) / 2;

        // Convert to video pixel coordinates
        var cropX = Math.round(boxX_disp * scaleX);
        var cropY = Math.round(boxY_disp * scaleY);
        var cropW = Math.round(boxW_disp * scaleX);
        var cropH = Math.round(boxH_disp * scaleY);

        // Safety: clamp to canvas bounds
        cropX = Math.max(0, Math.min(cropX, vw - 1));
        cropY = Math.max(0, Math.min(cropY, vh - 1));
        cropW = Math.min(cropW, vw - cropX);
        cropH = Math.min(cropH, vh - cropY);

        // ── STAGE 3: Scan region cropped
        self._dbgStage(3,
            'Scan-box crop (video px): x=' + cropX + ' y=' + cropY +
            ' w=' + cropW + ' h=' + cropH +
            ' | scaleX=' + scaleX.toFixed(2) + ' scaleY=' + scaleY.toFixed(2),
            'ok');

        // Build cropped canvas
        var cropCanvas = document.createElement('canvas');
        cropCanvas.width  = cropW;
        cropCanvas.height = cropH;
        var cropCtx = cropCanvas.getContext('2d');
        cropCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
        self._dbgAddImage(cropCanvas, 'Cropped box');

        // Build 3× upscaled crop canvas
        var scale3 = 3;
        var bigCanvas = document.createElement('canvas');
        bigCanvas.width  = cropW * scale3;
        bigCanvas.height = cropH * scale3;
        var bigCtx = bigCanvas.getContext('2d');
        bigCtx.imageSmoothingEnabled = false;
        bigCtx.drawImage(cropCanvas, 0, 0, bigCanvas.width, bigCanvas.height);
        self._dbgAddImage(bigCanvas, 'Crop ×' + scale3);

        // ── STAGE 4: Decoder receives image
        self._dbgStage(4, 'Sending to ZXing decoder…', 'info');
        $('#us-cam-status').text('⏳ Decoding EAN… (3 attempts)');

        // Run the three-pass ZXing decode sequence
        self._decodeWithZxing(canvas, cropCanvas, bigCanvas);
    },

    // ────────────────────────────────────────────────────────────────
    // _decodeWithZxing: load ZXing then attempt 3 passes in sequence
    // ────────────────────────────────────────────────────────────────
    _decodeWithZxing: function (fullCanvas, cropCanvas, bigCanvas) {
        var self = this;

        self._loadZxing(function (err) {
            if (err || !window.ZXing) {
                self._dbgStage(4, 'ZXing failed to load: ' + (err ? err.message : 'library undefined') + ' — trying html5-qrcode fallback', 'fail');
                self._fallbackHtml5Qrcode(fullCanvas, cropCanvas, bigCanvas);
                return;
            }

            // Create a MultiFormatReader configured for EAN-13 and EAN-8
            var hints = new Map();
            hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
                ZXing.BarcodeFormat.EAN_13,
                ZXing.BarcodeFormat.EAN_8,
                ZXing.BarcodeFormat.UPC_A,
                ZXing.BarcodeFormat.UPC_E,
                ZXing.BarcodeFormat.CODE_128
            ]);
            hints.set(ZXing.DecodeHintType.TRY_HARDER, true);

            var reader = new ZXing.MultiFormatReader();
            reader.setHints(hints);

            // ── Helper: decode a single canvas with ZXing
            function zxingDecodeCanvas(c) {
                try {
                    var imageData = c.getContext('2d').getImageData(0, 0, c.width, c.height);
                    var luminance = new ZXing.RGBLuminanceSource(imageData.data, c.width, c.height);
                    var binaryBitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance));
                    var result = reader.decode(binaryBitmap);
                    return result ? String(result.getText()).trim() : null;
                } catch (e) {
                    return null;
                }
            }

            // ── Pass 1: full frame
            self._dbgStage(4, 'Pass 1 — full frame (' + fullCanvas.width + 'x' + fullCanvas.height + ')', 'info');
            var r1 = zxingDecodeCanvas(fullCanvas);
            if (r1) {
                self._dbgStage(5, 'EAN decoded (Pass 1): ' + r1, 'ok');
                self._onCaptureResult(r1);
                return;
            }
            self._dbgStage(4, 'Pass 1 — no result', 'fail');

            // ── Pass 2: cropped scan-box region
            self._dbgStage(4, 'Pass 2 — cropped region (' + cropCanvas.width + 'x' + cropCanvas.height + ')', 'info');
            var r2 = zxingDecodeCanvas(cropCanvas);
            if (r2) {
                self._dbgStage(5, 'EAN decoded (Pass 2 crop): ' + r2, 'ok');
                self._onCaptureResult(r2);
                return;
            }
            self._dbgStage(4, 'Pass 2 — no result', 'fail');

            // ── Pass 3: 3× upscaled crop
            self._dbgStage(4, 'Pass 3 — ' + bigCanvas.width + 'x' + bigCanvas.height + ' upscaled crop', 'info');
            var r3 = zxingDecodeCanvas(bigCanvas);
            if (r3) {
                self._dbgStage(5, 'EAN decoded (Pass 3 upscaled): ' + r3, 'ok');
                self._onCaptureResult(r3);
                return;
            }
            self._dbgStage(4, 'Pass 3 — no result', 'fail');

            // All ZXing passes failed — try html5-qrcode scanFile fallback
            self._dbgStage(4, 'All ZXing passes failed — trying html5-qrcode fallback…', 'info');
            self._fallbackHtml5Qrcode(fullCanvas, cropCanvas, bigCanvas);
        });
    },

    // html5-qrcode scanFile fallback: try 3 canvases in sequence
    _fallbackHtml5Qrcode: function (fullCanvas, cropCanvas, bigCanvas) {
        var self = this;

        self._loadHtml5QrcodeLibrary(function () {
            if (!window.Html5Qrcode) {
                self._dbgStage(4, 'html5-qrcode library unavailable', 'fail');
                self._dbgStage(5, 'FAIL — all decoders exhausted', 'fail');
                self._captureReset('❌ All decoders failed. Check the debug panel below the camera.');
                return;
            }

            // Try each canvas in sequence by converting to File
            var canvases = [
                { c: fullCanvas, label: 'fallback full frame' },
                { c: cropCanvas, label: 'fallback crop' },
                { c: bigCanvas,  label: 'fallback upscaled crop' }
            ];

            function tryNext(idx) {
                if (idx >= canvases.length) {
                    self._dbgStage(4, 'html5-qrcode: all passes failed', 'fail');
                    self._dbgStage(5, 'FAIL — all decoders exhausted', 'fail');
                    self._captureReset('❌ Could not decode EAN barcode. Check the cropped image in the debug panel — ensure the barcode is clear and inside the blue box.');
                    return;
                }
                var item = canvases[idx];
                self._dbgStage(4, 'html5-qrcode pass — ' + item.label, 'info');

                item.c.toBlob(function (blob) {
                    if (!blob) { tryNext(idx + 1); return; }
                    var file = new File([blob], 'scan.jpg', { type: 'image/jpeg' });
                    var tid  = 'us-qr-tmp-' + Date.now();
                    var div  = document.createElement('div');
                    div.id   = tid;
                    div.style.display = 'none';
                    document.body.appendChild(div);
                    var sc = new Html5Qrcode(tid);
                    sc.scanFile(file, false)
                        .then(function (txt) {
                            document.body.removeChild(div);
                            var raw = String(txt || '').trim();
                            if (raw) {
                                self._dbgStage(5, 'EAN decoded (html5-qrcode ' + item.label + '): ' + raw, 'ok');
                                self._onCaptureResult(raw);
                            } else {
                                tryNext(idx + 1);
                            }
                        })
                        .catch(function () {
                            document.body.removeChild(div);
                            tryNext(idx + 1);
                        });
                }, 'image/jpeg', 0.97);
            }
            tryNext(0);
        });
    },

    // ──────────────────────────────────────────────────────────────────────────
    // Stage 1–8 Barcode Image Processing & Decoding Pipeline
    // ──────────────────────────────────────────────────────────────────────────

    // Validate EAN-13 (12 data + 1 check digit) and EAN-8 (7 data + 1 check digit) checksums
    _validateEanChecksum: function (barcode) {
        barcode = String(barcode || '').trim();
        if (!/^\d+$/.test(barcode)) return false;

        if (barcode.length === 13) {
            var sum = 0;
            for (var i = 0; i < 12; i++) {
                var d = parseInt(barcode.charAt(i), 10);
                sum += (i % 2 === 0) ? d : d * 3;
            }
            var check = (10 - (sum % 10)) % 10;
            return check === parseInt(barcode.charAt(12), 10);
        } else if (barcode.length === 8) {
            var sum = 0;
            for (var i = 0; i < 7; i++) {
                var d = parseInt(barcode.charAt(i), 10);
                sum += (i % 2 === 0) ? d * 3 : d;
            }
            var check = (10 - (sum % 10)) % 10;
            return check === parseInt(barcode.charAt(7), 10);
        }
        return false;
    },

    // Barcode Localization: vertical edge energy analysis to crop tightly to barcode bars
    _localizeBarcode: function (srcCanvas) {
        var w = srcCanvas.width;
        var h = srcCanvas.height;
        if (w < 40 || h < 20) return { canvas: srcCanvas, bbox: [0, 0, w, h] };

        var ctx = srcCanvas.getContext('2d');
        var imgData = ctx.getImageData(0, 0, w, h);
        var data = imgData.data;

        var colEnergy = new Float32Array(w);
        var rowEnergy = new Float32Array(h);

        // Compute horizontal difference |P(x,y) - P(x+1,y)| (vertical bars have high horizontal gradient)
        for (var y = 0; y < h; y += 2) {
            var offset = y * w * 4;
            for (var x = 0; x < w - 1; x += 2) {
                var idx = offset + x * 4;
                var g1 = (data[idx] * 299 + data[idx + 1] * 587 + data[idx + 2] * 114) / 1000;
                var g2 = (data[idx + 4] * 299 + data[idx + 5] * 587 + data[idx + 6] * 114) / 1000;
                var diff = Math.abs(g1 - g2);

                colEnergy[x] += diff;
                rowEnergy[y] += diff;
            }
        }

        var colSum = 0;
        for (var i = 0; i < w; i++) colSum += colEnergy[i];
        var rowSum = 0;
        for (var j = 0; j < h; j++) rowSum += rowEnergy[j];

        var minX = 0, maxX = w - 1;
        var minY = 0, maxY = h - 1;

        if (colSum > 0) {
            var acc = 0;
            for (var i = 0; i < w; i++) {
                acc += colEnergy[i];
                if (acc > colSum * 0.10 && minX === 0) minX = i;
                if (acc > colSum * 0.90 && maxX === w - 1) maxX = i;
            }
        }

        if (rowSum > 0) {
            var accR = 0;
            for (var j = 0; j < h; j++) {
                accR += rowEnergy[j];
                if (accR > rowSum * 0.10 && minY === 0) minY = j;
                if (accR > rowSum * 0.90 && maxY === h - 1) maxY = j;
            }
        }

        // Add 15% padding around detected candidate
        var bw = maxX - minX;
        var bh = maxY - minY;
        var padX = Math.round(bw * 0.15);
        var padY = Math.round(bh * 0.15);

        minX = Math.max(0, minX - padX);
        maxX = Math.min(w - 1, maxX + padX);
        minY = Math.max(0, minY - padY);
        maxY = Math.min(h - 1, maxY + padY);

        var cropW = maxX - minX;
        var cropH = maxY - minY;

        if (cropW < 50 || cropH < 25) {
            return { canvas: srcCanvas, bbox: [0, 0, w, h] };
        }

        var tightCanvas = document.createElement('canvas');
        tightCanvas.width = cropW;
        tightCanvas.height = cropH;
        tightCanvas.getContext('2d').drawImage(srcCanvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);

        return { canvas: tightCanvas, bbox: [minX, minY, cropW, cropH] };
    },

    // Preprocessing variants: generate 6 image variations (grayscale, high-contrast, Otsu, adaptive, inverted, rotated)
    _generatePreprocessingVariants: function (srcCanvas) {
        var variants = [];
        var w = srcCanvas.width;
        var h = srcCanvas.height;

        function cloneC(c) {
            var copy = document.createElement('canvas');
            copy.width = c.width;
            copy.height = c.height;
            copy.getContext('2d').drawImage(c, 0, 0);
            return copy;
        }

        // 1. Grayscale
        var v1 = cloneC(srcCanvas);
        var ctx1 = v1.getContext('2d');
        var img1 = ctx1.getImageData(0, 0, w, h);
        var d1 = img1.data;
        for (var i = 0; i < d1.length; i += 4) {
            var g = (d1[i] * 299 + d1[i + 1] * 587 + d1[i + 2] * 114) / 1000;
            d1[i] = d1[i + 1] = d1[i + 2] = g;
        }
        ctx1.putImageData(img1, 0, 0);
        variants.push({ canvas: v1, label: 'Grayscale' });

        // 2. High Contrast (Stretch)
        var v2 = cloneC(v1);
        var ctx2 = v2.getContext('2d');
        var img2 = ctx2.getImageData(0, 0, w, h);
        var d2 = img2.data;
        var minV = 255, maxV = 0;
        for (var i = 0; i < d2.length; i += 4) {
            if (d2[i] < minV) minV = d2[i];
            if (d2[i] > maxV) maxV = d2[i];
        }
        var range = (maxV - minV) || 1;
        for (var i = 0; i < d2.length; i += 4) {
            var val = Math.min(255, Math.max(0, Math.round(((d2[i] - minV) / range) * 255)));
            d2[i] = d2[i + 1] = d2[i + 2] = val;
        }
        ctx2.putImageData(img2, 0, 0);
        variants.push({ canvas: v2, label: 'High Contrast' });

        // 3. Otsu Binary Threshold
        var v3 = cloneC(v2);
        var ctx3 = v3.getContext('2d');
        var img3 = ctx3.getImageData(0, 0, w, h);
        var d3 = img3.data;
        var hist = new Int32Array(256);
        for (var i = 0; i < d3.length; i += 4) hist[d3[i]]++;
        var totalPx = w * h;
        var sumTotal = 0;
        for (var t = 0; t < 256; t++) sumTotal += t * hist[t];
        var sumB = 0, wB = 0, maxVar = 0, otsuT = 128;
        for (var t = 0; t < 256; t++) {
            wB += hist[t];
            if (wB === 0) continue;
            var wF = totalPx - wB;
            if (wF === 0) break;
            sumB += t * hist[t];
            var mB = sumB / wB;
            var mF = (sumTotal - sumB) / wF;
            var varBetween = wB * wF * (mB - mF) * (mB - mF);
            if (varBetween > maxVar) { maxVar = varBetween; otsuT = t; }
        }
        for (var i = 0; i < d3.length; i += 4) {
            var bw = d3[i] >= otsuT ? 255 : 0;
            d3[i] = d3[i + 1] = d3[i + 2] = bw;
        }
        ctx3.putImageData(img3, 0, 0);
        variants.push({ canvas: v3, label: 'Otsu Binary' });

        // 4. Adaptive Threshold
        var v4 = cloneC(v2);
        var ctx4 = v4.getContext('2d');
        var img4 = ctx4.getImageData(0, 0, w, h);
        var d4 = img4.data;
        var avg = 0;
        for (var i = 0; i < d4.length; i += 4) avg += d4[i];
        avg = Math.round(avg / totalPx);
        var adaptT = Math.round(avg * 0.9);
        for (var i = 0; i < d4.length; i += 4) {
            var bw = d4[i] >= adaptT ? 255 : 0;
            d4[i] = d4[i + 1] = d4[i + 2] = bw;
        }
        ctx4.putImageData(img4, 0, 0);
        variants.push({ canvas: v4, label: 'Adaptive Thresh' });

        // 5. Inverted Binary
        var v5 = cloneC(v3);
        var ctx5 = v5.getContext('2d');
        var img5 = ctx5.getImageData(0, 0, w, h);
        var d5 = img5.data;
        for (var i = 0; i < d5.length; i += 4) {
            var inv = 255 - d5[i];
            d5[i] = d5[i + 1] = d5[i + 2] = inv;
        }
        ctx5.putImageData(img5, 0, 0);
        variants.push({ canvas: v5, label: 'Inverted Binary' });

        // 6. Rotated 90°
        var v6 = document.createElement('canvas');
        v6.width = h;
        v6.height = w;
        var ctx6 = v6.getContext('2d');
        ctx6.translate(h / 2, w / 2);
        ctx6.rotate(Math.PI / 2);
        ctx6.drawImage(v2, -w / 2, -h / 2);
        variants.push({ canvas: v6, label: 'Rotated 90°' });

        return variants;
    },

    // ────────────────────────────────────────────────────────────────
    // _captureAndScan: main entry point for video camera frames
    // Runs Stages 1 through 8
    // ────────────────────────────────────────────────────────────────
    _captureAndScan: function () {
        var self = this;

        if (!this.state.cameraActive || !this.state.cameraStream) {
            frappe.msgprint(__('Camera is not active. Click "📷 Start Camera" first.'));
            return;
        }
        if (this.state.isProcessing) { return; }

        $('#us-dbg-stages').html('');
        $('#us-dbg-imgs').html('');
        $('#us-debug-panel').addClass('us-dbg-visible');
        $('#us-capture-btn').prop('disabled', true);
        $('#us-cam-status').text('⏳ Capturing frame…');

        var video  = document.getElementById('us-camera-video');
        var canvas = document.getElementById('us-capture-canvas');

        var vw = video.videoWidth;
        var vh = video.videoHeight;

        // Stage 1: Camera frame captured
        self._dbgStage(1, 'Camera frame captured', 'info');

        if (!vw || !vh) {
            self._dbgStage(1, 'FAIL — video dimensions are 0. Camera preview not loaded.', 'fail');
            self._captureReset('Camera preview loading. Wait a moment and try again.');
            return;
        }

        // Stage 2: Original frame dimensions
        self._dbgStage(2, 'Canvas dimensions: ' + vw + 'x' + vh + ' px (Display: ' + video.clientWidth + 'x' + video.clientHeight + ')', 'ok');

        canvas.width  = vw;
        canvas.height = vh;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, vw, vh);
        self._dbgAddImage(canvas, 'Full frame (' + vw + 'x' + vh + ')');

        // Stage 3: Scan-box crop
        var overlay   = document.querySelector('.us-cam-overlay');
        var dispW     = overlay ? overlay.clientWidth  : video.clientWidth;
        var dispH     = overlay ? overlay.clientHeight : video.clientHeight;
        var scaleX    = vw / dispW;
        var scaleY    = vh / dispH;

        var boxW_disp = dispW * 0.70;
        var boxH_disp = dispH * 0.38;
        var boxX_disp = (dispW - boxW_disp) / 2;
        var boxY_disp = (dispH - boxH_disp) / 2;

        var cropX = Math.max(0, Math.min(Math.round(boxX_disp * scaleX), vw - 1));
        var cropY = Math.max(0, Math.min(Math.round(boxY_disp * scaleY), vh - 1));
        var cropW = Math.min(Math.round(boxW_disp * scaleX), vw - cropX);
        var cropH = Math.min(Math.round(boxH_disp * scaleY), vh - cropY);

        self._dbgStage(3, 'Scan-box crop: ' + cropW + 'x' + cropH + ' px at (' + cropX + ',' + cropY + ')', 'ok');

        var cropCanvas = document.createElement('canvas');
        cropCanvas.width  = cropW;
        cropCanvas.height = cropH;
        cropCanvas.getContext('2d').drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
        self._dbgAddImage(cropCanvas, 'Scan box (' + cropW + 'x' + cropH + ')');

        self._processScanPipeline(canvas, cropCanvas);
    },

    // Static image file test mode
    _runStaticImageTest: function (file) {
        var self = this;
        var reader = new FileReader();

        $('#us-dbg-stages').html('');
        $('#us-dbg-imgs').html('');
        $('#us-debug-panel').addClass('us-dbg-visible');
        $('#us-cam-status').text('⏳ Processing static image…');

        self._dbgStage(1, 'Static image file loaded: ' + file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)', 'info');

        reader.onload = function (evt) {
            var img = new Image();
            img.onload = function () {
                var vw = img.width;
                var vh = img.height;
                self._dbgStage(2, 'Static image dimensions: ' + vw + 'x' + vh + ' px', 'ok');

                var canvas = document.createElement('canvas');
                canvas.width = vw;
                canvas.height = vh;
                var ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, vw, vh);
                self._dbgAddImage(canvas, 'Full static image');

                self._dbgStage(3, 'Using full static image as scan region (' + vw + 'x' + vh + ')', 'ok');
                self._processScanPipeline(canvas, canvas);
            };
            img.src = evt.target.result;
        };
        reader.readAsDataURL(file);
    },

    // Stages 4 through 8: Barcode localization, preprocessing, EAN-13 decoding, checksum validation
    _processScanPipeline: function (fullCanvas, scanBoxCanvas) {
        var self = this;

        // Stage 4: Barcode candidate localization
        var locResult = self._localizeBarcode(scanBoxCanvas);
        var tightCanvas = locResult.canvas;
        var bbox = locResult.bbox;
        self._dbgStage(4, 'Barcode candidate detected at box [' + bbox.join(', ') + ']', 'ok');

        // Stage 5: Tight barcode crop
        self._dbgStage(5, 'Tight barcode crop created: ' + tightCanvas.width + 'x' + tightCanvas.height + ' px', 'ok');
        self._dbgAddImage(tightCanvas, 'Tight crop (' + tightCanvas.width + 'x' + tightCanvas.height + ')');

        // Stage 6: Generated 6 preprocessing variants
        var variants = self._generatePreprocessingVariants(tightCanvas);
        self._dbgStage(6, 'Generated ' + variants.length + ' preprocessing variants', 'ok');

        // Add preprocessed variant thumbnails to debug panel
        variants.forEach(function (v) {
            self._dbgAddImage(v.canvas, v.label);
        });

        // Stage 7: EAN-13 decoder attempts
        self._dbgStage(7, 'Trying EAN-13 / EAN-8 decoding across preprocessed variants…', 'info');
        $('#us-cam-status').text('⏳ Running EAN-13 decoding pipeline…');

        // Run multi-variant ZXing decode
        self._decodeVariantsWithZxing(fullCanvas, scanBoxCanvas, tightCanvas, variants);
    },

    // Execute ZXing decoding against all preprocessed variants & crops
    _decodeVariantsWithZxing: function (fullCanvas, scanBoxCanvas, tightCanvas, variants) {
        var self = this;

        self._loadZxing(function (err) {
            if (err || !window.ZXing) {
                self._dbgStage(7, 'ZXing decoder unavailable — running html5-qrcode fallback', 'fail');
                self._fallbackVariantsHtml5Qrcode(fullCanvas, scanBoxCanvas, tightCanvas, variants);
                return;
            }

            var hints = new Map();
            hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
                ZXing.BarcodeFormat.EAN_13,
                ZXing.BarcodeFormat.EAN_8,
                ZXing.BarcodeFormat.UPC_A,
                ZXing.BarcodeFormat.UPC_E,
                ZXing.BarcodeFormat.CODE_128
            ]);
            hints.set(ZXing.DecodeHintType.TRY_HARDER, true);

            var reader = new ZXing.MultiFormatReader();
            reader.setHints(hints);

            function tryZxing(c) {
                try {
                    var imageData = c.getContext('2d').getImageData(0, 0, c.width, c.height);
                    var luminance = new ZXing.RGBLuminanceSource(imageData.data, c.width, c.height);
                    var binaryBitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance));
                    var result = reader.decode(binaryBitmap);
                    return result ? String(result.getText()).trim() : null;
                } catch (e) {
                    return null;
                }
            }

            // List of canvases to attempt in priority order
            var targets = [];
            variants.forEach(function (v) {
                targets.push({ canvas: v.canvas, name: 'Variant: ' + v.label });
            });
            targets.push({ canvas: tightCanvas, name: 'Tight Crop' });
            targets.push({ canvas: scanBoxCanvas, name: 'Scan Box Crop' });
            targets.push({ canvas: fullCanvas, name: 'Full Frame' });

            for (var k = 0; k < targets.length; k++) {
                var t = targets[k];
                var raw = tryZxing(t.canvas);
                if (raw) {
                    self._dbgStage(7, 'ZXing succeeded on ' + t.name + ' → "' + raw + '"', 'ok');
                    self._onCaptureResult(raw);
                    return;
                }
            }

            self._dbgStage(7, 'ZXing passes completed (no result) — checking html5-qrcode fallback', 'fail');
            self._fallbackVariantsHtml5Qrcode(fullCanvas, scanBoxCanvas, tightCanvas, variants);
        });
    },

    // Fallback: html5-qrcode scanFile against localized & preprocessed targets
    _fallbackVariantsHtml5Qrcode: function (fullCanvas, scanBoxCanvas, tightCanvas, variants) {
        var self = this;

        self._loadHtml5QrcodeLibrary(function () {
            if (!window.Html5Qrcode) {
                self._dbgStage(7, 'html5-qrcode fallback unavailable', 'fail');
                self._dbgStage(8, 'FAIL — Could not decode EAN barcode from any variant', 'fail');
                self._captureReset('❌ Could not decode EAN barcode. Check the tight crop thumbnails in the debug panel.');
                return;
            }

            var targets = [
                { canvas: tightCanvas, name: 'fallback tight crop' },
                { canvas: variants[1].canvas, name: 'fallback high contrast' },
                { canvas: variants[2].canvas, name: 'fallback Otsu binary' },
                { canvas: scanBoxCanvas, name: 'fallback scan box' }
            ];

            function tryNextFallback(idx) {
                if (idx >= targets.length) {
                    self._dbgStage(7, 'html5-qrcode fallback passes exhausted', 'fail');
                    self._dbgStage(8, 'FAIL — Could not decode EAN barcode from any variant', 'fail');
                    self._captureReset('❌ Could not decode EAN barcode. Inspect the tight crop thumbnails in the debug panel below.');
                    return;
                }
                var item = targets[idx];
                item.canvas.toBlob(function (blob) {
                    if (!blob) { tryNextFallback(idx + 1); return; }
                    var file = new File([blob], 'scan.jpg', { type: 'image/jpeg' });
                    var tid  = 'us-qr-tmp-' + Date.now();
                    var div  = document.createElement('div');
                    div.id   = tid;
                    div.style.display = 'none';
                    document.body.appendChild(div);

                    var sc = new Html5Qrcode(tid);
                    sc.scanFile(file, false)
                        .then(function (txt) {
                            document.body.removeChild(div);
                            var raw = String(txt || '').trim();
                            if (raw) {
                                self._dbgStage(7, 'html5-qrcode succeeded on ' + item.name + ' → "' + raw + '"', 'ok');
                                self._onCaptureResult(raw);
                            } else {
                                tryNextFallback(idx + 1);
                            }
                        })
                        .catch(function () {
                            document.body.removeChild(div);
                            tryNextFallback(idx + 1);
                        });
                }, 'image/jpeg', 0.97);
            }

            tryNextFallback(0);
        });
    },

    // ── Called when a decoded EAN string arrives ─────────────────────────────────
    _onCaptureResult: function (raw) {
        var self = this;

        // Stage 8A: Format validation (must be digits only, length 8 or 13)
        if (!raw || !/^\d+$/.test(raw)) {
            self._dbgStage(8, 'FAIL — decoded non-numeric value: "' + raw + '"', 'fail');
            self._captureReset('⚠ Decoded value is not numeric: "' + raw + '". Not an EAN barcode.');
            return;
        }
        if (raw.length !== 8 && raw.length !== 13) {
            self._dbgStage(8, 'FAIL — decoded ' + raw.length + '-digit value: "' + raw + '" (expected 8 or 13 digits)', 'fail');
            self._captureReset('⚠ Decoded ' + raw.length + '-digit code "' + raw + '". Expected EAN-8 (8) or EAN-13 (13).');
            return;
        }

        // Stage 8B: EAN Checksum validation (12 data + 1 check digit / 7 data + 1 check digit)
        var isChecksumValid = self._validateEanChecksum(raw);
        if (!isChecksumValid) {
            self._dbgStage(8, 'FAIL — INVALID EAN CHECK DIGIT for "' + raw + '"', 'fail');
            self._captureReset('❌ INVALID EAN CHECK DIGIT for ' + raw + '. Barcode may be distorted or misread.');
            return;
        }

        self._dbgStage(8, 'EAN decoded & checksum valid: ' + raw, 'ok');

        // Debounce check (same barcode within 1.5s → skip duplicate submit)
        var now = Date.now();
        if (raw === self.state.lastScannedBarcode && (now - self.state.lastScanTs) < 1500) {
            self._dbgStage(8, 'Debounce — same EAN scanned within 1.5s, skipping duplicate submit', 'info');
            self._captureReset('⏸ Same barcode scanned within 1.5s — wait or scan a different product.');
            return;
        }
        self.state.lastScannedBarcode = raw;

        // Populate visible barcode input field automatically
        $('#us-barcode-input').val(raw);
        $('#us-cam-status').html('✅ <strong>✓ EAN DETECTED</strong>: <strong>' + raw + '</strong> — looking up product…');

        self._dbgStage(8, 'scan_product() called with EAN: ' + raw, 'ok');

        // Call existing scan pipeline
        self._handleScan(raw);

        // Re-enable capture button after 2.5s
        setTimeout(function () {
            self._captureReset('🎯 Ready for next scan');
            $('#us-barcode-input').val('');
        }, 2500);
    },

    // Re-enable capture button and update status text
    _captureReset: function (msg) {
        $('#us-capture-btn').prop('disabled', false);
        $('#us-cam-status').text(msg || '🎯 Position EAN barcode inside the frame, then tap Capture');
    },

    _stopCamera: function () {
        if (this.state.cameraStream) {
            try {
                this.state.cameraStream.getTracks().forEach(function (t) { t.stop(); });
            } catch (e) {}
            this.state.cameraStream = null;
        }
        var video = document.getElementById('us-camera-video');
        if (video) { video.srcObject = null; }
        this.state.cameraActive = false;
        $('#us-camera-wrapper').hide();
        $('#us-debug-panel').removeClass('us-dbg-visible');
        $('#us-cam-btn').removeClass('us-cam-stop').html('📷 Start Camera');
    },

    // ─── Scan Handling ────────────────────────────────────────────────────────

    _handleScan: function (barcode) {
        var self = this;

        // Check session selected
        if (!this.state.session) {
            this._setFeedback('warn', '⚠ Please select or create a Scan Session first.');
            this._setScanState('error');
            this.focusInput();
            return;
        }

        // Check session is active
        if (this.state.sessionStatus !== 'Active') {
            this._setFeedback('warn', '⚠ Session is ' + this.state.sessionStatus + '. Scanning is disabled.');
            this._setScanState('error');
            this.focusInput();
            return;
        }

        // JS-side debounce (server also enforces this)
        var now = Date.now();
        if (now - this.state.lastScanTs < this.state.debounceMs) {
            this.focusInput();
            return;
        }
        this.state.lastScanTs = now;

        if (this.state.isProcessing) {
            this.focusInput();
            return;
        }
        this.state.isProcessing = true;

        // Visual: scanning state
        this._setScanState('scanning');
        this._setFeedback('scanning',
            '<span class="us-spinner"></span>&nbsp;Processing: <strong>' +
            frappe.utils.escape_html(barcode) + '</strong>…'
        );
        $('#us-scan-dot').addClass('us--busy');

        frappe.call({
            method: 'universal_scanner.api.scanner.scan_product',
            args: { barcode: barcode, session: self.state.session },
            callback: function (r) {
                self.state.isProcessing = false;
                $('#us-scan-dot').removeClass('us--busy');

                if (r && r.message) {
                    if (r.message.success) {
                        self._onScanSuccess(r.message);
                    } else {
                        self._onScanError(r.message, barcode);
                    }
                } else {
                    self._setFeedback('error', '❌ Unexpected server response. Please try again.');
                    self._setScanState('error');
                }
                self.focusInput();
            },
            error: function () {
                self.state.isProcessing = false;
                $('#us-scan-dot').removeClass('us--busy');
                self._setFeedback('error', '❌ Network error. Check your connection and try again.');
                self._setScanState('error');
                self.focusInput();
            },
        });
    },

    _onScanSuccess: function (data) {
        // Feedback
        this._setFeedback('success',
            '✓ Scanned: <strong>' + frappe.utils.escape_html(data.product_id) +
            '</strong> — ' + frappe.utils.escape_html(data.product_name) +
            '&nbsp; Qty: <strong>' + data.quantity + '</strong>'
        );
        this._setScanState('success');

        // Last scanned panel
        this._updateLastScanned(data, true /* success */);

        // Summary table row (incremental update — no full reload)
        this._updateSummaryRow(data);

        // Recalculate running total
        this._updateTotal(data);

        // Reset scan state after a moment
        var self = this;
        setTimeout(function () {
            self._setScanState('idle');
        }, 2200);
    },

    _onScanError: function (data, barcode) {
        var msg = data.message
            ? '❌ ' + data.message
            : '❌ Product not found — Barcode: ' + frappe.utils.escape_html(barcode);

        this._setFeedback('error', msg);
        this._setScanState('error');

        // Show error state in last scanned panel
        var $card = $('#us-last-card');
        $card.show();
        $card.removeClass('us-animate');
        void $card[0].offsetWidth;
        $card.addClass('us-animate');

        $('#us-last-header').attr('class', 'us-last-header us-last-header-err');
        $('#us-last-status').attr('class', 'us-scan-err-label').text('Product Not Found');
        $('#us-last-ts').text(frappe.datetime.now_time());
        $('#us-last-code').text('—');
        $('#us-last-name').text('—');
        $('#us-last-bc').text(barcode);
        $('#us-last-qty').text('—');

        var self = this;
        setTimeout(function () {
            self._setScanState('idle');
        }, 3000);
    },

    // ─── Last Scanned Panel ───────────────────────────────────────────────────

    _updateLastScanned: function (data, isSuccess) {
        var $card = $('#us-last-card');
        $card.show();
        $card.removeClass('us-animate');
        void $card[0].offsetWidth; // force reflow for animation restart
        $card.addClass('us-animate');

        if (isSuccess) {
            $('#us-last-header').attr('class', 'us-last-header us-last-header-ok');
            $('#us-last-status').attr('class', 'us-scan-ok-label').text('Product Scanned');
        }

        $('#us-last-ts').text(frappe.datetime.now_time());
        $('#us-last-code').text(data.product_id);
        $('#us-last-name').text(data.product_name);
        $('#us-last-bc').text(data.barcode);

        // Quantity pop animation
        var $qty = $('#us-last-qty');
        $qty.text(data.quantity);
        $qty.addClass('us-qty-pop');
        setTimeout(function () { $qty.removeClass('us-qty-pop'); }, 400);
    },

    // ─── Session Summary Table ────────────────────────────────────────────────

    _updateSummaryRow: function (data) {
        // Row ID is derived from the item_code (sanitized for use as DOM id)
        var rowId = 'us-r-' + data.product_id.replace(/[^a-zA-Z0-9]/g, '_');
        var tbody = document.getElementById('us-tbody');
        var existing = document.getElementById(rowId);

        if (existing) {
            // Update in place — only change the qty and scans cells
            existing.querySelector('.us-td-qty').textContent = data.quantity;
            existing.querySelector('.us-td-scans').textContent = data.scan_count;
            // Flash animation
            existing.classList.remove('us-row-flash');
            void existing.offsetWidth;
            existing.classList.add('us-row-flash');
        } else {
            // Remove empty state row if present
            var emptyTd = tbody.querySelector('td[colspan]');
            if (emptyTd) emptyTd.closest('tr').remove();

            // Build new row
            var tr = document.createElement('tr');
            tr.id = rowId;
            tr.className = 'us-row-flash';
            tr.innerHTML =
                '<td class="us-td-code">' + frappe.utils.escape_html(data.product_id) + '</td>' +
                '<td>' + frappe.utils.escape_html(data.product_name) + '</td>' +
                '<td class="us-td-bc">' + frappe.utils.escape_html(data.barcode) + '</td>' +
                '<td class="us-td-qty">' + data.quantity + '</td>' +
                '<td class="us-td-scans">' + data.scan_count + '</td>';
            tbody.appendChild(tr);
        }

        // Update in-memory state
        this.state.sessionData[data.product_id] = {
            item_name: data.product_name,
            barcode: data.barcode,
            quantity: data.quantity,
            scan_count: data.scan_count,
        };
    },

    _updateTotal: function () {
        var total = 0;
        for (var k in this.state.sessionData) {
            total += (this.state.sessionData[k].quantity || 0);
        }
        this.state.totalUnits = total;
        $('#us-total-chip').text('Total: ' + total + ' unit' + (total !== 1 ? 's' : ''));
    },

    _renderFullSummary: function (data) {
        // Called after selecting a session that already has scans
        var self = this;
        self.state.sessionData = {};
        self.state.totalUnits = 0;

        var tbody = document.getElementById('us-tbody');
        tbody.innerHTML = '';

        if (!data.products || !data.products.length) {
            tbody.innerHTML =
                '<tr><td colspan="5"><div class="us-empty">' +
                '<div class="us-empty-icon">📭</div>' +
                '<div class="us-empty-msg">No products scanned yet.</div>' +
                '</div></td></tr>';
            $('#us-total-chip').text('Total: 0 units');
            return;
        }

        data.products.forEach(function (p) {
            var rowId = 'us-r-' + p.product_id.replace(/[^a-zA-Z0-9]/g, '_');
            var tr = document.createElement('tr');
            tr.id = rowId;
            tr.innerHTML =
                '<td class="us-td-code">' + frappe.utils.escape_html(p.product_id) + '</td>' +
                '<td>' + frappe.utils.escape_html(p.product_name) + '</td>' +
                '<td class="us-td-bc">' + frappe.utils.escape_html(p.barcode || '') + '</td>' +
                '<td class="us-td-qty">' + p.quantity + '</td>' +
                '<td class="us-td-scans">' + p.scan_count + '</td>';
            tbody.appendChild(tr);

            self.state.sessionData[p.product_id] = {
                item_name: p.product_name,
                barcode: p.barcode || '',
                quantity: parseInt(p.quantity) || 0,
                scan_count: parseInt(p.scan_count) || 0,
            };
        });

        self.state.totalUnits = parseInt(data.total_units) || 0;
        $('#us-total-chip').text(
            'Total: ' + self.state.totalUnits +
            ' unit' + (self.state.totalUnits !== 1 ? 's' : '')
        );
    },

    // ─── Session Management ───────────────────────────────────────────────────

    _loadActiveSessions: function () {
        var self = this;
        frappe.call({
            method: 'universal_scanner.api.scanner.get_active_sessions',
            callback: function (r) {
                if (r && r.message) {
                    self._populateSessionDropdown(r.message);
                }
            },
        });
    },

    _populateSessionDropdown: function (sessions, selectAfter) {
        var $sel = $('#us-session-select');
        $sel.find('option:not(:first)').remove();

        (sessions || []).forEach(function (s) {
            var lbl = s.name;
            if (s.description) lbl += ' — ' + s.description;
            if (s.warehouse)   lbl += ' [' + s.warehouse + ']';
            $sel.append($('<option>').val(s.name).text(lbl));
        });

        if (selectAfter) {
            $sel.val(selectAfter).trigger('change');
        }
    },

    _onSessionChange: function (sessionName) {
        if (!sessionName) {
            this._clearSession();
            return;
        }

        var self = this;
        frappe.db.get_value('Scan Session', sessionName, ['status', 'warehouse', 'description'])
            .then(function (r) {
                if (r && r.message) {
                    var d = r.message;
                    self.state.session = sessionName;
                    self.state.sessionStatus = d.status;
                    self.state.sessionWarehouse = d.warehouse || '';
                    self._applySessionUI(d);

                    // Load existing scans for this session
                    frappe.call({
                        method: 'universal_scanner.api.scanner.get_session_summary',
                        args: { session: sessionName },
                        callback: function (sr) {
                            if (sr && sr.message) {
                                self._renderFullSummary(sr.message);
                            }
                        },
                    });
                }
            });
    },

    _applySessionUI: function (d) {
        var status = d.status || 'Draft';

        // Status badge
        var cls = {
            'Active':    'us-badge-active',
            'Draft':     'us-badge-draft',
            'Completed': 'us-badge-completed',
            'Cancelled': 'us-badge-cancelled',
        }[status] || 'us-badge-none';

        $('#us-status-badge')
            .attr('class', 'us-badge ' + cls)
            .html('<span class="us-badge-dot"></span>' + status);

        // Warehouse row
        if (d.warehouse) {
            $('#us-wh-row').show();
            $('#us-wh-val').text(d.warehouse);
        } else {
            $('#us-wh-row').hide();
        }

        // Action buttons
        var isActive = (status === 'Active');
        $('#us-complete-btn').prop('disabled', !isActive);
        $('#us-cancel-btn').prop('disabled', !isActive);

        // Scanner feedback
        if (status === 'Active') {
            this._setFeedback('idle', '● Ready — scan a barcode to record it');
            this._setScanState('idle');
        } else {
            this._setFeedback('warn',
                '⚠ Session is ' + status + '. Scanning is disabled. Select an Active session.'
            );
        }

        this.focusInput();
    },

    _clearSession: function () {
        this.state.session = null;
        this.state.sessionStatus = null;
        this.state.sessionWarehouse = '';
        this.state.sessionData = {};
        this.state.totalUnits = 0;

        $('#us-status-badge').attr('class', 'us-badge us-badge-none').html('<span class="us-badge-dot"></span>No Session');
        $('#us-wh-row').hide();
        $('#us-complete-btn').prop('disabled', true);
        $('#us-cancel-btn').prop('disabled', true);
        this._setFeedback('idle', '● Select or create a session to begin scanning');
        this._setScanState('idle');

        var tbody = document.getElementById('us-tbody');
        tbody.innerHTML =
            '<tr><td colspan="5"><div class="us-empty">' +
            '<div class="us-empty-icon">📭</div>' +
            '<div class="us-empty-msg">No products scanned yet.<br>Select a session and start scanning.</div>' +
            '</div></td></tr>';
        $('#us-total-chip').text('Total: 0 units');
    },

    _showNewSessionDialog: function () {
        var self = this;
        var d = new frappe.ui.Dialog({
            title: __('Start New Scan Session'),
            fields: [
                {
                    fieldname: 'warehouse',
                    fieldtype: 'Link',
                    options: 'Warehouse',
                    label: __('Warehouse (Optional)'),
                    description: __('Warehouse this session is associated with.'),
                },
                {
                    fieldname: 'description',
                    fieldtype: 'Data',
                    label: __('Description (Optional)'),
                    description: __('E.g. "Morning stock count", "Dock 3 receiving"'),
                },
            ],
            primary_action_label: __('▶ Start Session'),
            primary_action: function (values) {
                d.disable_primary_action();
                frappe.call({
                    method: 'universal_scanner.api.scanner.start_scan_session',
                    args: {
                        warehouse: values.warehouse || '',
                        description: values.description || '',
                    },
                    callback: function (r) {
                        d.hide();
                        if (r && r.message) {
                            var name = r.message.session;
                            frappe.show_alert({ message: __('Session {0} started.', [name]), indicator: 'green' }, 4);

                            // Add to dropdown and select it
                            var lbl = name +
                                (values.description ? ' — ' + values.description : '') +
                                (values.warehouse   ? ' [' + values.warehouse + ']' : '');
                            var $sel = $('#us-session-select');
                            $sel.append($('<option>').val(name).text(lbl));
                            $sel.val(name).trigger('change');
                        }
                    },
                    error: function () {
                        d.enable_primary_action();
                    },
                });
            },
        });
        d.show();
    },

    _confirmCompleteSession: function () {
        var self = this;
        if (!self.state.session) return;

        frappe.confirm(
            __('Complete session <strong>{0}</strong>? No further scans will be allowed.', [self.state.session]),
            function () {
                frappe.call({
                    method: 'universal_scanner.api.scanner.complete_scan_session',
                    args: { session: self.state.session },
                    callback: function (r) {
                        if (r && r.message) {
                            frappe.show_alert({ message: __('Session {0} completed.', [self.state.session]), indicator: 'green' }, 4);
                            self.state.sessionStatus = 'Completed';
                            self._applySessionUI({ status: 'Completed', warehouse: self.state.sessionWarehouse });
                        }
                    },
                });
            }
        );
    },

    _confirmCancelSession: function () {
        var self = this;
        if (!self.state.session) return;

        frappe.confirm(
            __('Cancel session <strong>{0}</strong>? This action cannot be undone.', [self.state.session]),
            function () {
                frappe.call({
                    method: 'universal_scanner.api.scanner.cancel_scan_session',
                    args: { session: self.state.session },
                    callback: function (r) {
                        if (r && r.message) {
                            frappe.show_alert({ message: __('Session {0} cancelled.', [self.state.session]), indicator: 'orange' }, 4);
                            self.state.sessionStatus = 'Cancelled';
                            self._applySessionUI({ status: 'Cancelled', warehouse: self.state.sessionWarehouse });
                        }
                    },
                });
            }
        );
    },

    // ─── Visual State Helpers ─────────────────────────────────────────────────

    _setScanState: function (state) {
        var $card = $('#us-scan-card');
        $card.removeClass('us--scanning us--success us--error');
        var $dot = $('#us-scan-dot');
        $dot.removeClass('us--busy us--err');

        if (state === 'scanning') {
            $card.addClass('us--scanning');
            $dot.addClass('us--busy');
        } else if (state === 'success') {
            $card.addClass('us--success');
        } else if (state === 'error') {
            $card.addClass('us--error');
            $dot.addClass('us--err');
        }
    },

    _setFeedback: function (type, html) {
        $('#us-feedback')
            .attr('class', 'us-feedback us-fb-' + type)
            .html(html);
    },

    // ─── Page Header Buttons ──────────────────────────────────────────────────

    _setupPageButtons: function () {
        var self = this;

        this.page.add_inner_button(__('Refresh Sessions'), function () {
            frappe.call({
                method: 'universal_scanner.api.scanner.get_active_sessions',
                callback: function (r) {
                    if (r && r.message) {
                        var cur = $('#us-session-select').val();
                        self._populateSessionDropdown(r.message);
                        if (cur) {
                            $('#us-session-select').val(cur);
                        }
                        frappe.show_alert({ message: __('Sessions refreshed'), indicator: 'blue' }, 2);
                    }
                },
            });
        });

        this.page.add_inner_button(__('View Scan Logs'), function () {
            frappe.set_route('List', 'Product Scan Log');
        });

        this.page.add_inner_button(__('View Sessions'), function () {
            frappe.set_route('List', 'Scan Session');
        });
    },
};
