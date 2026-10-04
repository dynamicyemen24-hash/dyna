import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NEON_CONNECTION_STRING =
  process.env.DATABASE_URL ||
  'postgresql://neondb_owner:npg_AThWFSv1VPj7@ep-shiny-wind-ai4w5o0l-pooler.c-4.us-east-1.aws.neon.tech/dyposdb?sslmode=require';

if (!process.env.DATABASE_URL && NEON_CONNECTION_STRING) {
  console.warn(
    '[neonDb] DATABASE_URL is not set — falling back to the bundled default connection string. Set DATABASE_URL before running in production.',
  );
}

export const pool = new Pool({
  connectionString: NEON_CONNECTION_STRING,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 10,
  /**
   * Socket lifetime, not just a cleanup interval.
   *
   * This was 30s — LONGER than Neon keeps an idle connection alive, so the
   * provider closed sockets that the pool still considered usable. The next
   * query on such a socket failed with "Connection terminated due to connection
   * timeout", which surfaced as a 500 on a route that had done nothing wrong.
   *
   * The client must release a socket BEFORE the server drops it, so the timeout
   * here has to be the shortest among the relevant lifetimes, not the longest.
   */
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 20_000,
  // Fail fast rather than hanging a request thread on a socket that is already
  // dead; the pool discards the errored client and the retry opens a new one.
  query_timeout: 30_000,
});

/**
 * A server-side idle timeout kills sockets the pool still believes are good.
 *
 * `pool.on('error')` is what turns that into a recoverable event: without a
 * listener, an idle-client error is an unhandled 'error' event, which takes the
 * process down. With it, the error is consumed and the pool simply discards the
 * dead client — the next query opens a fresh connection and succeeds.
 */
pool.on('error', () => {
  // Deliberately empty: the event exists to be handled, not logged. Logging every
  // recycled socket would bury real failures in transport noise.
});

pool.on('connect', (client) => {
  client.query('SET search_path TO dypos, public;').catch(() => {});
});

