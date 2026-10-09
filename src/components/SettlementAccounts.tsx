import React, { useState, useEffect, useCallback } from 'react';
import { Building2, Plus, Trash2, Star, RefreshCw, AlertTriangle } from 'lucide-react';
import { apiGet, apiPost, apiPut } from '../services/dyposApi';

interface SettlementAccount {
  id: string;
  branchId: string | null;
  iban: string;
  bankName: string | null;
  holderName: string | null;
  paymentMethod: string;
  isDefault: boolean;
}

type LoadState = 'loading' | 'ready' | 'error';

const EMPTY_FORM = { iban: '', bankName: '', holderName: '', countryCode: '' };

/** Groups an IBAN into blocks of four. Presentation only; the stored value is compact. */
function formatIban(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
}

/*
 * THIS IS NOT AN IBAN VALIDATOR, AND IT DOES NOT PRETEND TO BE.
 * It checks SHAPE only: a country prefix is present and the length is plausible.
 * It deliberately does NOT verify the check digits.
 *
 * A green "valid" from a screen that never contacted the issuing bank is the same
 * class of defect as the invented exchange rates: a control reporting a fact it has
 * not established. The merchant's bank issues the IBAN and the server is the
 * authority on whether it exists, so this reports SHAPE and says so.
 */
function ibanProblem(value: string): string | null {
  const compact = value.replace(/\s+/g, '').toUpperCase();
  if (!compact) return 'IBAN is required';
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) {
    return 'Malformed: an IBAN starts with a 2-letter country code, then 2 digits';
  }
  if (compact.length < 15) return 'IBAN is too short';
  if (compact.length > 34) return 'IBAN is too long';
  return null;
}

/**
 * Bank settlement accounts: the merchant's own screen for where their money goes.
 *
 * WHY THIS SCREEN EXISTS
 * Removing the compiled-in IBAN was only half the fix. The till now reads its QR
 * from GET /api/db/settlement/accounts, and an account can only come from that
 * route. Without a screen that WRITES one, a merchant cannot configure bank
 * transfer at all and the payment method silently disappears from the till.
 *
 * That is the more insidious version of the original defect: not a wrong account,
 * but no account, with nothing to explain why bank transfer vanished.
 */
