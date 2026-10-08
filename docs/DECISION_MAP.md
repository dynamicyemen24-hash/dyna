# Decision map — autonomous engineering

Measured, not estimated. Each item states the evidence that put it here.

## P0 — Authentication was decorative (FIXED)

The sign-in screen ran a "2FA" step entirely in the browser:

| Before | Consequence |
|---|---|
| `validateTwoFactor` compared digits to `DEFAULT_OTP` (`['8','8','2','1','0','4']`) | the factor shipped in the public bundle |
| The code was **printed on the sign-in screen** (`882104`) | any person at an idle terminal could complete someone else's sign-in |
| `/api/auth/login` issued the token **before** the code step | the session was already usable regardless of what was typed |
| Break-glass compared to `SUP1999` / `EMRG9999` / `breakglass` | a six-character string was a universal admin backdoor that skipped the password |
| Biometric called `onLogin({ role: 'مدير النظام الرئيسي' })` after a timer | granted admin with no credential and no server call |
| SSO did the same after 900ms | same |
| Credentials prefilled (`admin@royal-global.com` / `1234`) | handed an identity to anyone at the terminal |

There was **no MFA code on the server at all** (`grep -i 'otp\|mfa\|2fa'` over
`server/*.ts` → empty).

Fixed with a two-phase, server-enforced flow: `server/mfa.ts`, migration
`v138`, `/api/auth/mfa/verify` as the only place a token is minted, hashed
codes, constant-time compare, per-challenge and per-user budgets, and
break-glass as an issued single-use audited grant. Proof: `npm run test:mfa`.

## P1 — POS recorded sales that were never paid (FIXED)

`paymentGatewayService.processPayment` returned `status: 'paid'` with
`approvalCode: 'APPRV-<random>'` after `setTimeout(1200)` — no provider was ever
contacted. `POSView` then ignored the response and wrote the invoice, so a card
payment "succeeded" instantly and the shortfall surfaced days later at
reconciliation. The receipt additionally fabricated an invoice number, cashier
name and branch id.

Fixed to fail closed: `unavailable` status, no invented ids, and the sale is not
recorded unless the authorisation is genuinely `paid`.

## P2 — Runtime crashes hidden behind the build error (FIXED)

The build stopped at the missing `Dashboard`, which masked three defects that
`tsc` then revealed. All were crashes, not type noise:

- `App.tsx` called `useEntitlement()` without importing it → `ReferenceError`
  before any screen rendered.
- `MainLayout` read `permitted` / `matches` / `inQuery` ~100 lines before their
  `const` declarations (temporal dead zone) → white screen before login.
- `LoginView` referenced `handleNumpadKey`, `bioScanning`, `setAuthBusy` and
  `username` that were never declared → touchpad and biometric paths threw
  "is not a function"; the 2FA double-submit guard was dead code.
- `LoginView` also had an `<input>` closed with `>` while a `</button>` had no
  opening tag — uncompilable.

## P3 — `/api/auth/unlock` was an unauthenticated bypass (FIXED)

The route read `userId` from the **request body**, checked the row was active,
verified that `credential` was merely **non-empty**, and returned `{ ok: true }`.

```
POST /api/auth/unlock
{ "userId": "<any active user>", "method": "face", "credential": "x" }
→ { "ok": true }
```

No token, no real check — and `AuthContext.biometricUnlock` reported success on
that basis, so asking the question *was* the authentication. The caller chose
both the identity being unlocked and the proof.

Now: `attachPrincipal` is required, the identity comes from the **token** (the
`Principal` type has no tenant field, so the token payload is the authority), the
subject must be the caller, and a PIN is checked against the real PBKDF2 hash
under the login path's own lockout. Biometrics return `501` — "not enrolled" —
rather than a fabricated success.

Proof: `npm run test:unlock` (11 assertions, negative cases first).

## P4 — Stale pooled connections produced phantom 500s (FIXED)

