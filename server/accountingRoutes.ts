import type { Express } from 'express';
import { pool } from './neonDb.js';
import { asyncRoute, tenantOf, fail, makeId } from './apiHelpers.js';
import { attachPrincipal, requirePermission } from './authz.js';

/**
 * Account balances and the fixed-asset register.
 *
 * ══ WHY BALANCES ARE COMPUTED, NEVER STORED ═══════════════════════════════
 * A balance is `SUM(debit) - SUM(credit)` within a tenant, over a period.
 * Storing it would create a second version of the truth that everything touching
 * the ledger would have to keep in step, and it would inevitably drift — after a
 * back-dated invoice, a void, or a period close.
 *
 * Computing on read means the balance can never disagree with the entries that
 * produced it, and any figure can be explained by pointing at the rows behind it.
 *
 * ══ WHY THIS MODULE EXISTS AT ALL ═════════════════════════════════════════
 * `dypos.ledger` had no `tenant_id` until migration v144. This is the module
 * where that gap would have been most damaging: a balance summed over a table
 * with no tenant column is a balance across every customer on the system.
 */
export function registerAccountingRoutes(app: Express) {
  /*
   * The permission codes used below — `ledger.view` and `ledger.post` — are the
   * ones seeded in `dypos.role_permissions`. An earlier draft asked for
   * `ledger.read` / `ledger.write`, which are NOT seeded.
   *
   * That failure mode is worth recording: it is fail-CLOSED, so nothing leaks,
   * but every request returns 403 "insufficient permission" to a user who
   * legitimately holds the right, and the symptom reads as a permissions
   * problem rather than a typo. A gate on a name nobody was ever granted looks
   * exactly like a correctly working gate until someone who should see the
   * screen reports they cannot.
   */

  /* ══ Account balances ══════════════════════════════════════════════════ */

  /**
   * One row per account code: movement in the period, plus the running balance.
   *
   * `carried` sums everything BEFORE `from`, which is what makes the balance a
   * real balance rather than just the movement inside the window — the most
   * common error in a hand-rolled balance report, and one that looks plausible.
   */
  app.get(
    '/api/accounting/balances',
    attachPrincipal,
    requirePermission('ledger.view'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const from = typeof req.query.from === 'string' ? req.query.from : null;
      const to = typeof req.query.to === 'string' ? req.query.to : null;

      try {
        const { rows } = await pool.query(
          `WITH movement AS (
             SELECT account_code,
                    MAX(account_name)          AS account_name,
                    SUM(debit)                 AS period_debit,
                    SUM(credit)                AS period_credit
               FROM dypos.ledger
              WHERE tenant_id = $1
                AND ($2::date IS NULL OR created_at::date >= $2::date)
                AND ($3::date IS NULL OR created_at::date <= $3::date)
              GROUP BY account_code
           ),
           carried AS (
             SELECT account_code,
                    SUM(debit) - SUM(credit)  AS carried_balance
               FROM dypos.ledger
              WHERE tenant_id = $1
                AND ($2::date IS NULL OR created_at::date < $2::date)
              GROUP BY account_code
           )
           SELECT m.account_code,
                  m.account_name,
                  COALESCE(m.period_debit, 0)  AS period_debit,
                  COALESCE(m.period_credit, 0) AS period_credit,
                  COALESCE(m.period_debit, 0) - COALESCE(m.period_credit, 0)
                    + COALESCE(c.carried_balance, 0) AS balance
             FROM movement m
             LEFT JOIN carried c ON c.account_code = m.account_code
            ORDER BY m.account_code`,
          [tenant, from, to],
        );

        const items = rows.map((r: Record<string, unknown>) => {
          const debit = Number(r.period_debit);
          const credit = Number(r.period_credit);
          const balance = Number(r.balance);
          return {
            accountCode: r.account_code,
            accountName: r.account_name ?? r.account_code,
            periodDebit: debit,
            periodCredit: credit,
            balance,
            side: balance > 0 ? 'debit' : balance < 0 ? 'credit' : 'flat',
          };
        });

        const totalDebit = items.reduce((s, i) => s + i.periodDebit, 0);
        const totalCredit = items.reduce((s, i) => s + i.periodCredit, 0);

        res.json({
          items,
          count: items.length,
          totals: {
            periodDebit: totalDebit,
            periodCredit: totalCredit,
            /*
             * Whether the trial balance balances. Computed and RETURNED rather
             * than left for a human to notice: if this is false the accounting is
             * telling you something is wrong, and the screen can say so.
             */
            balanced: Math.abs(totalDebit - totalCredit) < 0.01,
            difference: Number((totalDebit - totalCredit).toFixed(2)),
          },
          period: { from, to },
        });
      } catch (err: unknown) {
        console.error('[dypos-api] balances failed', err);
        res.status(500).json({ error: (err as Error).message });
      }
    }),
  );

  /* ══ Fixed assets ══════════════════════════════════════════════════════ */

  app.get('/api/assets', attachPrincipal, requirePermission('ledger.view'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const status = typeof req.query.status === 'string' ? req.query.status : null;
      try {
        const { rows } = await pool.query(
          `SELECT * FROM dypos.assets
            WHERE tenant_id = $1 AND ($2::varchar IS NULL OR status = $2)
            ORDER BY acquisition_date DESC`,
          [tenant, status],
        );

        const items = rows.map((r: Record<string, unknown>) => ({
          id: r.id,
          assetTag: r.asset_tag,
          name: r.name,
          category: r.category,
          acquisitionDate: r.acquisition_date,
          acquisitionCost: Number(r.acquisition_cost),
          salvageValue: Number(r.salvage_value),
          usefulLifeMonths: Number(r.useful_life_months),
          depreciationMethod: r.depreciation_method,
          accumulatedDepreciation: Number(r.accumulated_depreciation),
          status: r.status,
          disposalDate: r.disposal_date ?? null,
          notes: r.notes ?? null,
          // Net book value DERIVED, never stored. A stored NBV would be a second
          // copy of a number two other columns already determine, and would drift
          // the first time either of them changed.
          netBookValue: Number(r.acquisition_cost) - Number(r.accumulated_depreciation),
        }));

        res.json({
          items,
          count: items.length,
          totals: {
            cost: items.reduce((s, i) => s + i.acquisitionCost, 0),
            accumulatedDepreciation: items.reduce((s, i) => s + i.accumulatedDepreciation, 0),
            netBookValue: items.reduce((s, i) => s + i.netBookValue, 0),
          },
        });
      } catch (err: unknown) {
        console.error('[dypos-api] assets list failed', err);
        res.status(500).json({ error: (err as Error).message });
      }
    }));

  app.post('/api/assets', attachPrincipal, requirePermission('ledger.post'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const b = (req.body || {}) as Record<string, unknown>;

      /*
       * Validated HERE as well as by the CHECK constraints, so the operator gets
       * a message naming the field rather than a bare constraint violation. The
       * constraints remain as the last line: the API is a caller, not an
       * authority.
       */
      const cost = Number(b.acquisitionCost);
      const salvage = Number(b.salvageValue ?? 0);
      const life = Number(b.usefulLifeMonths);

      if (!b.name || !String(b.name).trim()) return fail(res, 400, 'اسم الأصل مطلوب');
      if (!b.assetTag || !String(b.assetTag).trim()) return fail(res, 400, 'الرقم التسلسلي للأصل مطلوب');
      if (!b.category) return fail(res, 400, 'تصنيف الأصل مطلوب');
      if (!b.acquisitionDate) return fail(res, 400, 'تاريخ الشراء مطلوب');
      if (!Number.isFinite(cost) || cost <= 0) {
        return fail(res, 400, 'تكلفة الشراء يجب أن تكون رقماً أكبر من صفر');
      }
      if (!Number.isFinite(salvage) || salvage < 0 || salvage > cost) {
        return fail(res, 400, 'قيمة الخردة يجب أن تكون بين صفر وتكلفة الشراء');
      }
      if (!Number.isInteger(life) || life <= 0) {
        return fail(res, 400, 'العمر الإنتاجي بالأشهر يجب أن يكون رقماً صحيحاً أكبر من صفر');
      }

      const id = makeId('asset');
      try {
        const { rows } = await pool.query(
          `INSERT INTO dypos.assets
             (id, tenant_id, branch_id, asset_tag, name, category,
              acquisition_date, acquisition_cost, salvage_value,
              useful_life_months, depreciation_method, status, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING *`,
          [
            id, tenant, b.branchId ?? null,
            String(b.assetTag).trim(), String(b.name).trim(), String(b.category),
            b.acquisitionDate, cost, salvage, life,
            b.depreciationMethod ?? 'straight_line',
            b.status ?? 'in_use', b.notes ?? null,
          ],
        );

        const r = rows[0];
        res.status(201).json({
          item: {
            id: r.id, assetTag: r.asset_tag, name: r.name, category: r.category,
            acquisitionDate: r.acquisition_date, acquisitionCost: Number(r.acquisition_cost),
            salvageValue: Number(r.salvage_value), usefulLifeMonths: Number(r.useful_life_months),
            depreciationMethod: r.depreciation_method,
            accumulatedDepreciation: Number(r.accumulated_depreciation),
            status: r.status,
            // Zero depreciation on the day it is bought — it has not aged a month.
            // Stated rather than left for the first depreciation run to fill in,
            // so the register is true the moment the asset exists.
            netBookValue: Number(r.acquisition_cost),
          },
        });
      } catch (err: unknown) {
        // A duplicate asset tag within one tenant is a real conflict, not a
        // server fault, and the message has to say what to change.
        if ((err as { code?: string }).code === '23505') {
          return fail(res, 409, 'الرقم التسلسلي للأصل مستخدم بالفعل في هذا المستأجر');
        }
        console.error('[dypos-api] asset create failed', err);
        res.status(500).json({ error: (err as Error).message });
      }
    }));
}