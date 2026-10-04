/**
 * Currencies are served by the DyPOS ERP API, not Firestore.
 *
 * This module used to read and write exchange rates through the Firebase SDK.
 * That put a 527 KB SDK on the critical sales path (POS and Settings both import
 * this file) purely to fetch data the `/api/erp/currencies` endpoint already
 * owns — and it bypassed the tenant's RBAC and the effective-dated rate history
 * in `dypos.currency_rates`. Edits are cached locally so an offline terminal
 * still opens with the rates it last saw.
 */
import { apiGet, apiPost } from './dyposApi';
import { Currency } from '../types';

const CACHE_KEY = 'dypos_currencies_cache';

export const DEFAULT_CURRENCIES: Currency[] = [
  { code: 'SAR', name: 'الريال السعودي', symbol: 'ر.س', rateToSAR: 1.0, isBase: true },
  { code: 'USD', name: 'الدولار الأمريكي', symbol: '$', rateToSAR: 3.75 },
  { code: 'EUR', name: 'اليورو الأوروبي', symbol: '€', rateToSAR: 4.10 },
  { code: 'AED', name: 'الدرهم الإماراتي', symbol: 'د.إ', rateToSAR: 1.02 },
  { code: 'KWD', name: 'الدينار الكويتي', symbol: 'د.ك', rateToSAR: 12.25 },
  { code: 'BHD', name: 'الدينار البحريني', symbol: 'د.ب', rateToSAR: 9.95 },
  { code: 'GBP', name: 'الجنيه الإسترليني', symbol: '£', rateToSAR: 4.85 },
];

/** Reads the local cache written by the last successful sync. */
const readCache = (): Currency[] | null => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? (parsed as Currency[]) : null;
  } catch {
    return null;
  }
};

const writeCache = (list: Currency[]) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(list));
  } catch {
    /* a full or disabled storage must not break the till */
  }
};

/**
 * Maps an API currency row (code/exchange_rate) onto the client shape.
 * `exchange_rate` is units of the currency per SAR, matching `rateToSAR`.
 */
const fromApi = (row: any): Currency => ({
  code: String(row.code),
  name: String(row.name ?? row.code),
  symbol: String(row.symbol ?? row.code),
  rateToSAR: Number(row.exchange_rate ?? 1) || 1,
  isBase: Boolean(row.is_base),
});

/**
 * Convert SAR amount to target foreign currency
 */
export const convertFromSAR = (amountInSAR: number, targetCurrency: Currency): number => {
  if (!targetCurrency || targetCurrency.rateToSAR <= 0 || targetCurrency.code === 'SAR') {
    return amountInSAR;
  }
  return amountInSAR / targetCurrency.rateToSAR;
};

/**
 * Format Dual Currency display string
 * e.g. "1,500.00 ر.س ($400.00 USD)"
 */
export const formatDualCurrency = (amountInSAR: number, secondaryCurrency?: Currency): string => {
  const primaryFormatted = `${amountInSAR.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ر.س`;
  
  if (!secondaryCurrency || secondaryCurrency.code === 'SAR') {
    return primaryFormatted;
  }

  const foreignVal = convertFromSAR(amountInSAR, secondaryCurrency);
  const secondaryFormatted = `${secondaryCurrency.symbol}${foreignVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${secondaryCurrency.code}`;

  return `${primaryFormatted} (${secondaryFormatted})`;
};

/**
 * Loads the tenant's active currencies.
 *
 * Order of preference: live API, then the last cached snapshot (so an offline
 * till keeps working), then the built-in defaults.
 */
export const loadTenantCurrencies = async (): Promise<Currency[]> => {
  try {
    const res = await apiGet<{ items: any[] }>('/api/erp/currencies');
    if (Array.isArray(res.items) && res.items.length) {
      const list = res.items.map(fromApi);
      writeCache(list);
      return list;
    }
  } catch (err) {
    console.warn('تعذّر جلب أسعار الصرف — استخدام النسخة المحفوظة', err);
  }
  return readCache() ?? DEFAULT_CURRENCIES;
};

/**
 * Persists an edited rate as a new effective-dated entry.
 *
 * Writes go through the ERP endpoint so the change is permission-checked and
 * lands in the auditable rate history. The cache is updated first so the UI
 * reflects the edit even if the write is rejected or the terminal is offline.
 */
export const saveTenantCurrencies = async (currencies: Currency[]): Promise<boolean> => {
  writeCache(currencies);
  try {
    for (const c of currencies) {
      if (c.isBase) continue;
      await apiPost('/api/erp/currency/rate', {
        from: 'SAR',
        to: c.code,
        rate: c.rateToSAR,
        rateType: 'manual',
        source: 'settings-screen',
      });
    }
    return true;
  } catch (err) {
    console.error('تعذّر حفظ أسعار الصرف على الخادم — حُفظت محلياً', err);
    return false;
  }
};