`server/neonDb.ts` set `idleTimeoutMillis: 30000` — **longer** than Neon keeps an
idle socket alive. The provider closed connections the pool still considered
usable, and the next query on one failed with "Connection terminated due to
connection timeout", surfacing as a 500 on a route that had done nothing wrong.

Found by `test:unlock` failing six assertions at once, which is what a transport
fault looks like rather than a logic fault. The fix is in the shared pool
(release sockets before the server drops them, plus an `error` listener so a
recycled socket cannot become an unhandled event that kills the process), not in
the test that exposed it.

## P5 — A plaintext credential in the source tree (FIXED)

`.tmp_pw` sat in the project root holding a 20-character secret, alongside eight
other `.tmp_*` scratch files. Deleted, and `.tmp*` / `scratch/` are now ignored
so the next one cannot be committed. Runtime state lives **outside** the tree at
`D:\SulationDy\.runtime`, per §9.

## P6 — `IntelligenceCenter` reported analysis it never performed (FIXED)

Every figure on the executive screen was typed in:

| Fabricated | Reality |
|---|---|
| `45,200.00 ر.س · +18%`, `128,400.00 · −2%`, `12,500.00 · −15%`, `4.2x` | no query produced them |
| bar chart `[65, 45, 85, 30, 95, 70, 50, 80, 40, 60, 90, 55]` | a literal array |
| category split `45/30/15/10%` | a literal array |
| an "AI Generated" recommendation **naming real branches** ("فرع الرياض… يتفوق بهوامش 12%… نوصي بنقل 15% من مخزون جدة") | produced by `setTimeout(2000)` — no model, no data |
| `fetch('/api/db/health')` | **that endpoint does not exist**; the failure went to `console.error` and the screen rendered as though complete |

A leadership dashboard that invents its own numbers is worse than no dashboard,
because a decision gets made on it. It now reads three real reports that already
exist and are already used by the home screen — `daily-sales`, `by-branch`,
`by-category` — with no new endpoint and no second definition of any figure. The
change percentage is computed by splitting the real series at its midpoint; a
failed source is named in a banner above the numbers rather than rendered as an
empty section.

## Deployed to production

Live: **https://dyposcloud.smartportssoft.com** · Version `8818522e-f965-4fc8-89ed-558d0c148fcc`
Rollback point: `d0ab1d7d-5b23-4954-9073-fd8fd6e7a4d8`

Credentials were **discovered, not assumed** (§2): `wrangler whoami` showed an
active OAuth session on account `ce1007ca229319e79c9305f0b954536a` with
`workers (write)` and `workers_routes (write)`. Eleven prior deployments were
listed by the account, the last on 2026-10-03. `DATABASE_URL` and
`DYPOS_SESSION_SECRET` were already present as Worker secrets.

### Post-deployment verification (§36) — measured, not assumed

| Check | Result |
|---|---|
| `GET /` | **200** |
| `GET /api/db/branches` | **200** |
| `GET /branches` (SPA deep link) | **200** — falls back to `index.html`, not 404 |
| `POST /api/auth/unlock` **without a token** | **401 `جلسة غير موثقة`** — the bypass returns nothing |
| Deployed `IntelligenceCenter` bundle | contains `by-branch` / `by-category`; contains **no** `45,200` / `128,400` / `4.2x` |

The last two rows are the point of the deployment: the bypass is closed on the
public URL, and the executive screen is serving measured figures rather than
typed-in ones. Verified against the live asset, not the local build.

## Open, ranked

### Measured and paid since this map was written

| # | Item | Status | Proof |
|---|---|---|---|
| 3 | `tsconfig` has no `strict` | **CLOSED.** Measured: a probe config with `strict: true` over the real program produced **zero** diagnostics, and the probe was verified to detect real violations. The backlog was already paid down. | `npm run lint` |
| 5 | No deployment pipeline | **CLOSED.** `.github/workflows/gate.yml`: type-check → constitution → encoding → offline → theme → primitives → build on every push; database suites and deploy are manual; deploy publishes the exact artifact that passed and then checks the live URL. | `npm run ci` |
| 6 | No git repository | **CLOSED.** Initialised with a `.gitignore` that keeps `.env`, `dist/`, `dist-server/` and the operational debris out of every commit. | `git log` |
| — | `lint` was non-deterministic | **CLOSED.** Without `include`, `tsc` swept `dist/` and `dist-server/server.mjs` into its own program, so the result depended on whether a build had been run. | `tsc --listFilesOnly` |

