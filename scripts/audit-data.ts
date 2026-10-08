/**
 * Audits real data in the dypos schema: row counts per table and which of
 * them are still empty. Run with: npx tsx scripts/audit-data.ts
 */
import dotenv from 'dotenv';
import { PG_SSL } from '../server/neonDb.ts';
import fs from 'fs';
import path from 'path';
import pg from 'pg';

dotenv.config();

const LOG = path.resolve('audit.log');
const lines: string[] = [];
const out = (s: string) => {
  lines.push(s);
  fs.writeFileSync(LOG, lines.join('\n'));
};

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: PG_SSL,
  max: 1,
  connectionTimeoutMillis: 20000,
});

try {
  const { rows } = await pool.query(
    `SELECT c.relname AS table_name,
            c.reltuples::bigint AS est_rows
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'dypos' AND c.relkind = 'r'
     ORDER BY c.relname`,
  );

  // Exact counts — reltuples is only an estimate.
  const counts: Record<string, number> = {};
  for (const t of rows) {
    const r = await pool.query(`SELECT count(*)::int AS n FROM dypos."${t.table_name}"`);
    counts[t.table_name] = r.rows[0].n;
  }

  const filled = Object.entries(counts).filter(([, n]) => n > 0);
  const empty = Object.entries(counts).filter(([, n]) => n === 0);

  out(`=== dypos schema: ${Object.keys(counts).length} tables ===`);
  out(`filled: ${filled.length}   empty: ${empty.length}\n`);

  out('--- TABLES WITH DATA ---');
  for (const [name, n] of filled.sort((a, b) => b[1] - a[1])) {
    out(`  ${String(n).padStart(6)}  ${name}`);
  }

  out('\n--- EMPTY TABLES ---');
  for (const [name] of empty) out(`        0  ${name}`);

  // Sample real rows so we can see whether this is genuine business data.
  out('\n--- SAMPLE ROWS ---');
  for (const t of ['tenants', 'products', 'customers', 'employees', 'invoices', 'services', 'delivery_zones']) {
    const r = await pool.query(`SELECT * FROM dypos."${t}" LIMIT 2`);
    out(`\n[${t}] rows=${counts[t] ?? 0}`);
    r.rows.forEach((row: any) => {
      const brief: Record<string, any> = {};
      for (const [k, v] of Object.entries(row).slice(0, 7)) {
        brief[k] = typeof v === 'string' && v.length > 46 ? v.slice(0, 46) + '…' : v;
      }
      out('  ' + JSON.stringify(brief));
    });
  }
// Which tenant owns the data? A mismatch here is why screens look empty.
  out('\n--- TENANT DISTRIBUTION ---');
  const t = await pool.query(
    `SELECT c.relname AS t,
            (SELECT tenant_id::text FROM dypos."${'products'}" LIMIT 1)
     FROM pg_class c LIMIT 0`,
  ).catch(() => ({ rows: [] }));

  for (const tbl of ['products', 'invoices', 'customers', 'employees', 'services',
                     'delivery_zones', 'appointments', 'commissions', 'production_orders']) {
    const r = await pool.query(
      `SELECT tenant_id, count(*)::int AS n FROM dypos."${tbl}" GROUP BY 1 ORDER BY 2 DESC`,
    );
    if (r.rows.length) {
      out(`  ${tbl.padEnd(20)} ` + r.rows.map((x: any) => `${x.tenant_id}=${x.n}`).join(', '));
    }
  }
} catch (e: any) {
  out('AUDIT FAIL: ' + e.message);
} finally {
  await pool.end();
}
