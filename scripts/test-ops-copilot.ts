/**
 * الاختبار التعاقدي للمساعد التشغيلي المحلي (opsCopilot).
 *
 * Run: npx tsx scripts/test-ops-copilot.ts
 *
 * العقد (من docs/ARCHITECTURE.md بند #4): محرك خالص محلي — لا شبكة، قابل
 * للتفسير (سبب + مصدر + ثقة)، لا يخترع أهدافًا (Permission-aware عبر مدخلات
 * مفلترة مسبقًا)، عربي-أولًا، وحتمي (نفس المدخل = نفس المخرج).
 */
import fs from 'node:fs';
import path from 'node:path';
import { suggestNextActions, type CopilotInput } from '../src/services/opsCopilot';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title: string): void { console.log(`\n${title}`); }

const src = fs.readFileSync(
  path.join(process.cwd(), 'src/services/opsCopilot.ts'), 'utf8',
);
// جسم الدالة فقط — التوقيع نفسه يحمل `now = Date.now()` كوسيط محقون حسب العقد،
// فيُستبعد من الفحص (أول `{` بعد اسم الدالة هو بداية الجسم).
const bodyStart = src.indexOf('{', src.indexOf('suggestNextActions'));
const body = bodyStart === -1 ? '' : src.slice(bodyStart);

const base: CopilotInput = {
  situations: [
    {
      id: 'receivable', severity: 'warning', title: 'ذمم مدينة معلّقة',
      detail: '3 عملاء بأرصدة مدينة غير محصّلة', actionLabel: 'تحصيل وتسوية',
      target: 'customer', exposure: 12000, exposureUnit: 'currency',
    },
    {
      id: 'out-of-stock', severity: 'critical', title: 'أصناف نفد مخزونها',
      detail: 'بيعها الآن يعني فاتورة بلا تسليم', actionLabel: 'إعادة الطلب',
      target: 'inventory', exposure: 5, exposureUnit: 'units',
    },
    {
      id: 'kpi-sales', severity: 'info', title: 'تباطؤ المبيعات',
      detail: 'المؤشر أدنى من المعيار', actionLabel: 'عرض التقارير',
      target: 'reports', exposure: null, exposureUnit: 'count',
    },
  ],
  offline: false,
  pendingSync: 0,
  periodClosed: false,
  overdueWork: 0,
};

section('1. المحرك محلي تمامًا — لا شبكة ولا عشوائية ولا وقت مباشر');
check('لا يستورد fetch ولا يستدعيه', !/fetch\s*\(/.test(src), 'شبكة في محرك محلي = تسريب بيانات حساسة');
check('لا أثر لـ Gemini/Google', !/gemini|GoogleGenerativeAI|generativelanguage/i.test(src));
check('لا عشوائية', !/Math\.random/.test(body));
check('لا Date.now مباشر في الجسم (الوقت عبر وسيط now المحقون فقط)', !/Date\.now\s*\(\)/.test(body));

section('2. حتمي — نفس المدخل يعطي نفس المخرج');
{
  const a = suggestNextActions(base, 3, 1700000000000);
  const b = suggestNextActions(base, 3, 1700000000000);
  check('نفس المدخل مرتين = نفس المخرج', JSON.stringify(a) === JSON.stringify(b));
  const c = suggestNextActions(base, 3, 1800000000000);
  check('الحقن الزمني لا يغيّر الترتيب (حتمية المشغّلين)', JSON.stringify(a) === JSON.stringify(c));
}

section('3. لا يخترع أهدافًا — المخرج subset من المدخل');
{
  const out = suggestNextActions(base, 3);
  const allowed = new Set(base.situations.map((s) => s.target));
  check('كل target مقترح موجود في المدخل', out.every((s) => allowed.has(s.target)));
  const ids = new Set(base.situations.map((s) => s.id));
  check('كل situationId مقترح موجود في المدخل', out.every((s) => ids.has(s.situationId)));
}

section('4. كل اقتراح قابل للتفسير ومرقّم بالإصدار');
{
  const out = suggestNextActions(base, 3);
  const sources = new Set(['sync', 'ledger', 'stock', 'work', 'kpi', 'data']);
  check('كل اقتراح فيه why يذكر المصدر', out.every((s) => s.why.length > 0 && s.why.includes('المصدر:')));
  check('كل source ضمن القاموس', out.every((s) => sources.has(s.source)));
  check('كل confidence ضمن [0,1]', out.every((s) => s.confidence >= 0 && s.confidence <= 1));
  check('كل ruleVersion هي ops-copilot/v1', out.every((s) => s.ruleVersion === 'ops-copilot/v1'));
  check('الرتب متسلسلة 1..n', out.every((s, i) => s.rank === i + 1));
}

section('5. عربي-أولًا + حدود المدخلات');
{
  const out = suggestNextActions(base, 3);
  check('title/actionLabel غير فارغين (عربي)', out.every((s) => s.title.trim().length > 0 && s.actionLabel.trim().length > 0));
  check('مدخل فارغ ← مخرج فارغ', suggestNextActions({ ...base, situations: [] }, 3).length === 0);
  check('limit=1 يحترم الحد', suggestNextActions(base, 1).length === 1);
  check('limit=2 يحترم الحد', suggestNextActions(base, 2).length === 2);
}

section('6. الأولوية: الحرج قبل التحذيري + الثقة الحتمية');
{
  const out = suggestNextActions(base, 3);
  check(
    'out-of-stock الحرج قبل receivable التحذيري',
    out[0]?.situationId === 'out-of-stock' && out.some((s) => s.situationId === 'receivable'),
    `first=${out[0]?.situationId}`,
  );
  const crit = out.find((s) => s.situationId === 'out-of-stock');
  const warn = out.find((s) => s.situationId === 'receivable');
  const info = out.find((s) => s.situationId === 'kpi-sales');
  check('ثقة الحرج مع تعرض = 0.95', crit?.confidence === 0.95, `got=${crit?.confidence}`);
  check('ثقة التحذيري مع تعرض = 0.75', warn?.confidence === 0.75, `got=${warn?.confidence}`);
  check('ثقة المتابعة دون تعرض = 0.5', info?.confidence === 0.5, `got=${info?.confidence}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (pass === 0) {
  console.error('\nERROR: no assertions executed.');
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