### The constitution: no tenant data may be compiled in

A SaaS product sold to more than one merchant cannot carry a literal identity in
its bundle. A hard-coded VAT number is not a cosmetic bug — it means customer #2
receives tax invoices bearing customer #1's registration, and every value on
those documents is internally consistent, so nothing downstream detects it.

| Removed | Was | Now |
|---|---|---|
| Receipt header: company, branch, `300123456700003` | JSX text nodes | `dypos.tenants` + `dypos.branches`, resolved once per session |
| PDF: `VAT ID: 300123456700003` and the words "ZATCA Compliant" | literals | `identity.taxNumber`; an unresolved identity is marked **on the document** |
| Settlement IBAN | a literal **and** a default parameter argument | per-tenant `bank_settlement_accounts` (v147, RLS); the IBAN is a required argument that returns `null` |
| Login branch list | Riyadh / Jeddah / Dammam | the tenant's real branches; "not loaded" and "none exist" are distinct states |
| Settings company + tax number | `useState` seeds, never persisted | derived from the tenant row |
| Exchange rates | invented in a `setTimeout`, then persisted | operator-set, effective-dated, or read from the server |
| Neon owner credential | a `\|\|` fallback shipped in the bundle | fails closed; **rotate it** |

Enforced by `npm run test:no-fake-data` (16 assertions), which scans the source
and is itself covered by the CI gate.

### Also closed

- **Credential in source.** `server/neonDb.ts` shipped a live Neon owner
  password as a fallback connection string. Removed; the module now fails
  closed. `dotenv` also moved into the module that *reads* `DATABASE_URL`,
  because ES module evaluation ordered the pool before `server.ts`'s
  `dotenv.config()` ran — the bundled fallback had been hiding that.
- **Multi-tenancy was nominal.** The capability seed granted one tenant by
  literal. Measured on the live database: **6 of 7 tenants had no capability
  rows at all**, so every licence-gated screen was hidden for them. It now seeds
  each tenant that has no grant and leaves narrowed licences alone.
- **Offline could lose sales.** `syncNow()` took one boolean for the batch and
  then emptied the queue. A refused or never-sent sale vanished with no record,
  and a single `false` re-sent committed sales and duplicated invoices. Each item
  now receives its own verdict and the queue is rebuilt rather than cleared.
  Queued ids are device-scoped and monotonic across reloads.
- **`test:encoding` and `test:offline` did not exist.** `package.json` pointed
  at files that were never written, so those gates could only ever fail and were
  skipped. Both now exist and run.

## Still open, ranked

| # | Item | Why it is not done |
|---|---|---|
| 1 | `mock*` arrays in six screens | Largely resolved; each screen needed its own table + CRUD + permission, not a patch. |
| 2 | No component-level test runner | The suites here drive real PostgreSQL and real routes, so coverage of *wiring* is real — but there is still no jsdom/DOM runner, so `LoginView` and `POSView` are verified by source contract, not by rendering. |
| 3 | SSO has no server endpoint | `server/ssoEngine.ts` exists with passkey tables and registration routes, but no provider code exchange is wired; the sign-in screen states plainly that SSO is unprovisioned rather than faking a login. Real wiring needs a provider + server-side code exchange. |
| 4 | MFA delivery is log-only | `MfaDeliverer` defaults to `logDeliverer` — a real random code, but delivered to the server log, and the edge copy (`worker/index.ts`) writes the same code to the Worker log. Production must register an SMS/e-mail deliverer. **Both runtimes now enforce the factor** (`test:mfa-parity`, 14 assertions, challenge verified in both directions). |
| 5 | Settlement accounts are not editable in the UI | **CLOSED** — `POST`/`PUT /api/db/settlement/accounts` are permission-checked and the settings screen writes to them (`test:no-fake-data` §6 asserts create/read/mount). |

