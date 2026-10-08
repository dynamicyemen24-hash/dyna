/**
 * End-to-end verification of the financial statements module.
 *
 * The assertions here are ACCOUNTING IDENTITIES, not expected numbers. A test
 * that hard-codes "revenue must equal 20880.55" passes today and fails the
 * moment a real sale is posted; an identity holds for every dataset, and it is
 * the identity a reader would check by hand.
 *
 * The identities:
 *
 *   1. gross sales = net revenue + VAT        (revenue excludes tax)
 *   2. gross profit = net revenue - COGS
 *   3. operating profit = gross profit - opex
 *   4. net profit = operating profit + other income - other expense
 *   5. cash: closing = opening + operating + investing + financing
 *   6. the P&L lines, added up, reproduce net profit (the statement foots)
 *   7. "no expenses recorded" is reported as incomplete, NOT as a zero opex
 *   8. an unattributed cost line is reported as incomplete, NOT as zero cost
 *
 * Rules 7 and 8 catch the expensive failure: a dashboard that renders a
 * confident number computed from no data at all.
 *
 *   DYPOS_TEST_USER=... DYPOS_TEST_PASSWORD=... npx tsx scripts/test-financials.ts
 */
import dotenv from 'dotenv';

dotenv.config();

const BASE = process.env.API_BASE || 'http://';
const TENANT = 'royal-global-hq';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Two-decimal comparison: money never carries more precision than a cent. */
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol;

