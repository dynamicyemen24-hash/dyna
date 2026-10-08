/**
 * opsCopilot — المساعد التشغيلي المحلي (Commerce OS بند #4).
 *
 * ── لماذا محلي ─────────────────────────────────────────────────────────────
 * التوصية تُحسب على الجهاز من قائمة `situations` التي رتّبها وفلترها
 * `useWorkCenter` مسبقًا (ترخيص + صلاحيات). لا شبكة هنا: لا `fetch`، لا مفاتيح،
 * لا إرسال لبيانات حساسة (ذمم، مخزون، قيود) إلى أي خدمة خارجية.
 *
 * ── لماذا حتمي ─────────────────────────────────────────────────────────────
 * نفس المدخل يعطي نفس المخرج دائمًا: الترتيب بالخطورة ثم التعرض ثم المعرف،
 * والثقة ثابتة لكل خطورة (+0.05 عند وجود تعرض). بهذا يتفق مشغّلان ينظران إلى
 * نفس الشاشة على «التالي» دون لبس، وكل توصية تحمل سببها ومصدرها وثقتها.
 *
 * قواعد العقد (من docs/ARCHITECTURE.md):
 * - Offline-first: محرك خالص — لا شبكة، لا تخزين، لا وقت نظام مباشر.
 * - Explainable: كل اقتراح فيه `why` (عربي يذكر المصدر) + `source` + `confidence`.
 * - Composable: يعمل على أي شاشة تُمرر `situations` — لا يعرف القطاعات.
 * - Permission-aware: لا يخترع أهدافًا — المدخلات مفلترة مسبقًا، والمخرج subset منها.
 * - Audit-ready: `ruleVersion` ثابتة لكل اقتراح.
 * - Arabic-first: كل النصوص المعروضة عربية.
 * - Measured: مغطى باختبار تعاقدي `scripts/test-ops-copilot.ts`.
 */

export type CopilotSeverity = 'critical' | 'warning' | 'info';

export type CopilotSource = 'sync' | 'ledger' | 'stock' | 'work' | 'kpi' | 'data';

/** مدخل الحالة — متوافق بنيويًا مع `Situation` في `useWorkCenter` دون استيراده (تفادي الدورات). */
export interface CopilotSituation {
  id: string;
  severity: CopilotSeverity;
  title: string;
  detail: string;
  actionLabel: string;
  target: string;
  exposure?: number | null;
  exposureUnit?: 'currency' | 'units' | 'count';
}

export interface CopilotInput {
  situations: CopilotSituation[];
  offline: boolean;
  pendingSync: number;
  periodClosed: boolean;
  overdueWork: number;
}

export interface CopilotSuggestion {
  rank: number;
  situationId: string;
  title: string;
  actionLabel: string;
  target: string;
  /** تفسير عربي يذكر المصدر — يُعرض للمشغّل كما هو. */
  why: string;
  source: CopilotSource;
  /** ثقة حتمية في [0,1]: حرج 0.9 / تحذير 0.7 / متابعة 0.5 + 0.05 عند وجود تعرض. */
  confidence: number;
  ruleVersion: 'ops-copilot/v1';
}

export const OPS_COPILOT_RULE_VERSION = 'ops-copilot/v1' as const;

const SEVERITY_RANK: Record<CopilotSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const BASE_CONFIDENCE: Record<CopilotSeverity, number> = {
  critical: 0.9,
  warning: 0.7,
  info: 0.5,
};

const SOURCE_LABEL: Record<CopilotSource, string> = {
  data: 'سلامة البيانات',
  sync: 'المزامنة المحلية',
  ledger: 'دفتر الأستاذ والذمم',
  stock: 'المخزون',
  work: 'طابور العمل',
  kpi: 'المؤشرات',
};

/**
 * مصدر كل حالة من معرفها — نفس تقسيم سلطة `useWorkCenter`:
 * سلامة البيانات (data-failed/offline/pending/period-closed) ← أموال معرضة
 * (receivable/payable/unposted/overdue) ← مخزون يوقف البيع
 * (out-of-stock/low-stock/expiry) ← مؤشرات (kpi-*).
 */
function sourceFor(id: string): CopilotSource {
  if (id === 'data-failed') return 'data';
  if (id === 'offline' || id === 'pending-sync') return 'sync';
  if (id === 'period-closed' || id === 'unposted') return 'ledger';
  if (id === 'receivable' || id === 'payable') return 'ledger';
  if (id === 'out-of-stock' || id === 'low-stock' || id === 'expiry') return 'stock';
  if (id === 'overdue-work') return 'work';
  if (id.startsWith('kpi-')) return 'kpi';
  return 'work';
}

function confidenceFor(severity: CopilotSeverity, exposure: number | null | undefined): number {
  const base = BASE_CONFIDENCE[severity] ?? 0.5;
  const bonus = exposure === null || exposure === undefined ? 0 : 0.05;
  // تقريب لمرتبتين عشريتين — وإلا فـ 0.9 + 0.05 = 0.9500000000000001
  // ويكسر المساواة الحتمية في الاختبار التعاقدي.
  const value = Math.round((base + bonus) * 100) / 100;
  return value > 1 ? 1 : value;
}

function exposureValue(s: CopilotSituation): number {
  return typeof s.exposure === 'number' && Number.isFinite(s.exposure) ? s.exposure : 0;
}

/**
 * يقترح الإجراءات التالية من الحالات المفلترة مسبقًا (صلاحيات + ترخيص).
 *
 * - لا شبكة، لا عشوائية، لا وقت نظام مباشر: `now` وسيط قابل للحقن للاختبارات
 *   (الترتيب الحالي لا يعتمد على الزمن عمدًا — الحتمية أولًا).
 * - الترتيب: الخطورة أولًا، ثم قيمة التعرض تنازليًا، ثم المعرف لكسر التعادل حتميًا.
 * - المخرج subset من المدخل فقط — لا أهداف مخترعة أبدًا.
 * - مدخل فارغ ← مخرج فارغ.
 */
export function suggestNextActions(
  input: CopilotInput,
  limit = 3,
  now = Date.now(),
): CopilotSuggestion[] {
  // `now` محقون للحقن الاختباري والتوافق مع العقد؛ الترتيب زمني-حر عمدًا
  // ليبقى حتميًا تمامًا (مشغّلان يتفقان على التالي).
  void now;
  void input.offline;
  void input.pendingSync;
  void input.periodClosed;
  void input.overdueWork;

  const n = Math.floor(limit);
  if (!Number.isFinite(n) || n <= 0) return [];
  const list = Array.isArray(input.situations) ? input.situations : [];
  if (list.length === 0) return [];

  const ranked = [...list].sort((a, b) => {
    const sev = (SEVERITY_RANK[a.severity] ?? 2) - (SEVERITY_RANK[b.severity] ?? 2);
    if (sev !== 0) return sev;
    const exp = exposureValue(b) - exposureValue(a);
    if (exp !== 0) return exp;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return ranked.slice(0, n).map((s, index) => {
    const source = sourceFor(s.id);
    return {
      rank: index + 1,
      situationId: s.id,
      title: s.title,
      actionLabel: s.actionLabel,
      target: s.target,
      why: `المصدر: ${SOURCE_LABEL[source]} — «${s.title}»: ${s.detail}`,
      source,
      confidence: confidenceFor(s.severity, s.exposure),
      ruleVersion: OPS_COPILOT_RULE_VERSION,
    };
  });
}

export default suggestNextActions;
