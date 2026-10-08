import dotenv from 'dotenv';
import { PG_SSL } from '../server/neonDb.ts';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pg from 'pg';
import { hashPassword, ALGO, ITERATIONS } from '../server/passwords.js';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: PG_SSL,
  max: 1,
});

const TENANT = 'royal-global-hq';
export const VERSION = '1.4.0';

/**
 * Temporary bootstrap credentials.
 *
 * These exist for exactly one purpose: letting each operator sign in ONCE so
 * the forced rotation screen can capture a real password of their choosing.
 * Both accounts carry must_change_password = TRUE, so no business screen is
 * reachable until the temporary value has been replaced.
 *
 * The values are NEVER stored here. They are read from the environment so they
 * cannot end up committed in source control, in a log, or in a screenshot:
 *
 *   DYPOS_BOOTSTRAP_YACOUB='<value>'     npm run release:credentials
 *   DYPOS_BOOTSTRAP_ABDULRAHMAN='<value>' npm run release:credentials
 *
 * A random value is generated and printed once when the variables are absent —
 * capture it from that single run and store it in the password manager.
 */
function loadBootstrap(): Array<{ username: string; password: string; branch: string }> {
  const accounts = [
    { username: 'yacoub', env: 'DYPOS_BOOTSTRAP_YACOUB' },
    { username: 'abdulrahman', env: 'DYPOS_BOOTSTRAP_ABDULRAHMAN' },
  ];

  const generated: string[] = [];
  const resolved = accounts.map(({ username, env }) => {
    let password = process.env[env];
    if (!password) {
      // 20 chars from an alphabet with no ambiguous glyphs.
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
      password = Array.from(
        { length: 20 }, () => alphabet[crypto.randomInt(alphabet.length)],
      ).join('');
      generated.push(password);
    }
    return { username, password, branch: 'rg-branch-hq' };
  });

  if (generated.length) {
    console.log(
      `\n⚠️  ${generated.length} temporary password(s) were generated because the ` +
      `environment variables were not set.\n    Capture them now — they are not stored anywhere ` +
      `elsewhere and cannot be recovered.\n` +
      generated.map((p, i) => `    ${accounts[i].username}: ${p}`).join('\n') + '\n',
    );
  }

  return resolved;
}

async function main() {
  const BOOTSTRAP = loadBootstrap();

  const sql = fs.readFileSync(
    path.join(process.cwd(), 'server', 'migrations', 'v135_release_auth.sql'), 'utf8',
  );
  await pool.query(sql);
  console.log('✔ v135 schema applied');

  // ---- Set the two operator credentials with a forced rotation ----------
  for (const b of BOOTSTRAP) {
    const c = await hashPassword(b.password);
    await pool.query(
      `UPDATE dypos.users
       SET password_hash = $2, password_salt = $3, password_iterations = $4,
           password_algo = $5, password_updated_at = NOW(),
           must_change_password = TRUE,
           failed_attempts = 0, locked_until = NULL,
           reset_token_hash = NULL, reset_token_expires = NULL
       WHERE tenant_id = $1 AND username = $6`,
      [TENANT, c.hash, c.salt, c.iterations, ALGO, b.username],
    );
  }
  console.log(`✔ ${BOOTSTRAP.length} operator credentials set (forced rotation on)`);

  // The seed passwords must never remain in any inactive row either.
  await pool.query(
    `UPDATE dypos.users
     SET password_hash = NULL, password_salt = NULL, is_active = FALSE
     WHERE tenant_id = $1 AND is_active = FALSE AND password_hash IN ('dypos','')`,
    [TENANT],
  );

  // ---- Stamp the release ----------------------------------------------
  await pool.query(`UPDATE dypos.app_releases SET is_current = FALSE WHERE is_current`);
  await pool.query(
    `INSERT INTO dypos.app_releases (version, notes, deployed_by, is_current)
     VALUES ($1, $2, $3, TRUE)
     ON CONFLICT (version) DO UPDATE SET
       notes = EXCLUDED.notes, build_at = NOW(), is_current = TRUE`,
    [VERSION,
      'White design system, sector gating, RBAC, Yemen dual-zone ledger, decision KPI engine, PBKDF2 credentials',
      'yacoub'],
  );
  console.log(`✔ release ${VERSION} stamped`);

  // ---- Print the credential sheet -------------------------------------
  const sheet = await pool.query(
    `SELECT u.username, u.name, u.role, u.is_active, u.must_change_password,
            u.password_algo, u.password_iterations, u.branch_id, b.name AS branch_name
     FROM dypos.users u
     LEFT JOIN dypos.branches b ON b.id = u.branch_id
     WHERE u.tenant_id = $1
     ORDER BY u.username`,
    [TENANT],
  );

  const tenant = await pool.query(
    `SELECT id, name, commercial_reg, tax_number FROM dypos.tenants WHERE id = $1`,
    [TENANT],
  );

  console.log('\n' + '='.repeat(72));
  console.log('  بيانات الاعتماد — Credential Sheet');
  console.log('='.repeat(72));
  console.log(`\n  المشترك (Tenant)   : ${tenant.rows[0].name}`);
  console.log(`  رقم المشترك       : ${tenant.rows[0].id}`);
  console.log(`  السجل التجاري     : ${tenant.rows[0].commercial_reg}`);
  console.log(`  الرقم الضريبي     : ${tenant.rows[0].tax_number}`);
  console.log(`  الإصدار           : ${VERSION}\n`);

  for (const r of sheet.rows) {
    const temp = BOOTSTRAP.find((b) => b.username === r.username);
    console.log(`  ── ${r.name} ──`);
    console.log(`  المستخدم     : ${r.username}`);
    console.log(`  الدور        : ${r.role}`);
    console.log(`  الفرع        : ${r.branch_name ?? '(لم يُعيَّن)'}`);
    // The value itself is never echoed here: it is either in the operator's
    // environment or was printed once at generation time above.
    console.log(`  كلمة المرور  : ${r.is_active && temp ? '⟨مُدخلة من متغير البيئة⟩' : '(معطّل)'}`);
    console.log(`  التشفير      : ${r.password_algo ?? 'legacy'} × ${r.password_iterations ?? '-'}`);
    console.log(`  تغيير إلزامي : ${r.must_change_password ? 'نعم — سيُطلب عند أول دخول' : 'لا'}`);
    console.log('');
  }

  console.log('='.repeat(72));
  console.log('  ⚠  كلمتا المرور مؤقتتان. سلّمهما للمشغّل عبر قناة آمنة فقط.');
  console.log('     سيطلب النظام تغيير كل منهما فوراً بعد أول دخول،');
  console.log('     ولا تُفتح أي شاشة أعمال قبل إتمام ذلك.');
  console.log('='.repeat(72));

  await pool.end();
}

main().catch(async (e) => {
  console.error('FAILED:', e.message);
  await pool.end();
  process.exit(1);
});