import React, { useState } from 'react';
import { Ruler, Plus, Search, ChevronRight, User, MoreVertical } from 'lucide-react';
import { apiGet } from '../services/dyposApi';

/**
 * The measurement row exactly as the database returns it (snake_case), kept
 * separate from the `Measurement` the screen renders.
 *
 * The mapper used to take `any`, which meant a renamed or dropped column
 * silently became `undefined` and rendered as an empty field on a customer
 * measuring form — no compile error, no runtime error, just a blank.
 */
interface MeasurementRow {
  id: string;
  customer_name?: string | null;
  type: string;
  created_at: string;
  data?: unknown;
}

interface Measurement {
  id: string;
  customerName: string;
  type: string;
  date: string;
  data: Record<string, string>;
}

/*
 * There is deliberately NO `mockMeasurements` here any more.
 *
 * This screen used to seed itself with two invented customers — names, garment
 * types, chest/neck/shoulder/sleeve measurements — and to KEEP those rows when
 * the API call failed: the `catch` logged and fell through, leaving the mocks on
 * screen. For a tailor that is the worst failure this product can produce:
 * real-looking measurements belonging to no customer and to no order, visually
 * indistinguishable from real ones, and entered by hand into the next garment.
 *
 * So the state starts EMPTY and the empty case is rendered explicitly. An empty
 * measurement list is a true statement; a fabricated one is not.
 */

