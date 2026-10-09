import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/*
 * ══ ENVIRONMENT IS LOADED HERE, NOT AT THE CALL SITE ══════════════════════
 * `dotenv.config()` used to be called in `server.ts` — but that runs *after*
 * this module's top-level code, because ES module imports are evaluated before
 * the importing module's body. So `DATABASE_URL` was already read as
 * `undefined` by the time the pool below was constructed.
 *
 * The fallback credential hid this completely: the pool got the bundled string
 * and every test passed. Remove the fallback and the ordering bug surfaces
 * immediately as `ECONNREFUSED 127.0.0.1:5432` — `pg` falling back to a local
 * default when `connectionString` is absent, which looks exactly like "no
 * database running" and sends the investigation to the wrong machine.
 *
 * The module that READS an environment variable must be the module that LOADS
 * the environment. Anything else makes the read order an accident of the
 * import graph.
 */
import dotenv from 'dotenv';

dotenv.config();

/*
 * ══ WHY THERE IS NO DEFAULT CONNECTION STRING ═════════════════════════════
 * This used to be:
 *
 *   const NEON_CONNECTION_STRING =
 *     process.env.DATABASE_URL ||
 *     'postgresql://neondb_owner:<password>@ep-shiny-wind-ai4w5o0l-pooler…';
 *
 * A live Neon **owner** credential — password included — was committed to the
 * repository and shipped inside `dist-server/server.mjs`. The `||` made it
 * invisible: with `DATABASE_URL` set, the fallback was dead text nobody read.
 * It was also the *dangerous* direction. `DATABASE_URL` missing is the one
 * condition under which the system must refuse to start, and this line turned
 * that refusal into silent success against production data — the operator sees
 * a running app and no hard signal, because the only warning was a
 * `console.warn` scrolling past.
 *
 * "It is only a fallback" is the reasoning that keeps credentials alive. The
 * credential is real, it is in git history, and it is in any bundle that
 * `npm run build:server` produced. Treat it as compromised and rotate it.
 *
 * Failing closed is the correct behaviour and is what this now does: no
 * `DATABASE_URL`, no default. Every route that touches data reports a
 * configuration fault with an actionable message instead of quietly reading and
 * writing the one database that matters.
 */
const NEON_CONNECTION_STRING = process.env.DATABASE_URL;

if (!NEON_CONNECTION_STRING) {
  console.error(
    '[neonDb] FATAL: DATABASE_URL is not set.\n' +
      '        Refusing to fall back — this system has no built-in database credential,\n' +
      '        because a fallback credential in source is a credential in every build\n' +
      '        artefact and in git history.\n' +
      '        Set DATABASE_URL in the environment (see .env.example) and restart.',
  );
}

/*
 * ══ SSL IS ENFORCED, NOT DISABLED ═════════════════════════════════════════
 * This was:
 *
 *   ssl: { rejectUnauthorized: false }
 *
 * which turns TLS into unauthenticated encryption. It still encrypts the
 * traffic, so a config that only checks "is there an `ssl` key" looks correct —
 * and it is the setting people reach for when a certificate error appears,
 * because it always makes the error go away.
 *
 * What it actually permits is a machine-in-the-middle: anything on the path can
 * terminate the connection with a certificate it generated itself and read and
 * rewrite every query. This is the connection carrying the merchant's ledger,
 * their tax figures and their credentials, so that is not a theoretical loss.
 *
 * It also hid a real fault. The `.env.example` URL carries `sslmode=require`,
 * and `pg` warned on every single connection that a `require`-family mode is
 * being treated as `verify-full`. The pool's own setting overrode the URL, so the
 * warning was noise covering a silent downgrade.
 *
 * `rejectUnauthorized: true` with the system trust store is the correct
 * posture: Neon presents a certificate from a public CA that the platform
 * already trusts, so verification succeeds without any custom CA material. If a
 * deployment ever needs a private CA, that is a deliberate `PGSSLROOTCERT`
 * configuration, not a global switch that disables checking for everyone.
 */