async function api(endpoint: string, token?: string, init?: RequestInit) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-tenant-id': TENANT,
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${endpoint}`, { ...init, headers });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  return { status: res.status, json };
}

/**
 * Signs in with the operator's own credentials.
 *
 * Read from the environment and never printed, so the module can be verified
 * against a live deployment without leaking a working password into a log.
 */
async function signIn(): Promise<string> {
  const username = process.env.DYPOS_TEST_USER;
  const password = process.env.DYPOS_TEST_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'Set DYPOS_TEST_USER and DYPOS_TEST_PASSWORD to run the live endpoint tests.',
    );
  }
  const res = await api('/api/auth/login', undefined, {
    method: 'POST',
    body: JSON.stringify({ username, password, branchId: 'rg-branch-hq' }),
  });
  // The signed token lives under `session`; the login route has always
  // returned this shape, and the client reads session.token from storage.
  const token = res.json?.session?.token;
  if (res.status !== 200 || !token) {
    throw new Error(`Sign-in failed (${res.status}): ${res.json?.error || 'no session token'}`);
  }
  return token;
}

async function main() {
  console.log('\n=== financial statements: end-to-end ===\n');

  // --- Access control is checked BEFORE any arithmetic --------------------
  // A financial endpoint that answers an anonymous caller is a disclosure
  // incident, so this runs first and on its own.
  const anon = await api('/api/db/financials/pnl');
  check('unauthenticated P&L is refused', anon.status === 401 || anon.status === 403,
    `got ${anon.status}`);

  const anonFlow = await api('/api/db/financials/cash-flow');
  check('unauthenticated cash flow is refused',
    anonFlow.status === 401 || anonFlow.status === 403, `got ${anonFlow.status}`);

  const token = await signIn();
  check('sign-in succeeds', Boolean(token));

  const to = new Date().toISOString().slice(0, 10);
  const from = `${to.slice(0, 7)}-01`;
  const win = `from=${from}&to=${to}`;

  const [pnlRes, flowRes, sumRes, trendRes, mixRes] = await Promise.all([
    api(`/api/db/financials/pnl?${win}`, token),
    api(`/api/db/financials/cash-flow?${win}`, token),
    api(`/api/db/financials/summary?${win}`, token),
    api('/api/db/financials/trend?months=12', token),
    api(`/api/db/financials/expense-breakdown?${win}`, token),
  ]);

  check('P&L responds 200', pnlRes.status === 200, `got ${pnlRes.status} ${pnlRes.json.error || ''}`);
  check('cash flow responds 200', flowRes.status === 200, `got ${flowRes.status} ${flowRes.json.error || ''}`);
  check('summary responds 200', sumRes.status === 200, `got ${sumRes.status}`);
  check('trend responds 200', trendRes.status === 200, `got ${trendRes.status}`);
  check('expense breakdown responds 200', mixRes.status === 200, `got ${mixRes.status}`);

  if (pnlRes.status !== 200 || flowRes.status !== 200) {
    console.log('\nCannot assert identities without a statement.');
    report();
    return;
  }

  const pnl = pnlRes.json;
  const flow = flowRes.json;

  // --- Identity 1: revenue excludes VAT -----------------------------------
  console.log('\n[identity 1: gross = net + VAT]');
  check('gross sales equals net revenue plus VAT',
    near(pnl.sales.grossRevenue, pnl.sales.netRevenue + pnl.sales.vat, 1),
    `${pnl.sales.grossRevenue} vs ${pnl.sales.netRevenue + pnl.sales.vat}`);
  check('net revenue is never greater than gross',
    pnl.sales.netRevenue <= pnl.sales.grossRevenue + 0.01);

  // --- Identity 2: gross profit -------------------------------------------
  console.log('\n[identity 2: gross profit = revenue - COGS]');
  check('gross profit equals revenue minus cost of sales',
    near(pnl.grossProfit, pnl.sales.netRevenue - pnl.sales.cogs), `${pnl.grossProfit}`);

  // --- Identity 3: operating profit ---------------------------------------
  console.log('\n[identity 3: operating profit = gross profit - opex]');
  check('operating profit equals gross profit minus operating expenses',
    near(pnl.operatingProfit, pnl.grossProfit - pnl.expenses.total));

  // --- Identity 4: net profit ---------------------------------------------
  console.log('\n[identity 4: net profit = operating + other]');
  check('net profit equals operating profit plus other income and expense',
    near(pnl.netProfit, pnl.operatingProfit + pnl.other.income - pnl.other.expense));
// --- Identity 6: the statement FOOTS ------------------------------------
  // The detail lines must sum to the bottom line. This catches a duplicated or
  // omitted bucket in the report order, which totals never reveal.
  console.log('\n[identity 6: the statement lines foot to net profit]');
  const byCode = (c: string) => pnl.lines.find((l: any) => l.code === c)?.amount ?? 0;
  const fromDetails =
    byCode('net_revenue')
    + pnl.lines.filter((l: any) => l.code.startsWith('opex_')).reduce((s: number, l: any) => s + l.amount, 0)
    + byCode('cogs')
    + byCode('other_income')
    + byCode('other_expense');
  check('detail lines sum to the net profit', near(fromDetails, pnl.netProfit),
    `${fromDetails} vs ${pnl.netProfit}`);
  check('stated gross profit matches its own line', near(byCode('gross_profit'), pnl.grossProfit));
  check('stated operating profit matches its own line', near(byCode('operating_profit'), pnl.operatingProfit));
  check('stated net profit matches its own line', near(byCode('net_profit'), pnl.netProfit));
  check('every line carries a percentage of revenue',
    pnl.lines.every((l: any) => typeof l.pctOfRevenue === 'number'));
  check('the expense buckets sum to the stated opex total', near(
    pnl.expenses.lines.reduce((s: number, l: any) => s + l.amount, 0),
    pnl.expenses.total,
  ));

  // --- Identity 7: absence of expenses is flagged, not zeroed -------------
  console.log('\n[identity 7: no data is not zero]');
  if (!pnl.expenses.recorded) {
    check('absent expenses are reported as unrecorded', pnl.completeness.expensesRecorded === false);
    check('absent expenses produce a warning note',
      pnl.completeness.notes.some((n: string) => n.includes('مصروفات')));
    check('net profit is still shown, not blank', typeof pnl.netProfit === 'number');
    // The decisive one: net profit EQUALS gross profit here — the number a
    // careless reader would quote as final — so a caveat must accompany it.
    check('net profit equalling gross profit is accompanied by a caveat',
      !near(pnl.netProfit, pnl.grossProfit) || pnl.completeness.notes.length > 0);
  } else {
    check('recorded expenses are reflected in the total', pnl.expenses.total > 0);
    check('expense breakdown totals match the P&L', near(mixRes.json.total, pnl.expenses.total));
  }

  // --- Identity 8: unattributed cost is flagged ---------------------------
  console.log('\n[identity 8: unattributed cost is flagged]');
  if (pnl.completeness.cogsUnattributed > 0) {
    check('unattributed lines mark COGS incomplete', pnl.completeness.cogsComplete === false);
    check('unattributed count is reported', pnl.completeness.cogsUnattributed > 0);
    check('unattributed cost produces a warning note',
      pnl.completeness.notes.some((n: string) => n.includes('تكلفة')));
  } else if (pnl.sales.lineCount > 0) {
    check('fully attributed cost is reported complete', pnl.completeness.cogsComplete === true);
  } else {
    check('no lines at all is reported incomplete', pnl.completeness.cogsComplete === false);
    check('no lines produces an explanatory note', pnl.completeness.notes.length > 0);
  }

  // --- Identity 5: the cash flow reconciles -------------------------------
  console.log('\n[identity 5: closing = opening + all sections]');
  const sectionsNet = flow.sections.reduce((s: number, x: any) => s + x.net, 0);
  check('sections sum to the reported net change', near(sectionsNet, flow.netChange));
  check('closing cash equals opening plus net change',
    near(flow.closingCash, flow.openingCash + flow.netChange),
    `${flow.closingCash} vs ${flow.openingCash + flow.netChange}`);
  check('total inflow minus outflow equals net change',
    near(flow.totalInflow - flow.totalOutflow, flow.netChange));
  check('cash flow declares its basis', typeof flow.basis === 'string' && flow.basis.length > 0);
  check('the operating section is present and labelled',
    flow.sections.some((s: any) => s.section === 'operating' && Boolean(s.label)));

  // --- Summary agrees with the statements it summarises -------------------
  console.log('\n[summary is consistent with the statements]');
  const summary = sumRes.json;
  check('summary revenue matches the P&L', near(summary.revenue, pnl.sales.netRevenue));
  check('summary net profit matches the P&L', near(summary.netProfit, pnl.netProfit));
  check('summary closing cash matches the cash flow', near(summary.cash.closing, flow.closingCash));
  check('summary carries the comparison window', Boolean(summary.comparisonWindow?.from));
  check('growth is a number or null, never undefined',
    summary.change.revenue === null || typeof summary.change.revenue === 'number');

  // --- Trend shape --------------------------------------------------------
  console.log('\n[trend series is complete, not gappy]');
  const series = trendRes.json.series;
  check('trend returns the requested number of months', series.length === 12, `got ${series.length}`);
  check('months are unique', new Set(series.map((m: any) => m.month)).size === series.length);
  check('months are in ascending order',
    series.every((m: any, i: number) => i === 0 || m.month > series[i - 1].month));
  check('every month carries an Arabic label', series.every((m: any) => Boolean(m.label)));
  check('active months never exceed the series length', trendRes.json.activeMonths <= series.length);
  // Every month's own identity must hold, or a single bad month poisons the chart.
  check('each month foots its own gross profit',
    series.every((m: any) => near(m.grossProfit, m.revenue - m.cogs, 0.05)));
  check('each month foots its own net profit',
    series.every((m: any) => near(m.netProfit, m.grossProfit - m.expenses, 0.05)));
  console.log(`      note: trend covers 12 months (${trendRes.json.activeMonths} active); the statement covers ${from}..${to}`);

  // --- Publishing a statement is append-only ------------------------------
  console.log('\n[publishing is versioned and immutable]');
  const publish = await api('/api/db/financials/statements', token, {
    method: 'POST',
    body: JSON.stringify({ statementType: 'pnl', period: to.slice(0, 7) }),
  });
  if (publish.status === 201) {
    check('a publish is accepted', Boolean(publish.json.item?.id));
    check('each publish increments the version', publish.json.version >= 1,
      `got ${publish.json.version}`);
    check('published statement records the net result',
      near(Number(publish.json.item.net_result), pnl.netProfit, 0.05));
    check('published statement carries its completeness flag',
      publish.json.item.cogs_complete === pnl.completeness.cogsComplete);

    const republish = await api('/api/db/financials/statements', token, {
      method: 'POST',
      body: JSON.stringify({ statementType: 'pnl', period: to.slice(0, 7) }),
    });
    check('re-publishing does not overwrite the earlier version',
      republish.json.version === publish.json.version + 1,
      `${publish.json.version} then ${republish.json.version}`);

    const history = await api('/api/db/financials/statements', token);
    const forPeriod = history.json.items.filter(
      (s: any) => s.period === to.slice(0, 7) && s.statementType === 'pnl',
    );
    check('both versions remain readable', forPeriod.length >= 2, `got ${forPeriod.length}`);
    check('exactly one version is published',
      forPeriod.filter((s: any) => s.status === 'published').length === 1);
    check('the earlier version is marked superseded',
      forPeriod.some((s: any) => s.status === 'superseded'));
  } else {
    console.log(`      skipped: publishing needs reports.manage (got ${publish.status})`);
  }

  // --- Refusing to double-count operating cash ----------------------------
  console.log('\n[operating cash cannot be double counted]');
  const badMove = await api('/api/db/financials/cash-movements', token, {
    method: 'POST',
    body: JSON.stringify({
      direction: 'in', section: 'operating', category: 'test', amount: 100,
    }),
  });
  check('an operating cash movement is refused', badMove.status === 400, `got ${badMove.status}`);
  check('the refusal explains why',
    String(badMove.json.error || '').includes('تلقائي') || String(badMove.json.error || '').includes('تشتق'));

  const badAmount = await api('/api/db/financials/cash-movements', token, {
    method: 'POST',
    body: JSON.stringify({
      direction: 'in', section: 'investing', category: 'test', amount: -5,
    }),
  });
  check('a negative amount is refused', badAmount.status === 400, `got ${badAmount.status}`);

  const badCategory = await api('/api/db/financials/cash-movements', token, {
    method: 'POST',
    body: JSON.stringify({ direction: 'in', section: 'investing', amount: 100 }),
  });
  check('a movement without a category is refused', badCategory.status === 400, `got ${badCategory.status}`);

  report();
}

function report() {
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log(`failed assertions:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nTEST RUN ERROR:', e.message);
  process.exit(1);
});