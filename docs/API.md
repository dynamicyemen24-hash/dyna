# DyPOS API Documentation

## 1. Database Management
### `GET /api/db/health`
Checks the connection to Neon PostgreSQL and lists available tables and schema status.

### `POST /api/db/init`
Triggers the full database initialization and applies all professional migration packs.

## 2. Product Catalog
### `GET /api/db/products`
Returns products for the specified tenant.
- **Query Params:** `tenantId` (default: 'royal-global-hq').

## 3. Sales & Analytics
### `GET /api/db/analytics/daily`
Returns daily sales data aggregated via the `v_daily_sales` view.

### `POST /api/ai/analyze`
Sends a natural language query to Gemini AI to analyze sales trends and provide insights.

## 3b. Financial Statements

Detailed Profit & Loss and Cash Flow. Every figure is aggregated by PostgreSQL
on the server, never re-derived in the browser — that is what makes the numbers
defensible in a management meeting.

All endpoints require `reports.view`; the two write endpoints additionally
require `reports.manage`.

| Endpoint | Purpose |
|---|---|
| `GET /api/db/financials/summary` | Headline tiles with a like-for-like comparison window |
| `GET /api/db/financials/pnl` | The P&L, line by line, in reporting order |
| `GET /api/db/financials/cash-flow` | Operating / investing / financing, with a reconciling closing balance |
| `GET /api/db/financials/trend` | Monthly series for the charts (zero months included, never gaps) |
| `GET /api/db/financials/expense-breakdown` | Expense mix by reporting bucket |
| `GET /api/db/financials/cash-movements` | Capex, loans and other non-trading flows |
| `POST /api/db/financials/cash-movements` | Records a non-trading flow (`reports.manage`) |
| `GET /api/db/financials/statements` | Published, versioned statement history |
| `POST /api/db/financials/statements` | Freezes the period as an immutable snapshot (`reports.manage`) |

**Query params** (shared): `from` / `to` as `YYYY-MM-DD`, `branchId`, and
`months` for the trend endpoint. The window is clamped server-side to five years.

### Three rules that keep the statements honest

1. **Revenue excludes VAT.** It is `subtotal - discount`, never the raw `total`,
   which is gross of tax. In this database 26 of 178 invoices carry a discount
   that is already deducted from `total`; using `total` would overstate income
   by that amount plus the VAT.
2. **Absent data is reported as absent.** With no expense rows the response
   sets `completeness.expensesRecorded = false` and adds a note. Net profit
   then equals gross profit — arithmetically true, operationally meaningless —
   and the UI says so above the figures rather than in a footnote.
3. **Cost of sales is attributed or flagged.** Invoice lines whose cost cannot
   be resolved are counted in `completeness.cogsUnattributed` and set
   `cogsComplete: false`, rather than being priced at zero and inflating the
   margin.

### Cash flow basis

`closingCash = openingCash + operating + investing + financing` holds by
construction: the opening balance is every movement from the start of time to
the day before the window, computed with the same functions.

The figure is the **movement of money through the system**, not a bank balance —
it does not know about an opening float, an overdraft, or a deposit made outside
the POS. The response carries this as `basis` and the UI displays it.

## 4. Security
- All requests should include a `tenant-id` header in a production environment.
- The server automatically sets the PostgreSQL `app.tenant_id` session variable to enforce Row Level Security.

---
*Note: This is a living document. Detailed Swagger/OpenAPI documentation is available in development mode.*
