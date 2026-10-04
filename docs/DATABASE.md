# DyPOS Database Schema & Migrations

The system uses a tiered migration approach to evolve the database from a basic POS to a full-scale Enterprise ERP.

## 🗃 Schema: `dypos`
The primary schema for all business objects.

### Core Modules:
1. **Infrastructure:** `tenants`, `branches`, `users`, `devices`, `warehouses`.
2. **Catalog:** `products`, `categories`, `brands`, `units_of_measure`, `price_lists`.
3. **Sales:** `invoices`, `invoice_items`, `customers`, `promotions`.
4. **Accounting:** `chart_of_accounts`, `journal_entries`, `journal_lines`, `accounting_periods`.
5. **Supply Chain:** `suppliers`, `purchase_orders`, `stock_movements`.
6. **Finance:** `accounts_receivable`, `accounts_payable`, `payment_transactions`, `exchange_rates`.
7. **Hospitality:** `restaurant_tables`, `restaurant_areas`, `kitchen_tickets`, `kitchen_stations`.
8. **Financial Reporting:** `cash_movements`, `financial_statements`, `expense_category_map`.

## 📜 Migration Packs

### Pack 1: `dypos_schema_complement_v24_v40.sql`
- **Focus:** Structural hardening.
- **Key Changes:** Introduced detailed product catalog (barcodes, multiple units), tax engine (VAT inclusive/exclusive), and basic purchasing workflow.

### Pack 2: `dypos_final_global_production_complement_v41_v100.sql`
- **Focus:** Enterprise features.
- **Key Changes:** Full Double-Entry Accounting integration, FX/Currency management, promotion & coupon engine, and restaurant KDS (Kitchen Display System) tables.

### Pack 3: `dypos_database_engine_v101_v130.sql`
- **Focus:** Operational Intelligence & Audit.
- **Key Changes:** Materialized views for fast reporting, the Global Audit Engine (JSONB before/after logging), and stored procedures for period closing and payment reconciliation.

## 🛠 Maintenance
Materialized views should be refreshed periodically:
```sql
CALL dypos.refresh_reporting_views();
```
Check system health:
```sql
SELECT * FROM dypos.health_check();
```
