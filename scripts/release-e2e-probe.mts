// release-e2e-probe.mts — post-deploy end-to-end proof against the REAL
// production URL (`https://dyposcloud.smartportssoft.com`) backed by the SAME
// Neon database this script uses for its baseline and its cleanup.
//
// What it proves, in order:
//   1. the public surface (health, release, branches, HTML shell) answers 200;
//   2. sign-in on the domain works, and a wrong password is still a 401;
//   3. the three catalogue READ routes answer 200 with the agreed envelope —
//      `/api/db/products` must carry `items` AND `products` AND `count`,
//      because the edge used to answer `{products}` only and the production
//      inventory list rendered empty while the page looked healthy;
//   4. the three WRITE routes EXIST on the edge (they were 404) and refuse a
//      malformed body with 400 WITHOUT writing a row;
//   5. the writes themselves: a server-allocated EAN-13 barcode, a
//      `JRN-YYYY-NNNNNN` entry that posts two ledger legs, and a
//      `PO-YYYY-NNNNNN` order whose lines land in `purchase_order_lines`;
//   6. an unauthenticated write is refused (401), so opening the route did not
//      open the data;
//   7. everything written here is DELETED again and the table counts return to
//      the exact baseline captured in step 0 — the one thing that makes a live
//      probe safe to run against production.
//
// What it deliberately does NOT claim: `document_sequences.next_value` moves
// forward for every number it allocates. That is irreversible by design — a
// consumed document number is never reissued — and is the honest cost of a
// real end-to-end write on the real edge.
//
// Usage: npx tsx scripts/release-e2e-probe.mts
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const LIVE = process.env.DYPOS_PROBE_URL || 'https://dyposcloud.smartportssoft.com';
const USERNAME = process.env.DYPOS_PROBE_USER || 'admin';
const PASSWORD = process.env.DYPOS_PROBE_PASS || 'admin123';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  connectionTimeoutMillis: 25000,
});

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

async function call(
  path: string, method: string, token?: string, body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(LIVE + path, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {},
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text: text.slice(0, 300) };
}

const COUNTS = {
  products: 'SELECT count(*)::int AS n FROM dypos.products',
  journals: 'SELECT count(*)::int AS n FROM dypos.journal_entries',
  ledger: 'SELECT count(*)::int AS n FROM dypos.ledger',
  pos: 'SELECT count(*)::int AS n FROM dypos.purchase_orders',
  poLines: 'SELECT count(*)::int AS n FROM dypos.purchase_order_lines',
} as const;

async function baseline(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [k, q] of Object.entries(COUNTS)) {
    out[k] = (await pool.query(q)).rows[0].n as number;
  }
  return out;
}

const created = { product: '', journal: '', po: '' };

async function cleanup(): Promise<boolean> {
  try {
    if (created.po) {
      await pool.query('DELETE FROM dypos.purchase_order_lines WHERE po_id = $1', [created.po]);
      await pool.query('DELETE FROM dypos.purchase_orders WHERE id = $1', [created.po]);
    }
    if (created.journal) {
      await pool.query('DELETE FROM dypos.ledger WHERE journal_id = $1', [created.journal]);
      await pool.query('DELETE FROM dypos.journal_entries WHERE id = $1', [created.journal]);
    }
    if (created.product) {
      await pool.query('DELETE FROM dypos.products WHERE id = $1', [created.product]);
    }
    return true;
  } catch (e) {
    console.error('cleanup error', e);
    return false;
  }
}