## Unknown username returned 500, not 401 — and the 500 was an oracle (P7b)

`server/enrollmentEngine.ts` resolves an unknown username during sign-in with

```sql
SELECT id, tenant_id, username, email, phone, is_active, locked_until FROM dypos.users ...
```

Neither `email` nor `phone` existed on `dypos.users` — no pack in v131..v148 added them. Every query raised `42703 column "email" does not exist` and the route answered **500**. Three consequences: the unknown-user branch of sign-in was broken on the Express/on-prem path (the edge never calls the engine, so the public site looked healthy); the 500 distinguished a non-existent user from a wrong password, which is exactly the enumeration `GENERIC_AUTH_ERROR` exists to prevent; and no suite covered that branch — a rate-limit test found it, not the auth suite.

Fixed additively by **`v149_user_contact_columns.sql`** (`ADD COLUMN IF NOT EXISTS email/phone` + an index) and the bootstrap `CREATE TABLE` in `neonDb.ts` now declares both. Nullable by contract — `CanonicalUserRef` marks them optional and a NULL never blocks sign-in.

## Rate limiting on the pre-auth surface (P8)

Two budgets, per IP, per route, on both front doors:

- **Failure budget** — only 401/403 responses consume it. Spraying one password across hundreds of usernames is bounded regardless of how many accounts rotate.
- **Request budget** — every request counts. `/api/auth/login` runs PBKDF2-100k *before* it can refuse, so an unbounded flood is a CPU attack that succeeds whether or not any guess does.

The per-account lockout in `passwords.ts` bounds guessing against ONE user; this bounds the surface. Express copy: `server/rateLimit.ts`. Edge copy: `rateLimitVerdict` in `worker/index.ts` — isolate-local by design, documented as such rather than pretending to be a global store.

Proof: `npm run test:rate-limit` (27 assertions: the refusal, `retry-after`, per-IP and per-route independence, the window reopening, the `off` escape hatch, and a source scan asserting every guessing route carries the middleware — so a NEW auth route cannot be added unlimited without this test failing).

## MFA parity: the edge now holds the same two-phase sign-in (P9)

`worker/index.ts` issued a session token on the password alone. An enrolled user signing in from the public site therefore skipped the factor the local server demanded — the control protected the dev server only.

The edge now issues its own challenge (`issueChallengeEdge`) and mints a token only from `/auth/mfa/verify` after `verifyChallengeEdge` confirms the code, mirroring `server/mfa.ts` over Web Crypto with the identical on-disk format (SHA-256 hex in `dypos.mfa_challenges`). Proof: `npm run test:mfa-parity` (14 assertions) verifies a challenge issued on EXPRESS on the EDGE and one issued on the EDGE on EXPRESS, plus the mirrored constants — the same drift class that once made 210,000 iterations permanently unverifiable.

## P7 — The scale invented its own readings, and a settlement was computed from them (FIXED)

The most expensive defect this project has shipped, and it produced no error,
no type warning, and a green build throughout.

| Where | What it actually did |
|---|---|
| `deviceGateway` constructor | `setInterval` every 1500 ms, `weight = weight + (Math.random() - 0.5) * 0.02`, **starting at 1.45 kg** — a "live" reading that drifted forever |
| `scaleProtocolHAL` constructor | `startSimulation()`, status `'simulated'`, seeded `1.45` |
| **`catch` on both connections** | `this.startSimulation()` — so a scale that *failed to pair* restored the fiction |
| `sendTareCommand` / `sendZeroCommand` | mutated the simulated reading, so a tare "worked" on hardware that did not exist |
| `openCashDrawer()` / `printReceiptEscPos()` | `console.log(...)` then `return true` |
| `POSView`, `ThirdPartySaleView`, `ScaleHALWidget` | seeded `1.45`, `45.5 / 2.0 / 43.5`, and `1.45` respectively |

