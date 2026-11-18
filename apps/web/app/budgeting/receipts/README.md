# Receipts and documents

The receipts route keeps the scanner, file upload, receipt editor and document ID lookup used by Tax planning. The library follows the API cursor with bounded reads and no row prefetch. Its count describes the loaded page. Copy IDs and CSV export all matching records after reveal.

The Budgeting Documents page uses numbered pages and filtered totals from the same receipts API. Its drawer retrieves the original only after reveal and reuses the file for preview and download.