async function main() {
  const before = await baseline();
  console.log('\n0. baseline counts');
  console.log('   ' + JSON.stringify(before));

  let token = '';
  try {
    console.log('\n1. public surface');
    const health = await call('/api/health', 'GET');
    check('GET /api/health → 200', health.status === 200, 'status=' + health.status);
    const rel = await call('/api/release', 'GET');
    check('GET /api/release → 200', rel.status === 200, 'status=' + rel.status);
    const version = rel.json?.current?.version ?? rel.json?.version ?? rel.json?.release?.version;
    check('release carries a version', Boolean(version), JSON.stringify(rel.json).slice(0, 120));
    const br = await call('/api/branches', 'GET');
    check('GET /api/branches → 200 with rows', br.status === 200 && (br.json?.items?.length > 0), 'status=' + br.status);
    const home = await call('/', 'GET');
    check('GET / → 200 html shell', home.status === 200 && /doctype|<div id=|<script/i.test(home.text), 'status=' + home.status);

    console.log('\n2. sign-in on the domain');
    const bad = await call('/api/auth/login', 'POST', undefined, { username: USERNAME, password: 'definitely-not-the-password' });
    check('wrong password → 401', bad.status === 401, 'status=' + bad.status + ' ' + bad.text);
    const ok = await call('/api/auth/login', 'POST', undefined, { username: USERNAME, password: PASSWORD });
    check('correct password → 200 with session', ok.status === 200 && Boolean(ok.json?.session), 'status=' + ok.status + ' ' + ok.text);
    token = ok.json?.session?.token || ok.json?.token || '';
    check('session token present', token.length > 20, 'len=' + token.length);
    if (!token) throw new Error('no token — cannot continue');

    console.log('\n3. catalogue reads (the envelope the client needs)');
    const products = await call('/api/db/products', 'GET', token);
    check('GET products → 200', products.status === 200, 'status=' + products.status + ' ' + products.text);
    check('products carries `items` (edge used to omit it)',
      Array.isArray(products.json?.items),
      'keys=' + Object.keys(products.json || {}).join(','));
    check('products carries `products` (old clients keep working)', Array.isArray(products.json?.products));
    check('products carries a numeric `count`', typeof products.json?.count === 'number', 'type=' + typeof products.json?.count);
    check('items are the same rows as products',
      (products.json?.items?.length ?? -1) === (products.json?.products?.length ?? -1));

    const journals = await call('/api/db/journal-entries', 'GET', token);
    check('GET journal-entries → 200 (was 404)', journals.status === 200, 'status=' + journals.status + ' ' + journals.text);
    check('journal-entries returns an array', Array.isArray(journals.json?.items ?? journals.json?.journalEntries));

    const pos = await call('/api/db/purchase-orders', 'GET', token);
    check('GET purchase-orders → 200', pos.status === 200, 'status=' + pos.status + ' ' + pos.text);
    check('purchase-orders returns an array', Array.isArray(pos.json?.items ?? pos.json?.purchaseOrders));

    console.log('\n4. malformed writes are refused with 400 and write nothing');
    const badProduct = await call('/api/db/products', 'POST', token, { price: 10 });
    check('product without a name → 400', badProduct.status === 400, 'status=' + badProduct.status);
    const badJournal = await call('/api/db/journal-entries', 'POST', token, { description: '', amount: -1 });
    check('empty journal → 400', badJournal.status === 400, 'status=' + badJournal.status);
    const badPo = await call('/api/db/purchase-orders', 'POST', token, { items: [] });
    check('empty purchase order → 400', badPo.status === 400, 'status=' + badPo.status);
    const afterBad = await baseline();
    check('refused posts wrote nothing',
      afterBad.products === before.products && afterBad.journals === before.journals && afterBad.pos === before.pos,
      JSON.stringify({ before, afterBad }));

    console.log('\n5. real writes through the edge, then read back');
    const stamp = Date.now().toString(36).toUpperCase();
    const madeProduct = await call('/api/db/products', 'POST', token, {
      name: `إثبات نشر ${stamp}`,
      category: 'إثبات النشر',
      price: 12.5,
      cost: 7,
      stock: 3,
      minStock: 1,
      unit: 'قطعة',
    });
    check('POST product → 201', madeProduct.status === 201, 'status=' + madeProduct.status + ' ' + madeProduct.text);
    const p = madeProduct.json?.item;
    created.product = p?.id || '';
    check('product id returned', Boolean(created.product), madeProduct.text);
    check('barcode allocated server-side as EAN-13 (628…, 13 digits)',
      /^[68]\d{12}$/.test(String(p?.barcode || '')), 'barcode=' + p?.barcode);

    const madeJournal = await call('/api/db/journal-entries', 'POST', token, {
      description: `إثبات نشر قيد ${stamp}`,
      amount: 100,
      date: new Date().toISOString().slice(0, 10),
      status: 'draft',
      accountDebit: 'الصندوق الرئيسي (1101)',
      accountCredit: 'مبيعات المحل (4101)',
    });
    check('POST journal-entry → 201', madeJournal.status === 201, 'status=' + madeJournal.status + ' ' + madeJournal.text);
    const j = madeJournal.json?.item;
    created.journal = j?.id || '';
    check('journal number issued by the server (JRN-YYYY-NNNNNN)',
      /^JRN-\d{4}-\d{6}$/.test(String(j?.entryNumber || '')), 'entryNumber=' + j?.entryNumber);

    const madePo = await call('/api/db/purchase-orders', 'POST', token, {
      supplierName: `مورّد الإثبات ${stamp}`,
      items: [{ productName: `صنف الإثبات ${stamp}`, quantity: 2, unitCost: 50 }],
      totalAmount: 100,
      status: 'draft',
    });
    check('POST purchase-order → 201', madePo.status === 201, 'status=' + madePo.status + ' ' + madePo.text);
    const po = madePo.json?.item;
    created.po = po?.id || '';
    check('PO number issued by the server (PO-YYYY-NNNNNN)',
      /^PO-\d{4}-\d{6}$/.test(String(po?.poNumber || '')), 'poNumber=' + po?.poNumber);

    console.log('\n6. read back what was just written');
    const rereadProducts = await call('/api/db/products', 'GET', token);
    check('the new product is in `items`',
      (rereadProducts.json?.items || []).some((r: any) => r.id === created.product));
    const rereadJ = await call('/api/db/journal-entries', 'GET', token);
    const jRows: any[] = rereadJ.json?.items || rereadJ.json?.journalEntries || [];
    check('the new journal entry is readable', jRows.some((r) => r.id === created.journal),
      'rows=' + jRows.length);
    const rereadPo = await call('/api/db/purchase-orders', 'GET', token);
    const poRows: any[] = rereadPo.json?.items || rereadPo.json?.purchaseOrders || [];
    const myPo = poRows.find((r) => r.id === created.po);
    check('the new purchase order is readable with its lines',
      Boolean(myPo) && Array.isArray(myPo?.items) && myPo.items.length === 1,
      JSON.stringify(myPo).slice(0, 200));

    if (created.journal) {
      const legs = await pool.query('SELECT count(*)::int AS n FROM dypos.ledger WHERE journal_id = $1', [created.journal]);
      check('the journal posted BOTH ledger legs', legs.rows[0].n === 2, 'legs=' + legs.rows[0].n);
    }
    if (created.po) {
      const lines = await pool.query('SELECT count(*)::int AS n FROM dypos.purchase_order_lines WHERE po_id = $1', [created.po]);
      check('the PO wrote its line into purchase_order_lines', lines.rows[0].n === 1, 'lines=' + lines.rows[0].n);
    }

    console.log('\n7. the new routes are still behind auth');
    const anonP = await call('/api/db/products', 'POST', undefined, { name: 'غير مصرح' });
    check('anonymous POST product → 401', anonP.status === 401, 'status=' + anonP.status);
    const anonJ = await call('/api/db/journal-entries', 'POST', undefined, { description: 'x', amount: 1 });
    check('anonymous POST journal → 401', anonJ.status === 401, 'status=' + anonJ.status);
    const anonPo = await call('/api/db/purchase-orders', 'POST', undefined, { items: [{ productName: 'x', quantity: 1, unitCost: 1 }] });
    check('anonymous POST purchase-order → 401', anonPo.status === 401, 'status=' + anonPo.status);

    console.log('\n8. the auth_events row for this sign-in exists (v152 constraint)');
    const ev = await pool.query(
      `SELECT count(*)::int AS n FROM dypos.auth_events
        WHERE username = $1 AND created_at > now() - interval '10 minutes'`,
      [USERNAME.toLowerCase()],
    );
    check('sign-in attempts were audited', ev.rows[0].n > 0, 'rows=' + ev.rows[0].n);
  } finally {
    console.log('\n9. cleanup');
    const cleaned = await cleanup();
    check('throwaway rows deleted', cleaned);
    const after = await baseline();
    const same = Object.keys(COUNTS).every((k) => after[k] === before[k]);
    check('table counts returned to baseline', same,
      'before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));
    if (!same) {
      console.error('  !! PROBE LEFT DATA BEHIND: ' + JSON.stringify({ created, before, after }));
    }
    const seq = await pool.query(
      `SELECT doc_type, prefix, next_value FROM dypos.document_sequences
        WHERE tenant_id = 'royal-global-hq'
          AND doc_type IN ('barcode','journal','purchase_order')
        ORDER BY 1`,
    ).catch(() => ({ rows: [] as any[] }));
    if (seq.rows.length) console.log('  (document_sequences advanced, as a real write must): ' + JSON.stringify(seq.rows));
    await pool.end();
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('probe crashed:', e);
  process.exit(1);
});
