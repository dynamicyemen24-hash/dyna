/**
 * End-to-end API smoke test against a running DyPOS server.
 * Exercises CRUD + transactions on all seven core screens.
 * Run with: npx tsx scripts/apitest.ts
 */
import fs from 'fs';
import path from 'path';

const BASE = process.env.API_BASE || 'http://';
const TENANT = 'royal-global-hq';
const LOG = path.resolve('apitest.log');
const lines: string[] = [];

const log = (s: string) => {
  lines.push(s);
  fs.writeFileSync(LOG, lines.join('\n'));
};

async function api(method: string, endpoint: string, body?: unknown) {
  const res = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': TENANT },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (ok) {
    pass++;
    log(`  PASS  ${name}${info ? ' — ' + info : ''}`);
  } else {
    fail++;
    log(`  FAIL  ${name}${info ? ' — ' + info : ''}`);
  }
};

async function main() {
  log(`DyPOS API E2E — ${new Date().toISOString()}`);
  log(`base: ${BASE}\n`);

  log('[health]');
  const h = await api('GET', '/api/db/health');
  check('GET /api/db/health', h.status === 200, `status=${h.status}`);

  log('[products]');
  const p = await api('GET', '/api/db/products');
  check('GET /api/db/products', p.status === 200 && Array.isArray(p.json.products));
  const products = p.json.products || [];
  const productId = products[0]?.id;
  if (!products.length) log('  !! no products — FK tests skipped');

  // ---- 1. services ----
  log('[1] services');
  const sCreate = await api('POST', '/api/db/services', {
    name: 'خدمة اختبار — قص شعر',
    nameEn: 'Test Haircut',
    category: 'عناية',
    basePrice: 75,
    durationMinutes: 45,
    taxRate: 15,
  });
  check('POST services', sCreate.status === 201, JSON.stringify(sCreate.json).slice(0, 120));
  const serviceId = sCreate.json?.item?.id;

  const sList = await api('GET', '/api/db/services');
  check('GET services', sList.status === 200 && sList.json.items.length > 0,
    `count=${sList.json?.count}`);

  const sUpd = await api('PUT', `/api/db/services/${serviceId}`, { basePrice: 90 });
  check('PUT services', sUpd.status === 200 && Number(sUpd.json.item.base_price) === 90);

  // ---- 2. appointments ----
  log('[2] appointments');
  const start = new Date(Date.now() + 3600_000).toISOString();
  const aCreate = await api('POST', '/api/db/appointments', {
    serviceId,
    customerName: 'عميل اختبار',
    customerPhone: '0500000000',
    scheduledStart: start,
    price: 90,
  });
  check('POST appointments', aCreate.status === 201,
    JSON.stringify(aCreate.json).slice(0, 140));
  const apptId = aCreate.json?.item?.id;
  const it = aCreate.json?.item;
  const derivedEndOk =
    it?.scheduled_end &&
    new Date(it.scheduled_end).getTime() - new Date(it.scheduled_start).getTime() ===
      45 * 60000;
  check('appointment end derived from service duration', !!derivedEndOk);

  const aList = await api('GET', '/api/db/appointments');
  check('GET appointments', aList.status === 200 && aList.json.items.length > 0,
    `count=${aList.json?.count}`);

  const aStatus = await api('PATCH', `/api/db/appointments/${apptId}/status`, {
    status: 'confirmed',
  });
  check('PATCH appointment status',
    aStatus.status === 200 && aStatus.json.item.status === 'confirmed');

  const aBad = await api('PATCH', `/api/db/appointments/${apptId}/status`, { status: 'nope' });
  check('appointment rejects invalid status (400)', aBad.status === 400);

  // ---- 3. production ----
  log('[3] production');
  const prList = await api('GET', '/api/db/production');
  check('GET production orders', prList.status === 200);

  const recList = await api('GET', '/api/db/production/recipes');
  check('GET production recipes (BOM)', recList.status === 200,
    `count=${recList.json?.count}`);

  if (productId && recList.json?.items?.length) {
    const recipe = recList.json.items[0];
    const prCreate = await api('POST', '/api/db/production', {
      productId: recipe.product_id || productId,
      recipeId: recipe.id,
      quantity: 5,
      status: 'in_progress',
    });
    check('POST production order', prCreate.status === 201,
      JSON.stringify(prCreate.json).slice(0, 120));
    const prodId = prCreate.json?.item?.id;

    const prDone = await api('POST', `/api/db/production/${prodId}/complete`, {
      completedQty: 5,
    });
    check('POST production complete (FEFO consume + receive)',
      prDone.status === 200 && prDone.json.item?.status === 'completed',
      JSON.stringify(prDone.json?.consumed || prDone.json).slice(0, 160));
  } else {
    log('  SKIP production completion (no BOM recipes seeded)');
  }

  // ---- 4. batches ----
  log('[4] batches');
  if (productId) {
    const bCreate = await api('POST', '/api/db/batches', {
      productId,
      batchNumber: 'BATCH-TEST-001',
      quantity: 100,
      cost: 12.5,
      expiryDate: '2027-01-31',
      productionDate: '2026-01-01',
    });
    check('POST batches', bCreate.status === 201,
      JSON.stringify(bCreate.json).slice(0, 120));
    const batchId = bCreate.json?.item?.id;

    const bList = await api('GET', '/api/db/batches');
    check('GET batches', bList.status === 200 && bList.json.items.length > 0,
      `count=${bList.json?.count}`);
    check('batch exposes days_to_expiry',
      bList.json?.items?.some((x: any) => x.days_to_expiry !== undefined));

    const bDel = await api('DELETE', `/api/db/batches/${batchId}`);
    check('DELETE batches', bDel.status === 200);
  } else {
    log('  SKIP batches (no products)');
  }

  // ---- 5. serials ----
  log('[5] serials');
  if (productId) {
    const serCreate = await api('POST', '/api/db/serials', {
      productId,
      serialNumber: 'SN-TEST-0001',
      imei: '352099001761481',
      warrantyEnd: '2027-10-01',
    });
    check('POST serials', serCreate.status === 201,
      JSON.stringify(serCreate.json).slice(0, 120));
    const serId = serCreate.json?.item?.id;

    const serSell = await api('PATCH', `/api/db/serials/${serId}`, { status: 'sold' });
    check('PATCH serial -> sold',
      serSell.status === 200 && serSell.json.item.status === 'sold' &&
      !!serSell.json.item.sold_at);

    const serList = await api('GET', '/api/db/serials');
    check('GET serials', serList.status === 200);

    const serDel = await api('DELETE', `/api/db/serials/${serId}`);
    check('DELETE serials', serDel.status === 200);
  } else {
    log('  SKIP serials (no products)');
  }

  // ---- 6. commissions ----
  log('[6] commissions');
  const now = new Date();
  const cCreate = await api('POST', '/api/db/commissions', {
    employeeId: 'emp1',
    employeeName: 'موظف اختبار',
    baseAmount: 10000,
    rate: 1.5,
  });
  check('POST commissions', cCreate.status === 201,
    JSON.stringify(cCreate.json).slice(0, 120));
  check('commission amount auto-calculated',
    Number(cCreate.json?.item?.amount) === 150,
    `amount=${cCreate.json?.item?.amount}`);
  const commId = cCreate.json?.item?.id;

  const cSettle = await api('POST', '/api/db/commissions/settle', { ids: [commId] });
  check('POST commissions/settle',
    cSettle.status === 200 && cSettle.json.items[0]?.status === 'paid');

  const cList = await api('GET', `/api/db/commissions?year=${now.getFullYear()}`);
  check('GET commissions with totals',
    cList.status === 200 && cList.json.totals !== undefined,
    JSON.stringify(cList.json?.totals));

  // ---- 7. delivery ----
  log('[7] delivery');
  const zList = await api('GET', '/api/db/delivery-zones');
  check('GET delivery zones', zList.status === 200 && zList.json.items.length > 0,
    `count=${zList.json?.count}`);
  const zone = zList.json?.items?.[0];

  const dCreate = await api('POST', '/api/db/deliveries', {
    zoneId: zone?.id,
    customerName: 'عميل توصيل اختبار',
    customerPhone: '0555555555',
    address: 'الرياض، حي النخيل، شارع الملك فهد',
    amountDue: 200,
    driverName: 'سائق اختبار',
  });
  check('POST deliveries', dCreate.status === 201,
    JSON.stringify(dCreate.json).slice(0, 140));
  check('delivery fee resolved from zone',
    Number(dCreate.json?.item?.fee) === Number(zone?.fee),
    `fee=${dCreate.json?.item?.fee} zoneFee=${zone?.fee}`);
  const delId = dCreate.json?.item?.id;

  const dStatus = await api('PATCH', `/api/db/deliveries/${delId}/status`, {
    status: 'delivered',
  });
  check('PATCH delivery status -> delivered',
    dStatus.status === 200 && dStatus.json.item.status === 'delivered' &&
    !!dStatus.json.item.delivered_at);

  const dBad = await api('POST', '/api/db/deliveries', {
    zoneId: zone?.id,
    customerName: 'اختبار الحد الأدنى',
    address: 'الرياض',
    amountDue: 1,
  });
  check('delivery enforces zone minimum order', dBad.status === 400, dBad.json?.error || '');

  const dList = await api('GET', '/api/db/deliveries');
  check('GET deliveries', dList.status === 200 && dList.json.items.length > 0);

  // ---- tenant isolation ----
  log('[security] tenant isolation');
  const otherTenant = await fetch(`${BASE}/api/db/services`, {
    headers: { 'x-tenant-id': 'another-tenant' },
  }).then((r) => r.json());
  check('service not visible to another tenant',
    !(otherTenant.items || []).some((x: any) => x.id === serviceId));

  // ---- validation ----
  log('[validation]');
  const v1 = await api('POST', '/api/db/appointments', { customerName: 'بلا وقت' });
  check('appointments require scheduledStart', v1.status === 400);
  const v2 = await api('POST', '/api/db/batches', { productId: 'p1' });
  check('batches require batchNumber', v2.status === 400);
  const v3 = await api('POST', '/api/db/production', { productId: 'p1', quantity: 0 });
  check('production rejects quantity <= 0', v3.status === 400);

  // ---- cleanup ----
  log('[cleanup]');
  await api('DELETE', `/api/db/appointments/${apptId}`);
  await api('PUT', `/api/db/services/${serviceId}`, { isActive: false });
  await api('DELETE', `/api/db/deliveries/${delId}`);

  log('');
  log(`RESULT: ${pass} passed, ${fail} failed`);
}

main().catch((e) => {
  log('FATAL: ' + e.message);
  fs.writeFileSync(LOG, lines.join('\n'));
});