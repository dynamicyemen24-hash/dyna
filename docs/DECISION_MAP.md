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

| # | Item | Why it is not done |
|---|---|---|
| 1 | `mock*` arrays in six screens | `WorkOrderManager`, `MeasurementManager`, `RetailPOS`, `RestaurantView`, `SubscriptionsView`, `ThirdPartySaleView` render literal rows instead of querying. Each needs its own table + CRUD + permission, not a patch. |
| 2 | No unit-test runner | No vitest/jest. Two security suites (`test:mfa`, `test:unlock`) run against real PostgreSQL and real routes, so coverage is real — but component-level regression is still absent. |
| 3 | `tsconfig` has no `strict` | Turning it on surfaces a large backlog at once. Correct as a measured, separate change. |
| 4 | SSO has no server endpoint | States plainly that it is unprovisioned rather than faking a login. Real wiring needs a provider + server-side code exchange. |
| 5 | No deployment pipeline | `deploy:api` is `wrangler deploy`, invoked by hand. No CI gate runs build + typecheck + tests before deploy. |
| 6 | No git repository | There is no rollback point. Initialising one has authority implications (history, remotes) rather than being a mechanical fix. |
| 7 | MFA delivery is log-only | `MfaDeliverer` defaults to `logDeliverer` — a real random code, but delivered to the server log. Production must register an SMS/e-mail deliverer. |

## Invariants added

1. A correct password alone never yields a session token.
2. No authentication decision is made in the browser.
3. No endpoint returns `ok: true` without verifying something real.
4. No payment is recorded without a genuine authorisation.
5. A receipt is rendered from what the server recorded, never from invented values.
6. A lockout is never a bypass.
7. A figure a system cannot read is never displayed as a number.