export const SettlementAccounts: React.FC = () => {
  const [accounts, setAccounts] = useState<SettlementAccount[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setError('');
    try {
      const res = await apiGet<{ items: SettlementAccount[] }>('/api/db/settlement/accounts');
      setAccounts(Array.isArray(res.items) ? res.items : []);
      setState('ready');
    } catch (err) {
      // Shown, not swallowed: a merchant who cannot see WHY bank transfer is
      // unavailable will conclude the feature is broken, not that they lack the
      // permission to manage it.
      setError(err instanceof Error ? err.message : 'Could not load settlement accounts');
      setState('error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const problem = ibanProblem(form.iban);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problem) return;
    setBusy(true);
    setNotice(null);
    try {
      await apiPost<void>('/api/db/settlement/accounts', {
        iban: form.iban,
        bankName: form.bankName.trim() || null,
        holderName: form.holderName.trim() || null,
        countryCode: form.countryCode.trim().toUpperCase() || null,
        paymentMethod: 'bank_transfer',
        // The first account is implicitly the default: there is nothing to
        // prefer it over, and the till reads the default first.
        isDefault: accounts.length === 0,
      });
      setForm(EMPTY_FORM);
      await load();
      setNotice({ kind: 'ok', text: 'Saved. This account is now offered at the till.' });
    } catch (err) {
      setNotice({ kind: 'warn', text: err instanceof Error ? err.message : 'Could not save' });
    } finally {
      setBusy(false);
    }
  };

  /*
   * Deactivation, never deletion.
   *
   * An account that received settlements must stay resolvable so historical
   * transfers can still be traced to a destination. DELETE would erase the only
   * record of where the money went.
   */
  const deactivate = async (id: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await apiPut<void>(`/api/db/settlement/accounts/${id}`, { isActive: false });
      await load();
      setNotice({ kind: 'ok', text: 'Account deactivated. It is no longer offered at the till.' });
    } catch (err) {
      setNotice({ kind: 'warn', text: err instanceof Error ? err.message : 'Could not deactivate' });
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (id: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await apiPut<void>(`/api/db/settlement/accounts/${id}`, { isDefault: true });
      await load();
    } catch (err) {
      setNotice({ kind: 'warn', text: err instanceof Error ? err.message : 'Could not set default' });
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    'w-full bg-surface border border-hairline rounded-lg px-3 py-2 text-xs text-ink focus:outline-none focus:border-brand';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-ink flex items-center gap-2">
          <Building2 className="w-4 h-4 text-brand" />
          <span>Bank settlement accounts</span>
        </h3>
        <button
          type="button"
          onClick={() => void load()}
          disabled={state === 'loading'}
          className="text-[11px] text-faint hover:text-ink flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${state === 'loading' ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* An empty list is a NORMAL state, not an error: a merchant who has not
          set one up simply does not have bank transfer yet, and the till says so
          rather than offering someone else's account. */}
      {state === 'ready' && accounts.length === 0 && (
        <div className="rounded-xl border border-dashed border-hairline p-4 text-center text-xs text-faint">
          No settlement accounts configured. Bank transfer stays unavailable at the
          till until one is added.
        </div>
      )}

      {state === 'error' && (
        <div className="rounded-xl border border-red-800/50 bg-red-950/30 p-3 text-xs text-red-300 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {state === 'ready' && accounts.length > 0 && (
        <ul className="space-y-2">
          {accounts.map((a) => (
            <li
              key={a.id}
              className="rounded-xl border border-hairline bg-subtle p-3 flex items-start justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="text-xs font-mono text-brand-strong break-all">{formatIban(a.iban)}</p>
                <p className="text-[11px] text-faint mt-0.5">
                  {[a.bankName, a.holderName].filter(Boolean).join(' — ') || 'No bank name'}
                </p>
                {a.isDefault && (
                  <span className="inline-flex items-center gap-1 mt-1 text-[10px] text-warn-strong">
                    <Star className="w-3 h-3" /> Default account
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!a.isDefault && (
                  <button
                    type="button"
                    onClick={() => void makeDefault(a.id)}
                    disabled={busy}
                    title="Make default"
                    aria-label="Make default"
                    className="p-1.5 rounded-lg bg-subtle hover:bg-hairline text-muted disabled:opacity-50"
                  >
                    <Star className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void deactivate(a.id)}
                  disabled={busy}
                  title="Deactivate"
                  aria-label="Deactivate"
                  className="p-1.5 rounded-lg bg-subtle hover:bg-red-900/60 text-muted disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {notice && (
        <p className={`text-[11px] ${notice.kind === 'ok' ? 'text-ok-strong' : 'text-warn-strong'}`}>
          {notice.text}
        </p>
      )}

      <form onSubmit={submit} className="rounded-xl border border-hairline p-3 space-y-2 bg-subtle">
        <p className="text-[11px] font-bold text-muted flex items-center gap-1.5">
          <Plus className="w-3.5 h-3.5" /> Add an account
        </p>
        <input
          value={form.iban}
          onChange={(e) => setForm({ ...form, iban: e.target.value })}
          placeholder="SA00 0000 0000 0000 0000 00"
          inputMode="text"
          autoComplete="off"
          aria-label="IBAN"
          className={`${inputClass} font-mono`}
        />
        {/* The hint appears BEFORE submit, so a merchant is not taught the format
            through a failed round trip. */}
        {form.iban && problem && <p className="text-[10px] text-warn-strong">{problem}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            value={form.bankName}
            onChange={(e) => setForm({ ...form, bankName: e.target.value })}
            placeholder="Bank name"
            aria-label="Bank name"
            className={inputClass}
          />
          <input
            value={form.holderName}
            onChange={(e) => setForm({ ...form, holderName: e.target.value })}
            placeholder="Account holder"
            aria-label="Account holder"
            className={inputClass}
          />
          <input
            value={form.countryCode}
            onChange={(e) => setForm({ ...form, countryCode: e.target.value.slice(0, 2) })}
            placeholder="SA"
            maxLength={2}
            aria-label="Country code"
            className={`${inputClass} font-mono uppercase`}
          />
        </div>
        <button
          type="submit"
          disabled={busy || Boolean(problem)}
          className="px-4 py-2 rounded-lg bg-brand-700 hover:bg-brand-600 text-white text-xs font-bold disabled:opacity-40 flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" /> Save account
        </button>
      </form>
    </div>
  );
};

export default SettlementAccounts;