The till displayed **⚖ 1.450 كجم** on page load, before anything was placed on
anything. And `ThirdPartySaleView` turned those invented digits into money owed to
a named person:

```ts
const netKg = scaleReading.netWeightKg > 0 ? scaleReading.netWeightKg : manualNetKg;
const gross = netKg * unitPrice;
const netSeller = gross - (gross * commissionRate) / 100;   // what the farmer is paid
```

With `netWeightKg` being random noise, `> 0` was almost always true, so the
**random weight silently beat the operator's typed one**. That screen exists to
decide what a real farmer is owed, and it was deciding from a random number
generator.

### What replaced it

1. **The reading type cannot hold a fabricated number.** `ScaleReading`'s fields
   are `number | null`, with one frozen `NO_SCALE_READING`. This is the change
   that matters: a re-introduced seed literal no longer compiles, and there is no
   number for a screen to render when no device has spoken.
2. **No simulation anywhere.** The HAL starts `disconnected`, holds `NO_FRAME`,
   and a failed connection now *stays* disconnected and returns `{ ok: false,
   reason }`. The `'simulated'` member survives in the union only so a stale
   reference is a known type rather than an `any`; nothing sets it.
3. **Real transports, completed rather than stubbed.** Web Serial frame
   buffering (a scale sends many lines per second; each `read()` is not a frame),
   and Bluetooth now actually subscribes to the Weight Measurement characteristic
   and decodes it — previously it requested a device, declared success, and read
   no notification at all.
4. **A peripheral reports a verdict.** `openCashDrawer()` writes the real ESC/POS
   pulse `1B 70 00 19 FA` and returns `{ ok: false, reason }` with no port open.
   The POS renders that reason. It can no longer report success for a drawer that
   did not move.
5. **The settlement refuses instead of defaulting.** No device weight *and* no
   typed weight is an error message, not `0` — a zero-weight lot settles at zero
   and vanishes from a farmer's balance. Pre-filled terms (50 kg / 10 / 5 %) and
   the seeded broker `الدلال / أبو فهد` are gone; a lot number derived from
   `Math.random()` was replaced with a sortable per-year sequence.

Proof: `npm run test:hardware` (28 assertions), wired into `npm run ci` and the
CI gate. It scans the source because the old code was *type-correct while lying* —
`return true` satisfies `boolean`, `1.45` satisfies `number` — so only a property
assertion could have caught it.

## Dead code removed (each verified zero-referenced, not merely unused-looking)

| File | Size | Why it was dead |
|---|---|---|
| `src/components/IntelligenceCenter.tsx.tail` | 8.5 KB | An orphaned fragment of the pre-P6 screen, **still containing the fabricated `45,200` / `128,400` / `4.2x`** that P6 removed from the real file |
| `src/data/openingProducts.ts` | 70 KB | `OPENING_INVENTORY_PRODUCTS` had no importer; text was mojibake |
| `src/data/openingInventory.json` | 67 KB | No importer; the same corrupted rows |
| `src/services/i18nService.ts` | 12 KB | `i18n` was never imported — the UI is Arabic-first and hardcoded |
| `src/hooks/usePWAInstall.ts` | 3.4 KB | Superseded by `services/installPrompt.ts` + `InstallPrompt.tsx`, which duplicate its platform detection |
| `src/services/backupService.ts` | 4 KB | `executeCloudBackup` had no caller; `offlineSyncService` owns that path now |

The `.tail` file is the one worth naming: it was a *committed* copy of the exact
fake numbers a previous pass claimed to have removed. Nothing imported it, so no
scan of the running app would ever have found it.

## Invariants added

1. A correct password alone never yields a session token.
2. No authentication decision is made in the browser.
3. No endpoint returns `ok: true` without verifying something real.
4. No payment is recorded without a genuine authorisation.
5. A receipt is rendered from what the server recorded, never from invented values.
6. A lockout is never a bypass.
7. A figure a system cannot read is never displayed as a number.