export const MeasurementManager: React.FC = () => {
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  React.useEffect(() => {
    const fetchMeasurements = async () => {
      try {
        // `apiGet` attaches the tenant header and the bearer token. The raw
        // `fetch(...?tenantId=royal-global-hq)` sent neither, so this list was
        // read with a tenant the client merely asserted.
        const data = await apiGet<{ measurements?: MeasurementRow[] }>('/api/db/measurements');
        /*
         * Note the unconditional `setMeasurements`. The old code only assigned
         * when the response was non-empty, so a tenant with ZERO measurements
         * kept the two seeded mocks forever — the list was never empty and never
         * showed what was actually in the database.
         */
        setMeasurements(
          (data.measurements ?? []).map((m) => ({
            id: m.id,
            customerName: m.customer_name || 'عميل غير معروف',
            type: m.type,
            date: new Date(m.created_at).toLocaleDateString('en-CA'), // YYYY-MM-DD
            // `data` is `unknown` from the wire. Passing it straight through used
            // to type-check only because the mapper took `any`, and the screen
            // then indexed it as if it were an object — a malformed row crashed
            // the list. Narrowed here, so the damage is one bad row, not the
            // whole page.
            data: typeof m.data === 'object' && m.data !== null
              ? (m.data as Record<string, string>)
              : {},
          })),
        );
      } catch (err) {
        /*
         * The list stays EMPTY and `error` is set, so the screen says "could not
         * load" instead of quietly presenting fabrications. Showing invented
         * customers because a request failed is the failure mode O3 exists to
         * prevent: an outage must not look like data.
         */
        console.error('Failed to fetch measurements', err);
        setError(true);
      } finally {
        setIsLoading(false);
      }
    };

    fetchMeasurements();
  }, []);

  return (
    <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-black flex items-center gap-3">
            <Ruler className="text-amber-500" size={32} />
            إدارة المقاسات
          </h1>
          <p className="text-faint mt-1">تتبع مقاسات العملاء وتاريخ التعديلات.</p>
        </div>
        {/*
            "مقاس جديد" had no handler — and no endpoint exists to create a
            measurement, so a button promising one is a false affordance. It costs
            the operator a click and a moment of trust to learn nothing.

            Removed rather than disabled: a permanently disabled control still
            occupies the space and still implies the capability is one click away,
            which is the same lie with extra steps. The real fix is the create
            endpoint, and that belongs with the measurements API rather than as a
            button stub.
          */}
      </div>

      <div className="surface-card rounded-3xl overflow-hidden shadow-2xl">
        <div className="p-6 border-b border-hairline flex flex-col md:flex-row justify-between gap-4 bg-subtle">
          <div className="relative flex-1">
            <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-muted" size={18} />
            <input 
              type="text" 
              placeholder="بحث عن مقاس أو اسم عميل..." 
              className="w-full bg-hairline/40 border-none rounded-xl py-2.5 pr-12 pl-4 text-sm focus:ring-2 focus:ring-amber-500/50"
            />
          </div>
          <div className="flex gap-2">
            <select className="bg-hairline/40 border-none rounded-xl text-sm px-4 focus:ring-2 focus:ring-amber-500/50">
              <option>جميع الأنواع</option>
              <option>ثوب سعودي</option>
              <option>بدلة رسمية</option>
            </select>
          </div>
        </div>

        <div className="divide-y divide-hairline">
          {/* An outage, an empty database and a populated database are three
              different facts. The old screen drew the same list in all three. */}
          {isLoading ? (
            <div className="p-10 text-center text-muted text-sm">جارٍ تحميل المقاسات…</div>
          ) : error ? (
            <div className="p-10 text-center">
              <p className="text-err-strong font-bold mb-2">تعذّر تحميل المقاسات</p>
              <p className="text-muted text-sm">
                الاتصال بالخادم فشل. لم يُعرض أي بيان هنا تفادياً لعرض بيانات غير حقيقية.
              </p>
            </div>
          ) : measurements.length === 0 ? (
            <div className="p-10 text-center text-muted text-sm">
              لا توجد مقاسات مسجلة بعد. أضف أول مقاس لعميل.
            </div>
          ) : (
            measurements.map((m) => (
              <div key={m.id} className="p-6 flex items-center justify-between hover:bg-hairline/60/30 transition-colors cursor-pointer group">
                <div className="flex items-center gap-5">
                  <div className="w-12 h-12 rounded-2xl bg-warn-soft flex items-center justify-center text-amber-500 group-hover:scale-110 transition-transform">
                    <User size={24} />
                  </div>
                  <div>
                    <h4 className="font-bold text-lg">{m.customerName}</h4>
                    <p className="text-sm text-muted flex items-center gap-2">
                      <span className="bg-subtle px-2 py-0.5 rounded text-warn-strong">{m.type}</span>
                      <span>• تم التحديث في {m.date}</span>
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-8">
                  <div className="hidden md:flex gap-4">
                    {Object.entries(m.data).map(([key, value]) => (
                      <div key={key} className="text-center">
                        <p className="text-[10px] uppercase tracking-wider text-muted font-bold">{key}</p>
                        <p className="text-sm font-black">{value}</p>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    {/* The overflow menu had no handler and no menu behind it.
                        An icon that promises a menu and opens nothing is worse
                        than no icon, so the chevron — which is honest, since it
                        does indicate navigation — is left on its own. */}
                    <ChevronRight size={20} className="text-ink group-hover:text-amber-500 transition-colors" />
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Counted from the loaded rows. This was a hardcoded string saying
            "عرض 2 من أصل 2" regardless of what was loaded, so a tenant with
            400 measurements was told it had 2. */}
        {!isLoading && !error && measurements.length > 0 && (
          <div className="p-4 bg-subtle text-center border-t border-hairline">
            <p className="text-xs text-muted">
              عرض {measurements.length} من أصل {measurements.length} سجل مقاسات
            </p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/*
       * The card that used to sit here was titled "تحليل المقاسات الذكي" and
       * asserted a finding: "لاحظنا أن أغلب عملائك يطلبون ثوب سعودي بمقاسات كتف
       * بين 42-46 سم". Nothing computed that — it was a literal in the JSX,
       * presented as an insight derived from customer data.
       *
       * A business recommendation is exactly the kind of claim that must come
       * from a query. Until one exists, the honest screen shows no analysis at
       * all rather than a plausible one.
       */}
        
        <div className="bg-amber-500/5 border border-amber-500/20 p-8 rounded-3xl">
          <div className="flex items-center gap-4 mb-4">
            <div className="p-3 bg-amber-500 rounded-2xl shadow-lg shadow-amber-500/20">
              {/* White, not ink: this icon sits ON a solid amber badge — ink
                  resolves light in the dark themes and drops to ~2:1 there. */}
              <Ruler className="text-white" size={24} />
            </div>
            <h3 className="font-black text-xl">دليل أخذ المقاسات</h3>
          </div>
          <ul className="space-y-3 text-sm text-faint">
            <li className="flex items-center gap-2"><div className="w-1.5 h-1.5 bg-amber-500 rounded-full"></div> تأكد من وقوف العميل بشكل مستقيم.</li>
            <li className="flex items-center gap-2"><div className="w-1.5 h-1.5 bg-amber-500 rounded-full"></div> اترك مسافة إصبع واحد بين شريط القياس والجسم.</li>
            <li className="flex items-center gap-2"><div className="w-1.5 h-1.5 bg-amber-500 rounded-full"></div> سجل المقاسات بالسنتمتر لضمان الدقة.</li>
          </ul>
        </div>
      </div>
    </div>
  );
};