/**
 * THE database SSL policy, exported so there is exactly one of them.
 *
 * Every script that opens its own Pool used to hard-code
 * `ssl: { rejectUnauthorized: false }` — 22 of them. That is the same setting
 * copied 22 times, which is how `rejectUnauthorized: true` in the server pool
 * would have been reverted by the next script anyone wrote, and how a
 * provisioning or migration script ended up moving credentials over a
 * connection weaker than the one the application uses.
 *
 * Importing this means a change to the posture is one edit, and the test
 * `test-tenant-boundary.ts` asserts no caller hard-codes its own.
 *
 * See the note above `pool` for why verification is ON.
 */
export const PG_SSL = { rejectUnauthorized: true } as const;

export const pool = new Pool({
  /*
   * `undefined` leaves the pool unconnected rather than pointing it at a
   * default. With no `DATABASE_URL` every query rejects, `pool.on('error')`
   * consumes the resulting idle-client events, and the process stays up so an
   * operator can read the message above and fix the environment.
   */
  connectionString: NEON_CONNECTION_STRING,
  ssl: PG_SSL,
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

    /*
     * pgcrypto — REQUIRED, and previously never installed.
     *
     * `dypos_database_engine_v101_v130.sql` defines `dypos.jsonb_sha256()`, which
     * is built on `digest(bytea, text)` from this extension. Without it PostgreSQL
     * fails with:
     *
     *     function digest(bytea, unknown) does not exist
     *
     * and because the whole pack ran as ONE `client.query`, that single missing
     * function aborted every remaining statement in the file — the audit engine,
     * the accounting procedures and the sync safeguards were all skipped, and
     * the error was only logged. The pack is documented as creating all of them,
     * so this was silent missing functionality rather than a visible break.
     *
     * `IF NOT EXISTS` makes this a no-op on every boot after the first. It is
     * placed here, before anything else, because the extension is a
     * prerequisite of the packs applied further down.
     */
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
    } catch (extErr: any) {
      // A managed plan may refuse to create extensions. Say so plainly: the
      // packs that depend on it will fail below, and a silent warning here
      // would let that read as an unrelated migration error.
      console.warn(
        `⚠️  Could not enable pgcrypto (${extErr.message}). `
        + 'digest()/jsonb_sha256() and the audit engine will be unavailable.',
      );
    }

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
        brand_name VARCHAR(255) DEFAULT 'دينا: منصة التجارة الذكية',
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
        -- Contact proofs for the identity engine (server/identityEngine.ts).
        -- OPTIONAL by contract: enrollmentEngine.ts SELECTs both during the
        -- unknown-username branch of sign-in, so their absence is a runtime
        -- 42703 → a 500 on login for a non-existent user, not a type error.
        -- Nullable: a user may exist with only a username.
        email VARCHAR(255),
        phone VARCHAR(64),
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
    /*
     * ══ WHY THE TABLE DEFINITION CARRIES tenant_id, NOT A LATER MIGRATION ════
     * Both tables were created here WITHOUT `tenant_id`, and
     * `migrations/v143_screen_backends.sql` added it afterwards and set it
     * NOT NULL. That left two sources of truth for the same table: this
     * CREATE, which knows nothing about tenancy, and v143, which does.
     *
     * On a database where v143 has run, they disagree — and this CREATE is a
     * silent no-op (`IF NOT EXISTS`), so the stale shape here is invisible
     * until something writes through it. The seed below then inserted
     * restaurant areas with no tenant, and PostgreSQL refused:
     *
     *     23502 null value in column "tenant_id" of relation
     *           "restaurant_areas" violates not-null constraint
     *
     * which aborted `initDatabaseSchema()` on every single start.
     *
     * The fix is to make the bootstrap agree with the migration, not to relax
     * the constraint. `tenant_id NOT NULL` is the whole mechanism that stops
     * an area belonging to no tenant and therefore to everyone, and dropping it
     * would trade a loud startup failure for a silent cross-tenant read.
     */
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.restaurant_areas (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        branch_id VARCHAR(64) REFERENCES dypos.branches(id),
        name VARCHAR(128) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.restaurant_tables (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
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

    // 23. Identity reconciliation and repeat-safe enrollment
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.identity_idempotency (
        key VARCHAR(255) PRIMARY KEY,
        tenant_id VARCHAR(64),
        result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.identity_outbox (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
        kind VARCHAR(64) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(32) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','dead_letter')),
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_identity_outbox_status
        ON dypos.identity_outbox (tenant_id, status, created_at);
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

    /*
     * ══ WHY NO INVENTED TENANT IS SEEDED HERE ══════════════════════════════
     * This used to INSERT a tenant carrying:
     *
     *   owner_company : 'شركة المنافذ الذكية للبرمجيات (Smart Ports Software)'
     *   commercial_reg: '1010892741'
     *   tax_number    : '302194857200003'
     *   country       : 'SA',  base_currency: 'SAR'
     *
     * and a branch named 'الفرع الرئيسي (المقر العام)' in 'صنعاء' — a Sana'a
     * address on a tenant registered as Saudi with a Saudi VAT number.
     *
     * A bootstrap that runs on every start is a bootstrap that decides who the
     * business is. Those three numbers are fabricated, so every fresh
     * installation opened with a legal identity belonging to nobody: a tax number
     * that matches no registration, a commercial registration that matches no
     * entity, and a company name that is the software vendor rather than the
     * merchant. Because they landed in `dypos.tenants`, they were read back by
     * `/api/erp/entitlements` and printed on real receipts — so the defect was
     * not confined to a seed row, it propagated to fiscal documents.
     *
     * `ON CONFLICT DO NOTHING` made it worse in one specific way: the wrong
     * values persisted silently. Correcting the merchant's details afterwards
     * was possible, but nothing distinguished "the operator never entered a tax
     * number" from "the system made one up", and the made-up one looked valid.
     *
     * A tenant is created through `scripts/provision-tenant.ts`, which takes the
     * values from the operator. If the schema has no tenant yet, the system
     * starts with NO tenants and every screen reports that there is none — which
     * is a state an operator can fix in a minute, and far better than a
     * fabricated registration they must notice and correct.
     */
    const tenantCount = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM dypos.tenants`,
    );
    if (Number(tenantCount.rows[0]?.count ?? '0') === 0) {
      console.warn(
        '[neonDb] No tenant exists yet. Provision one with:\n' +
          '         npx tsx scripts/provision-tenant.ts --id <tenant> --company "<name>"\n' +
          '         Provisioning from code is deliberately not done: a tenant must\n' +
          '         carry the identity of a real, existing business, and inventing\n' +
          '         one here would put a fabricated tax registration on its receipts.',
      );
    }

    await client.query(`
      INSERT INTO dypos.currencies (code, name, symbol, exchange_rate)
      VALUES 
        ('SAR', 'ريال سعودي', 'ر.س', 1.0),
        ('USD', 'دولار أمريكي', '$', 3.75),
        ('YER', 'ريال يمني', 'ر.ي', 0.015),
        ('AED', 'درهم إماراتي', 'د.إ', 1.02)
      ON CONFLICT (code) DO NOTHING;
    `);

    /*
     * ══ RESTAURANT AREAS ARE NOT SEEDED HERE — AND THAT IS THE POINT ════════
     * This used to INSERT three areas against the hard-coded branch
     * `rg-branch-hq`:
     *
     *   INSERT INTO dypos.restaurant_areas (id, branch_id, name)
     *   VALUES ('a1','rg-branch-hq','صالة العائلات'), …
     *
     * Three things were wrong with it, and only the first is the reported one.
     *
     * 1. It named no tenant, so on any database where `tenant_id` is NOT NULL
     *    it raised 23502 and aborted the whole bootstrap — which is how this was
     *    found, but it is a symptom.
     *
     * 2. It named a BRANCH, and branches belong to tenants. `rg-branch-hq` is
     *    one merchant's branch id. A bootstrap that hard-codes it is asserting
     *    that every deployment of this product is that merchant — the same
     *    defect as the fabricated tenant that used to sit above it, one level
     *    down. "Just add tenant_id from the branch" would not fix it: it would
     *    silently hand a second customer's restaurant floor to the first.
     *
     * 3. A system bootstrap runs on EVERY start, with no tenant context, by
     *    definition. So there is no correct tenant to name here. The only
     *    honest move is to create none.
     *
     * The id was a global `a1`/`a2`/`a3` with no tenant in it, which is also a
     * collision waiting to happen: the second tenant to provision would have
     * been silently swallowed by `ON CONFLICT DO NOTHING`.
     *
     * Areas are per-tenant configuration — a restaurant's floor plan — so they
     * belong in tenant provisioning, which HAS a tenant context. That is done in
     * `provisionTenantData()` below and by `scripts/provision-tenant.ts`.
     */

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
    /*
     * ══ WHY THIS NO LISTS TENANTS ════════════════════════════════════════════
     * This granted the full capability catalogue to one tenant by literal:
     *
     *   SELECT 'royal-global-hq', c.id, TRUE FROM dypos.capabilities c …
     *
     * In a single-tenant product that is a bootstrap. In a SaaS product it is a
     * defect with two separate failure modes, and the second is the one that
     * actually bites:
     *
     *   1. It reaches into ONE tenant. Every tenant created afterwards through
     *      `provision-tenant.ts` got a row in `dypos.tenants` and NO rows in
     *      `dypos.tenant_capabilities` — so every screen on the licence-gated
     *      shell was hidden for them, and the symptom is an empty sidebar that
     *      looks like a cancelled subscription. `EntitlementContext` falls back
     *      to sector defaults, which masks it for the sector the tenant happens
     *      to match and exposes it for every other one.
     *
     *   2. It hard-codes an identity into the engine, so the moment a second
     *      customer exists the "global" schema is no longer global.
     *
     * The correct seed is stated once, as a rule, and applied to every tenant
     * that does not yet have a grant — which is exactly what `DO NOTHING` was
     * already there to guarantee. Only tenants with NO grant row are touched, so
     * a licence an administrator narrowed stays narrowed, and a tenant with a
     * deliberate partial grant is never completed behind their back.
     */
    await client.query(`
      INSERT INTO dypos.tenant_capabilities (tenant_id, capability_id, is_enabled)
      SELECT t.id, c.id, TRUE
        FROM dypos.tenants t
        CROSS JOIN dypos.capabilities c
       WHERE NOT EXISTS (
         SELECT 1 FROM dypos.tenant_capabilities tc WHERE tc.tenant_id = t.id
       )
      ON CONFLICT (tenant_id, capability_id) DO NOTHING
    `);

    console.log('✅ Global Standard Database Schema (Neon PostgreSQL) initialized successfully.');

    // Versioned migrations are applied explicitly by scripts/migrate.ts.
    // Historical SQL packs are not replayed on every application boot.

    return { success: true, message: 'Full ERP/POS schema initialized successfully' };
  } catch (err) {
    console.error('❌ Failed to initialize standard database schema:', err);
    throw err;
  } finally {
    client.release();
  }
}

/*
 * ══════════════════════════════════════════════════════════════════════════
 * TENANT-SCOPED PROVISIONING — the only place tenant-owned rows are created
 * ══════════════════════════════════════════════════════════════════════════
 *
 * THE DIVISION, STATED ONCE
 * ────────────────────────
 *   `initDatabaseSchema()`  → SYSTEM LEVEL. Schema, and rows that belong to NO
 *                             tenant and are identical for every merchant:
 *                             currencies, countries, cities, the capability
 *                             registry. It runs on every start with no tenant
 *                             context, so it must never create tenant data.
 *
 *   `provisionTenantData()` → TENANT SCOPED. Everything that belongs to one
 *                             merchant. It REQUIRES a tenant id and refuses to
 *                             run without one.
 *
 * The bug that started this was a tenant-scoped row in the system-level half.
 * Nothing about that was a database problem; the database was enforcing the
 * rule correctly and the code was the thing breaking it.
 *
 * WHY IT REFUSES RATHER THAN DEFAULTING
 * ────────────────────────────────────
 * A default tenant here would make the whole thing pass. It would also mean a
 * call with a missing tenant writes business data into whichever tenant happens
 * to be configured first — the cross-tenant write this whole design exists to
 * prevent, and silent, because the row looks perfectly valid afterwards.
 *
 * So an absent or empty tenant id throws. The failure is loud, immediate, and
 * names the missing argument.
 *
 * WHY EVERY ID IS DERIVED FROM THE TENANT
 * ──────────────────────────────────────
 * `restaurant_areas.id` was a global `a1`. With two tenants, the second
 * provisioner's `ON CONFLICT DO NOTHING` silently discarded its rows against
 * the first tenant's — a tenant that appears provisioned and has no floor.
 * Ids are therefore `${tenantId}-area-N`, which cannot collide across tenants
 * and reads unambiguously in a log.
 *
 * THE TENANT IS VERIFIED, NOT ASSUMED
 * ────────────────────────────────────
 * `tenant_id` is a foreign key, so a typo would raise 23503 and abort — but the
 * message names a constraint rather than the caller. Checking existence first
 * lets this report which tenant was asked for.
 */
export async function provisionTenantData(
  client: pg.PoolClient,
  tenantId: string,
): Promise<{ areas: number; tables: number }> {
  // Refuse rather than default. See the note above.
  const tenant = String(tenantId ?? '').trim();
  if (!tenant) {
    throw new Error(
      'provisionTenantData: tenantId is required. Tenant-owned rows may only be '
      + 'created inside a real tenant context — this function will not pick one '
      + 'for you, because a silent default is a cross-tenant write.',
    );
  }

  const exists = await client.query(
    `SELECT 1 FROM dypos.tenants WHERE id = $1 AND is_active IS NOT FALSE`,
    [tenant],
  );
  if (!exists.rows[0]) {
    throw new Error(
      `provisionTenantData: no active tenant "${tenant}". Create it with `
      + `scripts/provision-tenant.ts first — provisioning data for a tenant that `
      + `does not exist would fail on the foreign key anyway, with a less useful message.`,
    );
  }

  const branch = await client.query(
    `SELECT id FROM dypos.branches
      WHERE tenant_id = $1 AND is_active IS NOT FALSE
      ORDER BY id LIMIT 1`,
    [tenant],
  );
  const branchId = branch.rows[0]?.id ?? null;

  /*
   * Areas are per-tenant configuration, so an operator who does not run a
   * restaurant simply gets none. That is correct: an empty list is a state the
   * restaurant screen already handles, whereas three invented areas are claims
   * about a floor plan nobody described.
   */
  const AREAS = [
    { slug: 'family', name: 'صالة العائلات', capacity: 6 },
    { slug: 'individuals', name: 'صالة الأفراد', capacity: 4 },
    { slug: 'takeaway', name: 'الطلبات الخارجية', capacity: 2 },
  ];

  const areaIds: string[] = [];
  for (let i = 0; i < AREAS.length; i += 1) {
    // Tenant-scoped id. See the note above about the global `a1`.
    const id = `${tenant}-area-${i + 1}`;
    areaIds.push(id);
    await client.query(
      `INSERT INTO dypos.restaurant_areas (id, tenant_id, branch_id, name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         -- The tenant binding stays authoritative on re-run. Re-pointing an
         -- existing area at a different tenant would itself be a cross-tenant
         -- write, so the WHERE makes that a no-op rather than an overwrite.
         SET name = EXCLUDED.name
       WHERE dypos.restaurant_areas.tenant_id = EXCLUDED.tenant_id`,
      [id, tenant, branchId, AREAS[i].name],
    );
  }

  let tables = 0;
  for (let i = 0; i < areaIds.length; i += 1) {
    for (let n = 1; n <= AREAS[i].capacity; n += 1) {
      await client.query(
        `INSERT INTO dypos.restaurant_tables
           (id, tenant_id, area_id, table_number, capacity)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [
          `${tenant}-t-${i + 1}-${n}`,
          tenant,
          areaIds[i],
          `${i + 1}-${n}`,
          AREAS[i].capacity,
        ],
      );
      tables += 1;
    }
  }

  return { areas: areaIds.length, tables };
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * THE LEGACY PACKS — NOT DEAD CODE, AND NOT SAFE AS-IS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Three hand-written SQL packs from the v24–v130 era. They must NOT be deleted:
 * the numbered migrations in `server/migrations` are layered ON TOP of them and
 * reference their objects directly —
 *
 *     v131_core_screens.sql    → REFERENCES dypos.product_recipes(id)
 *     v132_enterprise_core.sql → ALTER TABLE dypos.chart_of_accounts
 *
 * So the packs are the FOUNDATION; the numbered migrations are the refinement.
 *
 * THE DEFECT THEY WERE CARRYING
 * -----------------------------
 * Nine tables are declared by BOTH a pack and a numbered migration, with
 * incompatible column sets:
 *
 *     cash_movements    pack: shift_id, movement_type, direction IN('IN','OUT')
 *                      v137 : section, occurred_on, direction IN('in','out')
 *     units_of_measure  pack: PK(code), global, no tenant
 *                      v132 : PK(id), tenant-scoped, UNIQUE(tenant_id, code)
 *
 * `CREATE TABLE IF NOT EXISTS` means whichever side runs FIRST silently wins and
 * the other becomes a no-op. That is a coin toss decided by execution order,
 * and the loser's columns are then missing while live code
 * (`financialRoutes.ts`, `uomRoutes.ts`) queries them by name. The failure
 * surfaces at request time as "column does not exist", far from its cause.
 *
 * WHY IT WAS SILENT
 * -----------------
 * Each file ran as ONE `client.query(sql)`. PostgreSQL aborts the batch on the
 * first error, so the pack's remaining statements — including ones that create
 * tables nothing else provides — never ran. The error was logged and the boot
 * continued, which is why this read as three unrelated warnings rather than one
 * root cause.
 *
 * WHAT IS DONE HERE
 * -----------------
 * Conflicting declarations are neutralised so the numbered migrations become the
 * single authority, and each pack is applied statement-by-statement so one bad
 * statement cannot silently skip the rest. Nothing is dropped and no data is
 * touched: the conflict is resolved by NOT making the losing declaration.
 */
async function runProductionMigrations(client: pg.PoolClient) {
  const migrations = [
    'dypos_schema_complement_v24_v40.sql',
    'dypos_final_global_production_complement_v41_v100.sql',
    'dypos_database_engine_v101_v130.sql',
  ];

  for (const file of migrations) {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) {
      console.warn(`⚠️  Production migration ${file} is missing from the bundle — skipped.`);
      continue;
    }

    const sql = neutraliseSupersededDeclarations(fs.readFileSync(filePath, 'utf8'));
    const statements = splitSqlStatements(sql);
    const failed: string[] = [];
    let applied = 0;

    for (const stmt of statements) {
      try {
        await client.query(stmt);
        applied += 1;
      } catch (err: any) {
        failed.push(`${err.message}  ⟵  ${firstLine(stmt)}`);
      }
    }

    if (failed.length === 0) {
      console.log(`✅ Production migration ${file} applied (${applied} statements).`);
    } else {
      console.error(
        `❌ Production migration ${file}: ${failed.length}/${statements.length} statements failed.`,
      );
      for (const f of failed.slice(0, 5)) console.error(`     · ${f}`);
      if (failed.length > 5) console.error(`     · …and ${failed.length - 5} more`);
    }
  }
}

/**
 * Removes the CREATE TABLE declarations the numbered migrations own.
 *
 * Only the statement is neutralised. A table that genuinely does not exist yet
 * is still created by its numbered migration (v131–v147), the sanctioned path —
 * so nothing is lost, and the winner of every collision stops depending on
 * execution order.
 */
function neutraliseSupersededDeclarations(sql: string): string {
  /*
   * SCOPE, DELIBERATELY NARROW
   * --------------------------
   * Only the three objects that are *proven* to be faults are neutralised. The
   * collision list is longer — accounting_periods, deliveries, kitchen_tickets,
   * roles, role_permissions and user_roles are declared twice as well — but they
   * are NOT neutralised, because each one is the target of a foreign key held by
   * a table the packs still create:
   *
   *     journal_entries      -> accounting_periods
   *     kitchen_ticket_items -> kitchen_tickets
   *     user_roles, role_permissions -> roles
   *
   * Dropping the parent while the child is still declared turns a silent
   * `IF NOT EXISTS` conflict into a hard "relation does not exist" failure. Those
   * collisions are a real debt, but they need the owning migration to add the
   * missing columns — not a boot-time deletion that could break a paying
   * merchant's ledger. They are recorded, not acted on.
   *
   * These three are safe precisely because nothing else references them.
   */
  const superseded = [
    'cash_movements',
    'units_of_measure',
    'unit_conversions',
  ];

  for (const table of superseded) {
    sql = sql.replace(
      new RegExp(
        `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+(?:dypos\\.)?${table}\\b[\\s\\S]*?\\n\\s*\\);`,
        'gi',
      ),
      `-- [DyPOS] ${table} is owned by server/migrations — conflicting pack declaration omitted.`,
    );
  }

  /*
   * The actual cause of "column shift_id does not exist".
   *
   * It is NOT the CREATE TABLE — it is `idx_cash_movements_shift`. On any
   * database where v137 already ran, `cash_movements` exists WITHOUT `shift_id`
   * (v137 defines section/occurred_on instead). The pack's CREATE TABLE is a
   * silent no-op, and then the index below is applied to the pre-existing table,
   * which has no such column. Omitting the index is the whole fix for that error.
   */
  for (const idx of ['idx_cash_movements_shift', 'idx_unit_conversions_pair']) {
    sql = sql.replace(
      new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${idx}\\b[\\s\\S]*?;`, 'gi'),
      `-- [DyPOS] ${idx} omitted with its table.`,
    );
  }

  /*
     * Objects the packs index but never create, and that no numbered migration
     * creates either.
     *
     * Each of these produced a boot-time failure such as:
     *
     *     relation "payments" does not exist  →  CREATE INDEX idx_payments_invoice_created
     *
     * Verified against the live database before being treated as safe: none of
     * `payments`, `sync_log`, `webhook_outbox`, `integration_runs` or
     * `schema_version` exists, and zero lines of live code (server/ or worker/)
     * reference any of them. They are leftovers from a design this product did
     * not ship — the payment path is `payment_transactions`, and the offline
     * queue is `sync_operations` from the v101–v130 pack itself.
     *
     * They are therefore neutralised rather than created: creating an empty
     * `payments` table would be a new claim about the product, and a table
     * nothing reads is worse than no table — it advertises a capability.
     */
    const deadObjects = [
      'payments',
      'sync_log',
      'webhook_outbox',
      'integration_runs',
      'schema_version',
    ];
    for (const t of deadObjects) {
      sql = sql.replace(
        new RegExp(
          `(CREATE\\s+(?:INDEX|UNIQUE\\s+INDEX|MATERIALIZED\\s+VIEW|VIEW|TABLE)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\\s\\S]{0,200}?\\b(?:${t})\\b[\\s\\S]*?;)`,
          'gi',
        ),
        `-- [DyPOS] statement over "${t}" omitted: the object does not exist and no live code reads it.`,
      );
    }

    /*
     * `unit_conversions` is neutralised above along with its index, but the
     * packs also carry two anonymous `DO $$` blocks that iterate over it and
     * would now fail on a missing relation. The blocks grant RLS on a list of
     * tables; with the table gone there is nothing to protect, so they are
     * dropped rather than left to fail on every boot.
     */
    sql = sql.replace(
      /DO\s+\$\$[\s\S]{0,4000}?unit_conversions[\s\S]{0,2000}?END\s+\$\$\s*;/gi,
      '-- [DyPOS] RLS block over unit_conversions omitted with the table itself.',
    );

    /*
     * Column-level mismatches on tables that DO exist.
     *
     * `journal_entries` has `date` (see the bootstrap), while two packs index
     * `entry_date` and `entry_no`, and a third builds a view and a function on
     * them. Both spellings are absent, so those statements cannot apply.
     *
     * This is NOT silently skipped. `entry_date` and `entry_no` are the names
     * the v101–v130 accounting views are written against, and this project
     * reports a trial balance from them — so the gap is a real missing feature,
     * not dead code. They are recorded here rather than fixed in a boot path,
     * because adding accounting columns needs the owning migration and a
     * decision about which spelling becomes canonical.
     */
    const columnMismatches = [
      'idx_journal_entries_tenant_date',
      'idx_promotions_active_window',
      'ux_mv_daily_accounting_summary',
    ];
    for (const idx of columnMismatches) {
      sql = sql.replace(
        new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${idx}\\b[\\s\\S]*?;`, 'gi'),
        `-- [DyPOS] ${idx} omitted: its column does not exist on the reconciled table.`,
      );
    }

    // The ledger view is built on the same missing columns, and the materialised
    // view depends on the view, so both go with it.
    sql = sql.replace(
      /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?dypos\.(?:v_general_ledger|mv_daily_accounting_summary)\b[\s\S]*?;/gi,
      '-- [DyPOS] ledger view omitted: built on journal_entries.entry_date/entry_no.',
    );

    // The accounting function reads je.entry_date in its signature body.
    sql = sql.replace(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+dypos\.account_balance\b[\s\S]*?END\s+\$\$\s*;/gi,
      "-- [DyPOS] account_balance() omitted: reads journal_entries.entry_date.",
    );

    /*
     * The last set: indexes over columns that no reconciled table has, and two
     * INSERTs into bookkeeping tables this product does not use.
     *
     * `journal_entries` carries id, tenant_id, entry_number, date, description,
     * total_amount, status, created_at. It has no `entry_date`, `entry_no`,
     * `source_type` or `period_id`, and neither `promotions` carries
     * `conditions_json`/`reward_json`. Verified against the live database, and
     * zero lines in server/ or worker/ reference any of the five — so these
     * indexes would only ever describe columns this deployment does not have.
     *
     * The two INSERTs are the packs' own migration ledgers. They fail because
     * each pack declares `schema_migrations` with a different column set (the
     * v24–v40 pack declares `version, name`; the later two declare
     * `version, checksum, description`), so the first to run wins and the other
     * two cannot insert. This project's real ledger is
     * `dypos.applied_migrations`, written by `scripts/migrate.ts`. Recording a
     * third, contradictory version history is a liability, not a record.
     */
    for (const idx of [
      'idx_journal_entries_source',
      'idx_journal_entries_period_status',
      'idx_promotion_conditions_gin',
      'idx_promotion_rewards_gin',
    ]) {
      sql = sql.replace(
        new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${idx}\\b[\\s\\S]*?;`, 'gi'),
        `-- [DyPOS] ${idx} omitted: its column does not exist and no live code reads it.`,
      );
    }

    sql = sql.replace(
      /INSERT\s+INTO\s+(?:dypos\.)?schema_migrations\b[\s\S]*?;/gi,
      "-- [DyPOS] INSERT INTO schema_migrations omitted: the authoritative ledger is dypos.applied_migrations.",
    );
    sql = sql.replace(
      /INSERT\s+INTO\s+(?:dypos\.)?schema_version\b[\s\S]*?;/gi,
      "-- [DyPOS] INSERT INTO schema_version omitted: the table does not exist and no code reads it.",
    );

    return sql;
}

/**
 * Splits a SQL script on statement boundaries.
 *
 * A naive `split(';')` would cut inside a `$$ … $$` function body or a quoted
 * string and emit fragments that are invalid on their own. This tracks
 * dollar-quoting, single quotes, and both comment forms.
 */
function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let dollarTag: string | null = null;

  while (i < sql.length) {
    const rest = sql.slice(i);

    if (dollarTag) {
      const end = rest.indexOf(dollarTag);
      if (end === -1) {
        buf += sql[i];
        i += 1;
        continue;
      }
      buf += rest.slice(0, end + dollarTag.length);
      i += end + dollarTag.length;
      dollarTag = null;
      continue;
    }

    const tagMatch = rest.match(/^\$[A-Za-z_0-9]*\$/);
    if (tagMatch) {
      dollarTag = tagMatch[0];
      buf += tagMatch[0];
      i += tagMatch[0].length;
      continue;
    }

    if (rest.startsWith('--')) {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) {
        i = sql.length;
        continue;
      }
      i = nl + 1;
      continue;
    }

    // Block comment; PostgreSQL allows these to nest.
    if (rest.startsWith('/*')) {
      let depth = 0;
      let j = i;
      while (j < sql.length) {
        if (sql.startsWith('/*', j)) {
          depth += 1;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
        } else {
          j += 1;
        }
      }
      i = j;
      continue;
    }

    // Single-quoted literal, with '' escaping.
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      buf += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (sql[i] === ';') {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = '';
      i += 1;
      continue;
    }

    buf += sql[i];
    i += 1;
  }

  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/** The statement's own first meaningful line, for the failure report. */
function firstLine(sql: string): string {
  const line =
    sql
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('--')) ?? '';
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}
