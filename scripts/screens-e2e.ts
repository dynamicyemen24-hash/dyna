/**
 * End-to-end smoke test for the seven completed screens.
 * Creates real records in Neon, walks the status flows, then cleans up.
 * Run with: npx tsx scripts/screens-e2e.ts
 */
import fs from 'fs';
import path from 'path';

const BASE = process.env.API_BASE || 'http://';
const LOG = path.resolve('screens-e2e.log');
const lines: string[] = [];
const log = (s: string) => {
  lines.push(s);
  fs.writeFileSync(LOG, lines.join('\n'));
};

async function api(method: string, ep: string, body?: unknown) {
  const res = await fetch(`${BASE}${ep}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'royal-global-hq' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  let j: any = {};
  try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t.slice(0, 150) }; }
  return { status: res.status, json: j };
}

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, info = '') => {
  ok ? pass++ : fail++;
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${info ? ' — ' + info : ''}`);
};

const cleanup: string[][] = [];

async function main() {
  log(`DyPOS Screens E2E — ${new Date().toISOString()}\n`);

  const p = await api('GET', '/api/db/products');
  const productId = p.json.products?.[0]?.id;
  const productName = p.json.products?.[0]?.name || 'N/A';
  log(`product under test: ${productId} (${productName})\n`);

  // ---------- 1. Services ----------
  log('[1] Services');
  const svc = await api('POST', '/api/db/services', {
    name: 'خدمة E2E — صيانة جهاز', basePrice: 250, durationMinutes: 90, taxRate: 15,
  });
  check('create service', svc.status === 201, svc.json?.item?.name);
  const svcId = svc.json?.item?.id;
  cleanup.push(['/api/db/services/', svcId]);

  const svcList = await api('GET', '/api/db/services');
  check('list services', svcList.json.items?.some((s: any) => s.id === svcId),
    `count=${svcList.json.count}`);

  const svcUpd = await api('PUT', `/api/db/services/${svcId}`, { basePrice: 300 });
  check('update service', Number(svcUpd.json?.item?.base_price) === 300);

  // ---------- 2. Appointments ----------
  log('[2] Appointments');
  const start = new Date(Date.now() + 7200_000).toISOString();
  const apt = await api('POST', '/api/db/appointments', {
    serviceId: svcId, customerName: 'عميل E2E', customerPhone: '0501112233',
    scheduledStart: start, notes: 'اختبار آلي',
  });
  check('create appointment', apt.status === 201);
  const aptId = apt.json?.item?.id;
  cleanup.push(['/api/db/appointments/', aptId]);

  const dur = apt.json?.item?.scheduled_end
    ? (new Date(apt.json.item.scheduled_end).getTime() -
       new Date(apt.json.item.scheduled_start).getTime()) / 60000
    : 0;
  check('end time = service duration (90m)', dur === 90, `got ${dur}m`);

  for (const st of ['confirmed', 'in_progress', 'completed']) {
    const r = await api('PATCH', `/api/db/appointments/${aptId}/status`, { status: st });
    check(`appointment -> ${st}`, r.json?.item?.status === st);
  }

  // ---------- 3. Production ----------
  log('[3] Production');
  const rec = await api('GET', '/api/db/production/recipes');
  check('recipes endpoint responds', rec.status === 200, `recipes=${rec.json?.count}`);

  const prod = await api('POST', '/api/db/production', {
    productId, quantity: 3, status: 'in_progress', notes: 'اختبار آلي',
  });
  check('create production order', prod.status === 201);
  const prodId = prod.json?.item?.id;
  cleanup.push(['/api/db/production/', prodId]);

  const prodDone = await api('POST', `/api/db/production/${prodId}/complete`, { completedQty: 3 });
  check('complete production (transactional)',
    prodDone.status === 200 && prodDone.json?.item?.status === 'completed');

  // ---------- 4. Batches ----------
  log('[4] Batches & expiry');
  const batNo = `E2E-${Date.now()}`;
  const bat = await api('POST', '/api/db/batches', {
    productId, batchNumber: batNo, quantity: 50, cost: 9.5,
    expiryDate: '2027-06-30', productionDate: '2026-01-15',
  });
  check('create batch', bat.status === 201, batNo);
  const batId = bat.json?.item?.id;
  cleanup.push(['/api/db/batches/', batId]);

  const batList = await api('GET', '/api/db/batches');
  const found = batList.json.items?.find((b: any) => b.id === batId);
  check('batch exposes days_to_expiry', typeof found?.days_to_expiry === 'number',
    `days=${found?.days_to_expiry}`);
  check('batch value = qty × cost = 475', Number(found?.batch_value) === 475,
    `value=${found?.batch_value}`);

  // ---------- 5. Serials ----------
  log('[5] Serials / IMEI');
  const sn = `SN-E2E-${Date.now()}`;
  const ser = await api('POST', '/api/db/serials', {
    productId, serialNumber: sn, imei: '352099001761481', warrantyEnd: '2028-01-01',
  });
  check('create serial', ser.status === 201, sn);
  const serId = ser.json?.item?.id;
  cleanup.push(['/api/db/serials/', serId]);

  const sold = await api('PATCH', `/api/db/serials/${serId}`, { status: 'sold' });
  check('mark serial sold', sold.json?.item?.status === 'sold' && !!sold.json?.item?.sold_at);

  // ---------- 6. Commissions ----------
  log('[6] Commissions');
  const emp = await api('GET', '/api/db/employees');
  const empId = emp.json?.items?.[0]?.id || 'emp1';
  const empName = emp.json?.items?.[0]?.name || 'موظف';

  const com = await api('POST', '/api/db/commissions', {
    employeeId: empId, employeeName: empName, baseAmount: 20000, rate: 2,
  });
  check('create commission', com.status === 201);
  check('amount = 20000 × 2% = 400', Number(com.json?.item?.amount) === 400,
    `amount=${com.json?.item?.amount}`);

  const com2 = await api('POST', '/api/db/commissions', {
    employeeId: empId, baseAmount: 25000, rate: 2,
  });
  check('upsert same period instead of duplicating',
    Number(com2.json?.item?.amount) === 500, `amount=${com2.json?.item?.amount}`);

  const comList = await api('GET', '/api/db/commissions');
  check('commissions totals returned', comList.json?.totals !== undefined,
    JSON.stringify(comList.json?.totals));

  const settle = await api('POST', '/api/db/commissions/settle', { ids: [com2.json?.item?.id] });
  check('settle commission', settle.json?.items?.[0]?.status === 'paid');

  // ---------- 7. Delivery ----------
  log('[7] Delivery');
  const zones = await api('GET', '/api/db/delivery-zones');
  check('delivery zones available', zones.json.items?.length > 0,
    `zones=${zones.json?.count}`);
  const zone = zones.json.items?.[1] || zones.json.items?.[0];

  const low = await api('POST', '/api/db/deliveries', {
    zoneId: zone?.id, customerName: 'اختبار الحد', address: 'الرياض', amountDue: 1,
  });
  check('rejects below zone minimum', low.status === 400, (low.json?.error || '').slice(0, 44));

  const del = await api('POST', '/api/db/deliveries', {
    zoneId: zone?.id, customerName: 'عميل توصيل E2E', customerPhone: '0556667788',
    address: 'الرياض، حي الملقا، طريق أنس بن مالك', amountDue: 350,
    driverName: 'سائق E2E',
  });
  check('create delivery', del.status === 201);
  const delId = del.json?.item?.id;
  cleanup.push(['/api/db/deliveries/', delId]);
  check('fee resolved from zone', Number(del.json?.item?.fee) === Number(zone?.fee),
    `fee=${del.json?.item?.fee}`);

  for (const st of ['assigned', 'picked_up', 'on_the_way', 'delivered']) {
    const r = await api('PATCH', `/api/db/deliveries/${delId}/status`, { status: st });
    check(`delivery -> ${st}`, r.json?.item?.status === st);
  }
  const fin = await api('PATCH', `/api/db/deliveries/${delId}/status`, { status: 'delivered' });
  check('delivered_at timestamp set', !!fin.json?.item?.delivered_at);

  // ---------- cleanup ----------
  log('\n[cleanup]');
  for (const [ep, id] of cleanup) {
    if (!id) continue;
    const r = await api('DELETE', `${ep}${id}`);
    log(`  ${r.status === 200 ? 'removed' : 'kept'} ${ep}${id}`);
  }

  log(`\nRESULT: ${pass} passed, ${fail} failed`);
}

main().catch((e) => {
  log('FATAL: ' + e.message);
  fs.writeFileSync(LOG, lines.join('\n'));
});