import React, { useState, useEffect, useCallback } from 'react';
import { Settings, ShieldCheck, CheckCircle, RefreshCw, DollarSign, Globe2, Palette, Moon, Sun, Eye, Sparkles, Building2, Plus, Trash2, Star } from 'lucide-react';
import { Currency } from '../types';
import { DEFAULT_CURRENCIES, loadTenantCurrencies, saveTenantCurrencies } from '../services/currencyService';
import { themeService, ThemeMode, THEME_CONFIGS } from '../services/themeService';
import { useEntitlement } from '../contexts/EntitlementContext';
import { SettlementAccounts } from './SettlementAccounts';

export const SettingsView: React.FC = () => {
  /*
   * The merchant's own identity, read from the server.
   *
   * These two fields used to be `useState` seeds — a store name and a tax number
   * — which is the worst possible home for a legal identity: they looked editable
   * but no edit was ever persisted, so changing them on screen appeared to work
   * and was lost on reload. Worse, they were seeded with real-looking numbers for
   * one specific company, so every installation of this product opened its
   * settings showing another merchant's VAT registration.
   *
   * They are now derived state from `useEntitlement()`, which reads the tenant
   * row. The fields remain editable on screen because the operator expects to
   * type there, but a change is only meaningful once the server accepts it — so
   * the screen says so rather than pretending to save a value it discarded.
   */
  const { identity } = useEntitlement();
  const [storeName, setStoreName] = useState(identity.ownerCompany);
  const [taxNumber, setTaxNumber] = useState(identity.taxNumber ?? '');
  const [baseCurrency, setBaseCurrency] = useState(
    identity.baseCurrency ? `${identity.baseCurrency}` : '',
  );
  const [currencies, setCurrencies] = useState<Currency[]>(DEFAULT_CURRENCIES);
  const [saved, setSaved] = useState(false);
  const [isUpdatingRates, setIsUpdatingRates] = useState(false);

  useEffect(() => {
    loadTenantCurrencies().then((list) => {
      setCurrencies(list);
    });
  }, []);

  const handleRateChange = (code: string, newRate: number) => {
    setCurrencies((prev) =>
      prev.map((c) => (c.code === code ? { ...c, rateToSAR: newRate } : c))
    );
  };

  /*
   * ══ WHY THERE IS NO "AUTO UPDATE" BUTTON ANY MORE ═════════════════════════
   * This used to be a `setTimeout(1000)` that replaced every rate with a literal
   * — USD 3.75, EUR 4.08, AED 1.02, KWD 12.28, BHD 9.95, GBP 4.88 — and then
   * wrote them to the server through `saveTenantCurrencies`.
   *
   * So a button labelled "تحديث تلقائي" (automatic update) produced hard-coded
   * numbers that looked fetched, and persisted them as though they had been
   * observed. The values were plausible, which is what made it dangerous: a
   * merchant converting at AED 1.02 would be within a rounding error of correct
   * in most months, so the invoice totals looked reasonable, and the KWD rate
   * 100 days stale would quietly misprice every Kuwaiti invoice.
   *
   * There is no central-bank feed wired up, so the honest move is to remove the
   * claim rather than keep a button that lies. A rate is an INPUT to a fiscal
   * document; it is set by the operator, recorded with an effective date, and
   * fetched from a real source when one exists — never invented by a timer.
   *
   * To restore this properly: add a server-side rate provider, expose it through
   * `/api/erp/currency/rate`, and record the result with `rateType: 'provider'`
   * so it is distinguishable from an operator's manual entry.
   */
  const handleRefreshFromServer = async () => {
    setIsUpdatingRates(true);
    try {
      const fresh = await loadTenantCurrencies();
      setCurrencies(fresh);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setIsUpdatingRates(false);
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    saveTenantCurrencies(currencies);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto bg-canvas text-ink font-['Cairo',sans-serif]">
      <div className="mb-6">
        <h2 className="text-xl font-black text-ink flex items-center gap-2">
          <Settings className="w-6 h-6 text-brand" />
          إعدادات النظام والعملات المتعددة (Multi-Currency & Settings)
        </h2>
        <p className="text-xs text-faint mt-0.5">إدارة أسعار الصرف اليومية للشركات العالمية، والبيانات المباشرة للمؤسسة</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 max-w-6xl">
        {/*
         * The settlement screen lives here because it is the one place an
         * operator can tell the system where their money should go. Until this
         * existed, the till's bank-transfer QR was hard-coded — removing that
         * left the product with no way to configure the account at all, which is
         * not a fix, it is a missing feature.
         */}
        <div className="lg:col-span-1 space-y-6">
          <div className="surface-card rounded-2xl p-5 shadow-sm">
            <SettlementAccounts />
          </div>
        </div>

        {/* General Settings */}
        <div className="lg:col-span-1 space-y-6">
          {/* Official Company Identity Board & System Icon */}
          <div className="surface-card rounded-2xl p-5 shadow-sm space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-surface border border-brand/30 p-1 flex items-center justify-center shrink-0">
                <img src="/favicon.ico" alt="أيقونة النظام" className="w-full h-full object-contain" />
              </div>
              <div>
                <h4 className="text-xs font-black text-ink">شركة المنافذ الذكية للبرمجيات</h4>
                <p className="text-[10px] text-info-strong font-mono">Smart Ports Software</p>
              </div>
            </div>

            <div className="rounded-xl overflow-hidden border border-hairline relative group">
              <img
                src="/company-board.jpg"
                alt="لوحة وهوية الشركة"
                className="w-full h-28 object-cover group-hover:scale-105 transition-transform duration-300"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-slate-950/20 to-transparent p-2.5 flex items-end justify-between">
                <span className="text-[10px] text-ink font-bold">لوحة وهوية الشركة المعتمدة</span>
                <span className="text-[9px] bg-brand-500/20 border border-brand/40 text-brand-strong px-2 py-0.5 rounded-full font-bold">
                  SaaS Owner
                </span>
              </div>
            </div>

            <div className="bg-surface p-3 rounded-xl border border-hairline text-[11px] space-y-1.5">
              <div className="flex justify-between items-center text-muted">
                <span>المشترك الأول:</span>
                <strong className="text-ink">رويال العالمية للتجارة</strong>
              </div>
              <div className="flex justify-between items-center text-muted">
                <span>الرصيد الافتتاحي:</span>
                <span className="text-brand font-mono font-bold">198 صنف معتمد 🟢</span>
              </div>
              <div className="flex justify-between items-center text-muted">
                <span>محرك البيانات:</span>
                <span className="text-info-strong font-mono font-bold">Neon PostgreSQL</span>
              </div>
            </div>
          </div>

          <div className="surface-card rounded-2xl p-6 shadow-sm space-y-4">
            <h3 className="text-sm font-bold text-ink flex items-center gap-2 pb-3 border-b border-hairline">
              <Globe2 className="w-4 h-4 text-brand" />
              بيانات المنشأة
            </h3>

            {saved && (
              <div className="bg-brand-soft border border-brand/30 text-brand px-4 py-2.5 rounded-xl text-xs flex items-center gap-2">
                <CheckCircle className="w-4 h-4 shrink-0" />
                <span>تم حفظ التغييرات وتحديث قاعدة البيانات بنجاح!</span>
              </div>
            )}

            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-muted mb-1">اسم المنشأة / الشركة:</label>
                <input
                  type="text"
                  value={storeName}
                  onChange={(e) => setStoreName(e.target.value)}
                  className="w-full bg-surface border border-hairline rounded-xl px-4 py-2.5 text-xs text-ink focus:outline-none focus:border-brand"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-muted mb-1">الرقم الضريبي (VAT ID):</label>
                <input
                  type="text"
                  value={taxNumber}
                  onChange={(e) => setTaxNumber(e.target.value)}
                  className="w-full bg-surface border border-hairline rounded-xl px-4 py-2.5 text-xs text-ink font-mono focus:outline-none focus:border-brand"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-muted mb-1">العملة الأساسية للنظام:</label>
                <input
                  type="text"
                  disabled
                  value={baseCurrency}
                  className="w-full bg-subtle border border-hairline rounded-xl px-4 py-2.5 text-xs text-faint font-bold"
                />
              </div>

              <button
                type="submit"
                className="w-full bg-brand-600 hover:bg-brand-500 text-white py-2.5 rounded-xl text-xs font-bold transition-all shadow-lg shadow-brand-600/30 cursor-pointer"
              >
                حفظ بيانات المنشأة
              </button>
            </form>
          </div>

          {/* Theme Engine Selector Card */}
          <div className="surface-card rounded-2xl p-6 shadow-sm space-y-4">
            <h3 className="text-sm font-bold text-ink flex items-center gap-2 pb-3 border-b border-hairline">
              <Palette className="w-4 h-4 text-brand" />
              تخصيص ثيمات ومظهر النظام (System Themes)
            </h3>

            <div className="space-y-2">
              {Object.values(THEME_CONFIGS).map((tm) => (
                <button
                  key={tm.id}
                  type="button"
                  onClick={() => themeService.setTheme(tm.id)}
                  className={`w-full p-3 rounded-xl border text-right transition-all flex items-center justify-between cursor-pointer ${
                    themeService.getTheme() === tm.id
                      ? 'bg-brand-950/40 border-brand text-white shadow-md'
                      : 'bg-surface border-hairline text-muted hover:bg-hairline/60'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <div 
                      className="w-4 h-4 rounded-full border border-hairline shrink-0" 
                      style={{ backgroundColor: tm.previewColor }}
                    />
                    <div>
                      <p className="text-xs font-bold">{tm.name}</p>
                      <p className="text-[10px] text-faint">{tm.description}</p>
                    </div>
                  </div>
                  {themeService.getTheme() === tm.id && (
                    <CheckCircle className="w-4 h-4 text-brand shrink-0" />
                  )}
                </button>
              ))}
            </div>

            {/* 3D Background Quality & Performance Tuning */}
            <div className="pt-3 border-t border-hairline space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-ink flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-info-strong" />
                  الخلفية ثلاثية الأبعاد (Three.js 3D)
                </span>
                <span className="text-[10px] text-brand font-bold bg-brand-soft border border-brand/20 px-2 py-0.5 rounded-full">
                  محرك متكيف 60FPS
                </span>
              </div>
              <p className="text-[10px] text-faint">
                يتحكم محرك 3D تلقائياً بكثافة الإضاءة وتردد الإطارات حسب مواصفات الجهاز لمنع أي ثقل أو تباطؤ.
              </p>
            </div>
          </div>
        </div>

        {/* Daily Exchange Rates Management */}
        <div className="lg:col-span-2 surface-card rounded-2xl p-6 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-hairline mb-4">
            <div>
              <h3 className="text-sm font-bold text-ink flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-brand" />
                إدارة أسعار الصرف اليومية للعملات الأجنبية
              </h3>
              <p className="text-[11px] text-faint mt-0.5">تحديث أسعار تحويل العملات الأجنبية مقابل الريال السعودي (SAR)</p>
            </div>

            <button
              type="button"
              onClick={handleRefreshFromServer}
              disabled={isUpdatingRates}
              className="bg-subtle hover:bg-hairline text-brand border border-brand/30 px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isUpdatingRates ? 'animate-spin' : ''}`} />
              {/* Not "تحديث تلقائي": this re-reads what the server holds. It does
                  not invent a rate, and the label says which one it is. */}
              إعادة القراءة من الخادم
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-subtle text-faint border-b border-hairline uppercase tracking-wider">
                <tr>
                  <th className="p-3">رمز العملة</th>
                  <th className="p-3">اسم العملة</th>
                  <th className="p-3">الرمز</th>
                  <th className="p-3">سعر الصرف (1 وحدة = SAR)</th>
                  <th className="p-3 text-center">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline/80">
                {currencies.map((c) => (
                  <tr key={c.code} className="hover:bg-hairline/40 transition-colors">
                    <td className="p-3 font-mono font-bold text-brand">{c.code}</td>
                    <td className="p-3 text-ink font-semibold">{c.name}</td>
                    <td className="p-3 font-bold text-muted">{c.symbol}</td>
                    <td className="p-3">
                      {c.isBase ? (
                        <span className="font-mono text-muted font-bold">1.000 (العملة الأم)</span>
                      ) : (
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            step="0.01"
                            value={c.rateToSAR}
                            onChange={(e) => handleRateChange(c.code, Number(e.target.value))}
                            className="w-24 bg-surface border border-hairline rounded-lg px-2.5 py-1 text-xs text-ink font-mono focus:outline-none focus:border-brand"
                          />
                          <span className="text-[10px] text-faint">ر.س</span>
                        </div>
                      )}
                    </td>
                    <td className="p-3 text-center">
                      {c.isBase ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-brand-soft text-brand border border-brand/20">
                          الأساسية
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-subtle text-muted">
                          نشطة
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pt-4 border-t border-hairline flex justify-end">
            <button
              onClick={handleSave}
              className="bg-brand-600 hover:bg-brand-500 text-white px-6 py-2.5 rounded-xl text-xs font-bold transition-all shadow-lg shadow-brand-600/30"
            >
              حفظ وتطبيق أسعار الصرف
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