export async function initDatabaseSchema() {
  const client = await pool.connect();
  try {
    // 0. Ensure schema exists with full ownership
    await client.query(`CREATE SCHEMA IF NOT EXISTS dypos AUTHORIZATION neondb_owner;`);
    await client.query(`SET search_path TO dypos, public;`);

    // --- ENUM TYPES (IF NEEDED) OR CONSTRAINTS ---

    // --- RENAME / CLEANUP LEGACY TABLES ---
    await client.query(`
      DO $$ 
      BEGIN 
        -- Rename transactions to invoices if it exists
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='dypos' AND table_name='transactions') 
           AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='dypos' AND table_name='invoices') THEN
          ALTER TABLE dypos.transactions RENAME TO invoices;
        END IF;

        -- Rename transaction_items to invoice_items if it exists
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='dypos' AND table_name='transaction_items') 
           AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='dypos' AND table_name='invoice_items') THEN
          ALTER TABLE dypos.transaction_items RENAME TO invoice_items;
        END IF;

        -- ---------------------------------------------------------------------
        -- Legacy table teardown — DISABLED
        --
        -- This block used to DROP fourteen tables with CASCADE on EVERY boot of
        -- the server. In production that silently destroyed every sale, stock
        -- movement and journal entry the moment the process restarted, and the
        -- loss was invisible because the CREATE TABLE IF NOT EXISTS statements
        -- further down rebuilt empty shells.
        --
        -- Schema changes now go through the numbered migrations in
        -- server/migrations, which are additive and idempotent:
        --     npx tsx scripts/migrate.ts
        --
        -- The legacy renames above are kept because they only fire when the old
        -- table exists and the new one does not.
        -- ---------------------------------------------------------------------

        -- Rename price to unit_price if it exists
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='products' AND column_name='price') THEN
          ALTER TABLE dypos.products RENAME COLUMN price TO unit_price;
        END IF;

        -- Rename customer balance to wallet_balance if it exists
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='customers' AND column_name='balance') THEN
          ALTER TABLE dypos.customers RENAME COLUMN balance TO wallet_balance;
        END IF;

        -- Rename purchase_orders order_date to ordered_at if it exists
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='purchase_orders' AND column_name='order_date') THEN
          ALTER TABLE dypos.purchase_orders RENAME COLUMN order_date TO ordered_at;
        END IF;
      END $$;
    `);

    // 1. Tenants table (Extended)
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.tenants (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        owner_company VARCHAR(255) DEFAULT 'شركة المنافذ الذكية للبرمجيات (Smart Ports Software)',
        brand_name VARCHAR(255) DEFAULT 'DyPOS Enterprise Cloud & Edge',
        commercial_reg VARCHAR(64),
        tax_number VARCHAR(64),
        country_code VARCHAR(10) DEFAULT 'SA',
        base_currency VARCHAR(10) DEFAULT 'SAR',
        plan VARCHAR(64) DEFAULT 'enterprise',
        is_active BOOLEAN DEFAULT true,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Add industry_profile to tenants if missing
      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='tenants' AND column_name='industry_profile') THEN
          ALTER TABLE dypos.tenants ADD COLUMN industry_profile VARCHAR(128) DEFAULT 'retail';
        END IF;
      END $$;
-- The tenants row was seeded once from an older definition, so the
      -- commercial columns can be absent on an already-provisioned database,
      -- while the bootstrap INSERT below depends on them. Converge the shape
      -- first so startup never dies on a missing column.
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='tenants' AND column_name='commercial_reg') THEN
          ALTER TABLE dypos.tenants ADD COLUMN commercial_reg VARCHAR(64);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='tenants' AND column_name='tax_number') THEN
          ALTER TABLE dypos.tenants ADD COLUMN tax_number VARCHAR(64);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='tenants' AND column_name='country_code') THEN
          ALTER TABLE dypos.tenants ADD COLUMN country_code VARCHAR(10) DEFAULT 'SA';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='tenants' AND column_name='base_currency') THEN
          ALTER TABLE dypos.tenants ADD COLUMN base_currency VARCHAR(10) DEFAULT 'SAR';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='tenants' AND column_name='plan') THEN
          ALTER TABLE dypos.tenants ADD COLUMN plan VARCHAR(64) DEFAULT 'enterprise';
        END IF;
      END $$;
    `);

    // 1.1 Capabilities Registry
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.capabilities (
        id VARCHAR(64) PRIMARY KEY,
        name_ar VARCHAR(128) NOT NULL,
        name_en VARCHAR(128) NOT NULL,
        description TEXT,
        icon VARCHAR(64),
        category VARCHAR(64) DEFAULT 'core', -- core, specialized, industry
        is_active BOOLEAN DEFAULT true
      );
    `);

    // 1.2 Tenant Capabilities (The Composition Engine)
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.tenant_capabilities (
        tenant_id VARCHAR(64) REFERENCES dypos.tenants(id) ON DELETE CASCADE,
        capability_id VARCHAR(64) REFERENCES dypos.capabilities(id) ON DELETE CASCADE,
        is_enabled BOOLEAN DEFAULT true,
        config JSONB DEFAULT '{}',
        PRIMARY KEY (tenant_id, capability_id)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.currencies (
        code VARCHAR(10) PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        symbol VARCHAR(10),
        exchange_rate NUMERIC(15, 6) DEFAULT 1.0, -- Relative to SAR or local base
        is_active BOOLEAN DEFAULT true,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2.1 Countries
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.countries (
        code VARCHAR(10) PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        name_ar VARCHAR(128),
        phone_code VARCHAR(10),
        currency_code VARCHAR(10)
      );
    `);

    // 2.2 Cities
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.cities (
        id SERIAL PRIMARY KEY,
        country_code VARCHAR(10) REFERENCES dypos.countries(code),
        name VARCHAR(128) NOT NULL,
        name_ar VARCHAR(128)
      );
    `);

    // 3. Branches
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.branches (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        name VARCHAR(255) NOT NULL,
        location VARCHAR(255),
        city VARCHAR(128),
        phone VARCHAR(32),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3.1 Warehouses
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.warehouses (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        branch_id VARCHAR(64) REFERENCES dypos.branches(id),
        name VARCHAR(255) NOT NULL,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 4. Categories
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.categories (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        name VARCHAR(128) NOT NULL,
        icon VARCHAR(64),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 5. Products (Extended)
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.products (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        category_id VARCHAR(64) REFERENCES dypos.categories(id),
        category VARCHAR(128), -- For backwards compatibility
        name VARCHAR(255) NOT NULL,
        name_en VARCHAR(255),
        sku VARCHAR(64),
        barcode VARCHAR(128),
        unit_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
        cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
        stock NUMERIC(12, 2) NOT NULL DEFAULT 0,
        min_stock NUMERIC(12, 2) DEFAULT 5,
        unit VARCHAR(32) DEFAULT 'حبة',
        tax_rate NUMERIC(5, 2) DEFAULT 15.00,
        image_url TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 6. Customers
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.customers (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(32),
        email VARCHAR(128),
        tax_number VARCHAR(64),
        loyalty_points INTEGER DEFAULT 0,
        wallet_balance NUMERIC(12, 2) DEFAULT 0,
        credit_limit NUMERIC(12, 2) DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 7. Suppliers
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.suppliers (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        name VARCHAR(255) NOT NULL,
        contact_person VARCHAR(128),
        phone VARCHAR(32),
        email VARCHAR(128),
        balance_due NUMERIC(12, 2) DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 8. Invoices (formerly transactions)
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.invoices (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        invoice_number VARCHAR(128) NOT NULL UNIQUE,
        branch_id VARCHAR(64),
        customer_id VARCHAR(64) REFERENCES dypos.customers(id),
        customer_name VARCHAR(255),
        cashier_id VARCHAR(64),
        cashier_name VARCHAR(255),
        subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
        tax NUMERIC(12, 2) NOT NULL DEFAULT 0,
        discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
        total NUMERIC(12, 2) NOT NULL DEFAULT 0,
        payment_method VARCHAR(64) DEFAULT 'mada',
        status VARCHAR(64) DEFAULT 'completed',
        currency_code VARCHAR(10) DEFAULT 'SAR',
        exchange_rate NUMERIC(15, 6) DEFAULT 1.0,
        items JSONB DEFAULT '[]'::jsonb,
        metadata JSONB DEFAULT '{}',
        timestamp VARCHAR(128),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 9. Invoice Items (formerly transaction_items)
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.invoice_items (
        id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        invoice_id VARCHAR(64) REFERENCES dypos.invoices(id) ON DELETE CASCADE,
        product_id VARCHAR(64) REFERENCES dypos.products(id),
        quantity NUMERIC(12, 3) NOT NULL,
        unit_price NUMERIC(12, 2) NOT NULL,
        discount NUMERIC(12, 2) DEFAULT 0,
        tax_amount NUMERIC(12, 2) DEFAULT 0,
        total NUMERIC(12, 2) NOT NULL
      );
    `);

    // 9.1 Shifts
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.shifts (
        id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        branch_id VARCHAR(64) REFERENCES dypos.branches(id),
        user_id VARCHAR(64) REFERENCES dypos.users(id),
        start_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        end_time TIMESTAMP WITH TIME ZONE,
        status VARCHAR(32) DEFAULT 'open'
      );
    `);

    // 10. Stock Movements (Inventory Ledger)
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.stock_movements (
        id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        product_id VARCHAR(64) REFERENCES dypos.products(id),
        tenant_id VARCHAR(64) REFERENCES dypos.tenants(id),
        branch_id VARCHAR(64) REFERENCES dypos.branches(id),
        type VARCHAR(32) NOT NULL, -- in, out, transfer, adjustment, return
        quantity NUMERIC(12, 3) NOT NULL,
        reference_id VARCHAR(128), -- Invoice ID or PO ID
        reason TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 11. Accounting: Journal Entries
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.journal_entries (
        id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        entry_number VARCHAR(128) NOT NULL,
        date DATE DEFAULT CURRENT_DATE,
        description TEXT,
        total_amount NUMERIC(12, 2) NOT NULL,
        status VARCHAR(32) DEFAULT 'posted',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 12. Accounting: Ledger Details
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.ledger (
        id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        journal_id VARCHAR(64) REFERENCES dypos.journal_entries(id) ON DELETE CASCADE,
        account_code VARCHAR(64) NOT NULL,
        account_name VARCHAR(128),
        debit NUMERIC(12, 2) DEFAULT 0,
        credit NUMERIC(12, 2) DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 13. HR: Employees
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.employees (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        branch_id VARCHAR(64) REFERENCES dypos.branches(id),
        name VARCHAR(255) NOT NULL,
        role VARCHAR(128),
        phone VARCHAR(32),
        email VARCHAR(128),
        base_salary NUMERIC(12, 2) DEFAULT 0,
        commission_rate NUMERIC(5, 2) DEFAULT 0,
        status VARCHAR(32) DEFAULT 'active',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 14. HR: Attendance
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.attendance (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(64) REFERENCES dypos.employees(id),
        date DATE DEFAULT CURRENT_DATE,
        clock_in TIMESTAMP WITH TIME ZONE,
        clock_out TIMESTAMP WITH TIME ZONE,
        status VARCHAR(32) DEFAULT 'present',
        notes TEXT
      );
    `);

    // 15. Users & Roles (RBAC)
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.users (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        branch_id VARCHAR(64) REFERENCES dypos.branches(id),
        username VARCHAR(128) UNIQUE NOT NULL,
        password_hash TEXT,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(64) DEFAULT 'cashier', -- admin, manager, cashier, supervisor
        is_active BOOLEAN DEFAULT true,
        last_login TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 16. POS Sessions / Shifts
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.pos_sessions (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        branch_id VARCHAR(64) REFERENCES dypos.branches(id),
        user_id VARCHAR(64) REFERENCES dypos.users(id),
        opening_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        closing_time TIMESTAMP WITH TIME ZONE,
        opening_cash NUMERIC(12, 2) DEFAULT 0,
        closing_cash NUMERIC(12, 2),
        expected_cash NUMERIC(12, 2),
        difference NUMERIC(12, 2),
        status VARCHAR(32) DEFAULT 'open', -- open, closed
        notes TEXT
      );
    `);

    // 17. Purchase Orders (Formal Workflow)
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.purchase_orders (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        po_number VARCHAR(128) UNIQUE NOT NULL,
        supplier_id VARCHAR(64) REFERENCES dypos.suppliers(id),
        branch_id VARCHAR(64) REFERENCES dypos.branches(id),
        total_amount NUMERIC(12, 2) NOT NULL,
        status VARCHAR(64) DEFAULT 'pending', -- pending, approved, received, cancelled
        ordered_at DATE DEFAULT CURRENT_DATE,
        received_date TIMESTAMP WITH TIME ZONE,
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 18. Expenses
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.expenses (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        branch_id VARCHAR(64) REFERENCES dypos.branches(id),
        category VARCHAR(128), -- Salary, Rent, Utilities, etc
        amount NUMERIC(12, 2) NOT NULL,
        description TEXT,
        expense_date DATE DEFAULT CURRENT_DATE,
        payment_method VARCHAR(64) DEFAULT 'cash',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 19. Restaurant Tables & Areas
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.restaurant_areas (
        id VARCHAR(64) PRIMARY KEY,
        branch_id VARCHAR(64) REFERENCES dypos.branches(id),
        name VARCHAR(128) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.restaurant_tables (
        id VARCHAR(64) PRIMARY KEY,
        area_id VARCHAR(64) REFERENCES dypos.restaurant_areas(id),
        table_number VARCHAR(32) NOT NULL,
        capacity INTEGER DEFAULT 4,
        status VARCHAR(32) DEFAULT 'available', -- available, occupied, reserved
        current_invoice_id VARCHAR(64) REFERENCES dypos.invoices(id) ON DELETE SET NULL
      );
    `);

    // Backwards-compat: older code may reference current_transaction_id
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='restaurant_tables' AND column_name='current_invoice_id') THEN
          ALTER TABLE dypos.restaurant_tables ADD COLUMN current_invoice_id VARCHAR(64) REFERENCES dypos.invoices(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // 20. Discounts & Promotions
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.promotions (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        name VARCHAR(128) NOT NULL,
        type VARCHAR(64) NOT NULL, -- percentage, fixed_amount, bogo
        value NUMERIC(12, 2) NOT NULL,
        start_date DATE,
        end_date DATE,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 21. System / Branch Settings
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.settings (
        id SERIAL PRIMARY KEY,
        tenant_id VARCHAR(64) REFERENCES dypos.tenants(id),
        branch_id VARCHAR(64) REFERENCES dypos.branches(id),
        key VARCHAR(128) NOT NULL,
        value TEXT,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, branch_id, key)
      );
    `);

    // 22. Audit Logs (Enhanced)
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.audit_logs (
        id SERIAL PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        user_id VARCHAR(64) REFERENCES dypos.users(id),
        user_name VARCHAR(128),
        action VARCHAR(128) NOT NULL,
        table_name VARCHAR(64),
        record_id VARCHAR(128),
        old_data JSONB,
        new_data JSONB,
        client_ip VARCHAR(64),
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // --- TRIGGERS & FUNCTIONS ---

    // Function to update stock on sale/purchase
    await client.query(`
      CREATE OR REPLACE FUNCTION dypos.update_stock_on_movement()
      RETURNS TRIGGER AS $$
      BEGIN
        IF (TG_OP = 'INSERT') THEN
          IF (NEW.type = 'out' OR NEW.type = 'transfer_out') THEN
            UPDATE dypos.products SET stock = stock - NEW.quantity WHERE id = NEW.product_id;
          ELSIF (NEW.type = 'in' OR NEW.type = 'transfer_in' OR NEW.type = 'return') THEN
            UPDATE dypos.products SET stock = stock + NEW.quantity WHERE id = NEW.product_id;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trigger_update_stock ON dypos.stock_movements;
      CREATE TRIGGER trigger_update_stock
      AFTER INSERT ON dypos.stock_movements
      FOR EACH ROW EXECUTE FUNCTION dypos.update_stock_on_movement();
    `);

    // Ensure columns exist on existing tables (Migration Support)
    await client.query(`
      DO $$ 
      BEGIN 
        -- Tenants
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='tenants' AND column_name='is_active') THEN
          ALTER TABLE dypos.tenants ADD COLUMN is_active BOOLEAN DEFAULT true;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='tenants' AND column_name='metadata') THEN
          ALTER TABLE dypos.tenants ADD COLUMN metadata JSONB DEFAULT '{}';
        END IF;

        -- Currencies
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='currencies' AND column_name='is_active') THEN
          ALTER TABLE dypos.currencies ADD COLUMN is_active BOOLEAN DEFAULT true;
        END IF;

        -- Branches
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='branches' AND column_name='is_active') THEN
          ALTER TABLE dypos.branches ADD COLUMN is_active BOOLEAN DEFAULT true;
        END IF;

        -- Products
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='products' AND column_name='is_active') THEN
          ALTER TABLE dypos.products ADD COLUMN is_active BOOLEAN DEFAULT true;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='products' AND column_name='category') THEN
          ALTER TABLE dypos.products ADD COLUMN category VARCHAR(128);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='products' AND column_name='image_url') THEN
          ALTER TABLE dypos.products ADD COLUMN image_url TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='products' AND column_name='min_stock') THEN
          ALTER TABLE dypos.products ADD COLUMN min_stock NUMERIC(12, 2) DEFAULT 5;
        END IF;

        -- Invoices
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='invoices' AND column_name='cashier_id') THEN
          ALTER TABLE dypos.invoices ADD COLUMN cashier_id VARCHAR(64);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='invoices' AND column_name='customer_id') THEN
          ALTER TABLE dypos.invoices ADD COLUMN customer_id VARCHAR(64);
        END IF;

        -- Customers
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='customers' AND column_name='credit_limit') THEN
          ALTER TABLE dypos.customers ADD COLUMN credit_limit NUMERIC(12, 2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='customers' AND column_name='wallet_balance') THEN
          ALTER TABLE dypos.customers ADD COLUMN wallet_balance NUMERIC(12, 2) DEFAULT 0;
        END IF;

        -- Users
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='dypos' AND table_name='users') THEN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dypos' AND table_name='users' AND column_name='is_active') THEN
            ALTER TABLE dypos.users ADD COLUMN is_active BOOLEAN DEFAULT true;
          END IF;
        END IF;
      END $$;
    `);

    // 13. Commerce OS Modules: Specialized Engines
    await client.query(`
      -- Measurements (Tailoring, Medical, etc)
      CREATE TABLE IF NOT EXISTS dypos.measurements (
        id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        customer_id VARCHAR(64) REFERENCES dypos.customers(id),
        type VARCHAR(64) NOT NULL, -- tailoring_suit, tailoring_shirt, medical_optics
        data JSONB NOT NULL DEFAULT '{}',
        is_default BOOLEAN DEFAULT false,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Appointments (Salons, Clinics)
      CREATE TABLE IF NOT EXISTS dypos.appointments (
        id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        branch_id VARCHAR(64) REFERENCES dypos.branches(id),
        customer_id VARCHAR(64) REFERENCES dypos.customers(id),
        staff_id VARCHAR(64) REFERENCES dypos.users(id),
        service_id VARCHAR(64) REFERENCES dypos.products(id),
        start_time TIMESTAMP WITH TIME ZONE NOT NULL,
        end_time TIMESTAMP WITH TIME ZONE,
        status VARCHAR(32) DEFAULT 'scheduled', -- scheduled, checked_in, completed, cancelled
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Work Orders (Workshops, Custom Production)
      CREATE TABLE IF NOT EXISTS dypos.work_orders (
        id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        branch_id VARCHAR(64) REFERENCES dypos.branches(id),
        customer_id VARCHAR(64) REFERENCES dypos.customers(id),
        order_number VARCHAR(128) UNIQUE NOT NULL,
        status VARCHAR(64) DEFAULT 'draft', -- draft, in_progress, quality_check, ready, delivered
        priority VARCHAR(32) DEFAULT 'normal',
        items JSONB DEFAULT '[]'::jsonb,
        estimated_completion TIMESTAMP WITH TIME ZONE,
        actual_completion TIMESTAMP WITH TIME ZONE,
        assigned_to VARCHAR(64) REFERENCES dypos.users(id),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Production / Manufacturing (Bakeries, Small Factories)
      CREATE TABLE IF NOT EXISTS dypos.production_orders (
        id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        product_id VARCHAR(64) REFERENCES dypos.products(id),
        quantity NUMERIC(12, 3) NOT NULL,
        status VARCHAR(32) DEFAULT 'pending',
        recipe_id VARCHAR(64),
        start_date TIMESTAMP WITH TIME ZONE,
        end_date TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Serial / IMEI Tracking (Electronics)
      CREATE TABLE IF NOT EXISTS dypos.product_serials (
        serial_number VARCHAR(128) PRIMARY KEY,
        product_id VARCHAR(64) REFERENCES dypos.products(id),
        tenant_id VARCHAR(64) REFERENCES dypos.tenants(id),
        status VARCHAR(32) DEFAULT 'available', -- available, sold, reserved, defective
        purchase_invoice_id VARCHAR(64),
        sale_invoice_id VARCHAR(64),
        warranty_expiry DATE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Batch / Expiry Tracking (Pharma, Food)
      CREATE TABLE IF NOT EXISTS dypos.product_batches (
        id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        product_id VARCHAR(64) REFERENCES dypos.products(id),
        tenant_id VARCHAR(64) REFERENCES dypos.tenants(id),
        batch_number VARCHAR(128) NOT NULL,
        expiry_date DATE NOT NULL,
        production_date DATE,
        quantity_on_hand NUMERIC(12, 3) DEFAULT 0,
        cost_price NUMERIC(12, 2),
        is_active BOOLEAN DEFAULT true,
        UNIQUE (tenant_id, product_id, batch_number)
      );

      -- Staff Commissions
      CREATE TABLE IF NOT EXISTS dypos.commissions (
        id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        user_id VARCHAR(64) REFERENCES dypos.users(id),
        invoice_id VARCHAR(64) REFERENCES dypos.invoices(id),
        amount NUMERIC(12, 2) NOT NULL,
        status VARCHAR(32) DEFAULT 'pending', -- pending, paid
        paid_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Subscriptions & Memberships (Gyms, SaaS)
      CREATE TABLE IF NOT EXISTS dypos.subscriptions (
        id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        customer_id VARCHAR(64) REFERENCES dypos.customers(id),
        plan_id VARCHAR(64), -- Can link to products
        status VARCHAR(32) DEFAULT 'active', -- active, expired, paused, cancelled
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        auto_renew BOOLEAN DEFAULT true,
        last_payment_date DATE,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 14. Enterprise Triggers & Logic (SAP/Oracle Level)
    await client.query(`
      -- A. Strict Accounting Balance Guard
      CREATE OR REPLACE FUNCTION dypos.fn_check_journal_balance() 
      RETURNS TRIGGER AS $$
      DECLARE
        v_diff NUMERIC;
      BEGIN
        SELECT SUM(debit) - SUM(credit) INTO v_diff
        FROM dypos.journal_lines
        WHERE journal_entry_id = NEW.id;

        IF v_diff != 0 THEN
          RAISE EXCEPTION 'Unbalanced Journal Entry: Difference is %', v_diff;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      -- B. Automated Inventory FIFO Costing
      CREATE OR REPLACE FUNCTION dypos.fn_apply_fifo_costing()
      RETURNS TRIGGER AS $$
      DECLARE
        v_qty_to_cost NUMERIC := NEW.quantity;
        v_batch RECORD;
        v_cost_applied NUMERIC := 0;
      BEGIN
        -- Only for sales/outgoing
        IF NEW.type != 'sale' THEN RETURN NEW; END IF;

        FOR v_batch IN 
          SELECT id, quantity_on_hand, cost_price 
          FROM dypos.product_batches 
          WHERE product_id = NEW.product_id AND quantity_on_hand > 0
          ORDER BY expiry_date ASC, created_at ASC
        LOOP
          IF v_qty_to_cost <= 0 THEN EXIT; END IF;

          IF v_batch.quantity_on_hand >= v_qty_to_cost THEN
            UPDATE dypos.product_batches 
            SET quantity_on_hand = quantity_on_hand - v_qty_to_cost 
            WHERE id = v_batch.id;
            v_cost_applied := v_cost_applied + (v_qty_to_cost * v_batch.cost_price);
            v_qty_to_cost := 0;
          ELSE
            UPDATE dypos.product_batches 
            SET quantity_on_hand = 0 
            WHERE id = v_batch.id;
            v_cost_applied := v_cost_applied + (v_batch.quantity_on_hand * v_batch.cost_price);
            v_qty_to_cost := v_qty_to_cost - v_batch.quantity_on_hand;
          END IF;
        END LOOP;

        NEW.cost_basis := v_cost_applied;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      -- C. Advanced Audit Engine (JSON Shadowing)
      CREATE TABLE IF NOT EXISTS dypos.audit_shadow (
        id BIGSERIAL PRIMARY KEY,
        table_name TEXT NOT NULL,
        row_id TEXT NOT NULL,
        action TEXT NOT NULL,
        old_data JSONB,
        new_data JSONB,
        changed_by VARCHAR(64),
        changed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE OR REPLACE FUNCTION dypos.fn_audit_shadow_trigger()
      RETURNS TRIGGER AS $$
      BEGIN
        IF (TG_OP = 'UPDATE') THEN
          INSERT INTO dypos.audit_shadow(table_name, row_id, action, old_data, new_data, changed_by)
          VALUES (TG_TABLE_NAME, OLD.id::text, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), current_setting('app.current_user_id', true));
          RETURN NEW;
        ELSIF (TG_OP = 'DELETE') THEN
          INSERT INTO dypos.audit_shadow(table_name, row_id, action, old_data, changed_by)
          VALUES (TG_TABLE_NAME, OLD.id::text, 'DELETE', to_jsonb(OLD), current_setting('app.current_user_id', true));
          RETURN OLD;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // --- VIEWS (aligned with invoices/invoice_items + unit_price canonical schema) ---

    await client.query(`
      CREATE OR REPLACE VIEW dypos.v_daily_sales AS
      SELECT
        tenant_id,
        branch_id,
        DATE(created_at) as sale_date,
        COUNT(id) as total_transactions,
        SUM(total) as gross_revenue,
        SUM(tax) as total_vat
      FROM dypos.invoices
      WHERE status = 'completed'
      GROUP BY tenant_id, branch_id, DATE(created_at);
    `);

    await client.query(`
      CREATE OR REPLACE VIEW dypos.v_inventory_valuation AS
      SELECT
        tenant_id,
        id as product_id,
        name,
        stock,
        cost,
        (stock * cost) as valuation_cost,
        (stock * unit_price) as valuation_retail
      FROM dypos.products
      WHERE is_active = true;
    `);

    await client.query(`
      CREATE OR REPLACE VIEW dypos.v_product_sales_analytics AS
      SELECT
        i.tenant_id,
        p.id as product_id,
        p.name,
        p.category,
        SUM(ii.quantity) as units_sold,
        SUM(ii.total) as total_revenue
      FROM dypos.invoice_items ii
      JOIN dypos.invoices i ON ii.invoice_id = i.id
      JOIN dypos.products p ON ii.product_id = p.id
      WHERE i.status = 'completed'
      GROUP BY i.tenant_id, p.id, p.name, p.category;
    `);

    await client.query(`
      CREATE OR REPLACE VIEW dypos.v_branch_performance AS
      SELECT
        b.tenant_id,
        b.id as branch_id,
        b.name as branch_name,
        COUNT(i.id) as tx_count,
        SUM(i.total) as total_sales,
        SUM(i.tax) as total_tax
      FROM dypos.branches b
      LEFT JOIN dypos.invoices i ON b.id = i.branch_id AND i.status = 'completed'
      GROUP BY b.tenant_id, b.id, b.name;
    `);

    // Backwards-compat aliases for legacy table names used by older clients/reports
    await client.query(`
      DROP VIEW IF EXISTS dypos.v_legacy_transactions CASCADE;
      CREATE OR REPLACE VIEW dypos.v_legacy_transactions AS
        SELECT id, tenant_id, invoice_number, branch_id, cashier_name,
               customer_name, subtotal, tax, discount, total, payment_method,
               status, items, timestamp
        FROM dypos.invoices;
    `);

    // --- SEEDING CORE DATA ---
    //
    // Ordering matters: the tenant, its branch, and the currencies must exist
    // before anything that carries their foreign keys. The old bootstrap seeded
    // demo users against a branch (`b1`) that no longer exists, which aborted
    // startup on the foreign key. Live identities come from
    // scripts/release-credentials.ts instead.

    await client.query(`
      INSERT INTO dypos.tenants (id, name, owner_company, brand_name, commercial_reg, tax_number, country_code, base_currency, plan)
      VALUES (
        'royal-global-hq',
        'مجموعة رويال العالمية للتجارة والتوزيع',
        'شركة المنافذ الذكية للبرمجيات (Smart Ports Software)',
        'DyPOS Enterprise Cloud & Edge',
        '1010892741',
        '302194857200003',
        'SA',
        'SAR',
        'enterprise_saas'
      )
      ON CONFLICT (id) DO NOTHING;
    `);

    await client.query(`
      INSERT INTO dypos.branches (id, tenant_id, name, city, location)
      VALUES ('rg-branch-hq', 'royal-global-hq', 'الفرع الرئيسي (المقر العام)', 'صنعاء', 'المقر العام')
      ON CONFLICT (id) DO NOTHING;
    `);

    await client.query(`
      INSERT INTO dypos.currencies (code, name, symbol, exchange_rate)
      VALUES 
        ('SAR', 'ريال سعودي', 'ر.س', 1.0),
        ('USD', 'دولار أمريكي', '$', 3.75),
        ('YER', 'ريال يمني', 'ر.ي', 0.015),
        ('AED', 'درهم إماراتي', 'د.إ', 1.02)
      ON CONFLICT (code) DO NOTHING;
    `);

    await client.query(`
      INSERT INTO dypos.restaurant_areas (id, branch_id, name)
      VALUES 
        ('a1', 'rg-branch-hq', 'صالة العائلات'),
        ('a2', 'rg-branch-hq', 'صالة الأفراد'),
        ('a3', 'rg-branch-hq', 'الطلبات الخارجية')
      ON CONFLICT (id) DO NOTHING;
    `);

    await client.query(`
      INSERT INTO dypos.countries (code, name, name_ar, phone_code, currency_code)
      VALUES 
        ('SA', 'Saudi Arabia', 'المملكة العربية السعودية', '+966', 'SAR'),
        ('YE', 'Yemen', 'الجمهورية اليمنية', '+967', 'YER'),
        ('AE', 'United Arab Emirates', 'الإمارات العربية المتحدة', '+971', 'AED')
      ON CONFLICT (code) DO NOTHING;
    `);

    await client.query(`
      INSERT INTO dypos.cities (country_code, name, name_ar)
      VALUES 
        ('SA', 'Riyadh', 'الرياض'),
        ('SA', 'Jeddah', 'جدة'),
        ('YE', 'Sanaa', 'صنعاء'),
        ('YE', 'Aden', 'عدن')
      ON CONFLICT DO NOTHING;
    `);

    // --- SEEDING CAPABILITIES (Commerce OS Registry) ---
    await client.query(`
      INSERT INTO dypos.capabilities (id, name_en, name_ar, description, icon, category)
      VALUES 
        ('product', 'Product Catalog', 'كتالوج المنتجات', 'Basic product and inventory management', 'Package', 'core'),
        ('service', 'Services Catalog', 'كتالوج الخدمات', 'Manage services, sessions and tasks', 'Scissors', 'core'),
        ('customer', 'Customer Management', 'إدارة العملاء', 'CRM and customer profiles', 'Users', 'core'),
        ('measurement', 'Measurement Engine', 'محرك المقاسات', 'Professional measurement tracking for tailoring and medical', 'Ruler', 'specialized'),
        ('appointment', 'Appointment Booking', 'نظام الحجوزات', 'Schedule services, staff and resources', 'Calendar', 'specialized'),
        ('work_order', 'Work Order Engine', 'نظام أوامر العمل', 'Track complex jobs from start to delivery', 'ClipboardList', 'workflow'),
        ('production', 'Production Engine', 'محرك الإنتاج', 'Manage recipes and production orders', 'Factory', 'workflow'),
        ('batch_expiry', 'Batch & Expiry', 'التشغيلات والصلاحية', 'FEFO/FIFO tracking for pharma and food', 'Clock', 'specialized'),
        ('serial_imei', 'Serial & IMEI', 'الأرقام التسلسلية', 'Individual item tracking for electronics', 'Hash', 'specialized'),
        ('weighing', 'Scale Integration', 'الربط مع الميزان', 'Direct scale reading and variable weight barcodes', 'Scale', 'specialized'),
        ('commission', 'Commission Engine', 'نظام العمولات', 'Calculate staff and agent commissions', 'Percent', 'core'),
        ('delivery', 'Delivery Management', 'إدارة التوصيل', 'Last-mile delivery and driver tracking', 'Truck', 'workflow'),
        ('subscription', 'Subscription Engine', 'نظام الاشتراكات', 'Recurring billing and membership access', 'Repeat', 'specialized'),
        ('workflow', 'Workflow Engine', 'محرك سير العمل', 'Custom business process states and transitions', 'GitMerge', 'core'),
        ('ledger', 'Enterprise Ledger', 'المحاسبة المؤسسية', 'Double-entry accounting and financial reports', 'Book', 'core')
      ON CONFLICT (id) DO NOTHING;
    `);

    // --- SEEDING TENANT CAPABILITIES -----------------------------------------
    /*
     * The grant table was created but never populated, so
     * /api/db/tenant/profile reported an empty capability set and every
     * capability-gated screen was hidden. This grants the HQ tenant the full
     * registry once.
     *
     * ══ WHY `DO NOTHING` AND NOT `DO UPDATE` ════════════════════════════════
     * This block runs on EVERY boot. With
     *
     *     ON CONFLICT (tenant_id, capability_id) DO UPDATE SET is_enabled = TRUE
     *
     * a capability an administrator had deliberately DISABLED for this tenant
     * was switched back on the next restart of the process — silently, with no
     * audit entry, and with no way for the operator to keep it off. A licence
     * narrowing made by a human was undone by a boot.
     *
     * `DO NOTHING` makes the seed mean what a seed should mean: establish what
     * is missing, never reassert what exists. Narrowing stays under the control of
     * whoever narrowed it.
     *
     * Tenants created through `provision-tenant.ts` get their own grants and are
     * untouched by this line — the literal below is the bootstrap tenant only.
     */
    await client.query(`
      INSERT INTO dypos.tenant_capabilities (tenant_id, capability_id, is_enabled)
      SELECT 'royal-global-hq', c.id, TRUE
      FROM dypos.capabilities c
      ON CONFLICT (tenant_id, capability_id) DO NOTHING
    `);

    console.log('✅ Global Standard Database Schema (Neon PostgreSQL) initialized successfully.');

    // --- EXECUTE PRODUCTION SQL MIGRATIONS ---
    try {
      await runProductionMigrations(client);
    } catch (migErr: any) {
      console.warn('⚠️ Warning: Some production migrations failed (might be due to conflicts):', migErr.message);
    }

    return { success: true, message: 'Full ERP/POS schema initialized successfully' };
  } catch (err) {
    console.error('❌ Failed to initialize standard database schema:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function runProductionMigrations(client: pg.PoolClient) {
  const migrations = [
    'dypos_schema_complement_v24_v40.sql',
    'dypos_final_global_production_complement_v41_v100.sql',
    'dypos_database_engine_v101_v130.sql'
  ];

  for (const file of migrations) {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
      const sql = fs.readFileSync(filePath, 'utf8');
      try {
        console.log(`🚀 Executing production migration: ${file}...`);
        await client.query(sql);
        console.log(`✅ Production migration ${file} applied.`);
      } catch (err: any) {
        console.error(`❌ Failed to apply production migration ${file}:`, err.message);
      }
    }
  }
}
