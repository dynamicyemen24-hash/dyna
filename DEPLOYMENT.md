# DyPOS Cloud — deployment & operations

## Second factor (MFA)

The sign-in flow is two-phase and **server-enforced**:

```
POST /api/auth/login      → correct password?
                            ├─ session          (no factor required)
                            └─ { mfaRequired, challenge, expiresAt, digits }   ← NO token
POST /api/auth/mfa/verify  → challenge + code?  → session token
```

A correct password alone yields **nothing spendable**. The token is minted only
by `/api/auth/mfa/verify`, after `server/mfa.ts` verifies the code.

### Turning it on

| Variable | Where | Effect |
|---|---|---|
| `DYPOS_MFA_REQUIRED` | server env | `true` requires a factor for **every** user |
| per-user enrolment | `dypos.mfa_secrets.enabled` | Requires a factor for that user |

Default is **off**, so an existing installation is not locked out by the
migration. Enrolment is per user, so a tenant can roll it out account by account.

### Delivery

Codes are generated per attempt with `crypto.randomInt` and delivered through
`MfaDeliverer`. The default is `logDeliverer`, which writes the code to the
server's own log — a real, random, unbypassable code that needs no third-party
credentials. **The code is never returned by any HTTP route and never printed on
the sign-in screen.**

Production should register a real channel at boot:

```ts
import { setMfaDeliverer, type MfaDeliverer } from './server/mfa.js';

setMfaDeliverer({
  channel: 'sms',
  async send(to, code, ttl) {
    await smsClient.send({ to, body: `${code}` });  // your provider
  },
});
```

Stored codes are SHA-256 hashes, compared in constant time, so a database dump is
not a list of valid codes. Budget: 5 attempts per challenge **and** an independent
per-user counter, after which the factor locks for 15 minutes. A lockout always
still requires the factor — a lockout must never become a bypass.

Verify with: `npm run test:mfa` (23 assertions, real database).

### Emergency access (break-glass)

There is **no** magic passcode. A supervisor with `auth.break_glass` issues a
single-use, expiring grant, recorded in `dypos.break_glass_grants`:

```
POST /api/auth/break-glass/issue   { reason }   → { code, expiresAt }
POST /api/auth/break-glass         { code }     → accepted
```

The reason is mandatory and audited on issue, redemption and denial. A grant
authorises escalation; it does not open a session — credentials are still required.

## Rate limiting (pre-auth surface)

Two budgets per IP per route, on BOTH front doors — `server/rateLimit.ts` for
Express, `rateLimitVerdict` inside `worker/index.ts` for the public edge:

| Budget | Counts | Bounds |
|---|---|---|
| failures | only 401/403 responses | credential spraying across usernames |
| requests | every request | the PBKDF2-100k CPU cost of being flooded |

| Variable | Default | Effect |
|---|---|---|
| `DYPOS_AUTH_RATE_WINDOW_MS` | `300000` | window length (Express only) |
| `DYPOS_AUTH_RATE_MAX_FAILURES` | `15` | failed auths per window per IP per route |
| `DYPOS_AUTH_RATE_MAX_REQUESTS` | `120` | total requests per window per IP per route |
| `DYPOS_AUTH_RATE_LIMIT=off` | — | disable (load tests measuring the app, not the limiter) |

A 429 carries `Retry-After` and changes nothing about an authenticated session.
The edge copy is isolate-local — deliberately, rather than a KV write on every
sign-in attempt; it stops single-source grinding, which is the attack it exists
for. Verify with `npm run test:rate-limit`.

## Payment gateway

`paymentGatewayService` **fails closed**. With no provider configured, card
payments resolve to `status: 'unavailable'` and POSView refuses to record an
invoice, so no unpaid sale is ever written and no receipt printed.

Configure with `VITE_PAYMENT_GATEWAY` (`moyasar` | `stripe` | `sarie_bank_transfer`
| `stc_pay`) once a server-side integration exists. The secret key must never be
a `VITE_` variable — `VITE_*` is inlined into the public bundle. A real
integration belongs on the server, so the response is signed evidence rather than
something the client asserts about itself.

Cash, store credit and bank transfer need no gateway and are unaffected.

## Migrations

```
npm run migrate          # apply pending
npm run migrate:status   # list applied/pending
```

Additive and idempotent; recorded in `dypos.applied_migrations`.

## Typography

Two families, both **self-hosted** in `public/fonts/` — there is no Google Fonts
`<link>` anywhere, and `npm run test:typography` fails the build if one returns.

| Role | Family | Weights |
|---|---|---|
| Headings (`h1`–`h6`) | Tajawal | 400 · 500 · 700 |
| Body, labels, tables | IBM Plex Sans Arabic | 400 · 500 · 600 · 700 |

The split is functional, not decorative. Tajawal is a geometric Kufi face built
for short strings at large sizes — a screen title, a KPI label — while IBM Plex
is drawn for dense small text and has the Arabic terminal forms that keep
numbers legible in a column. Headings are bound by an **element selector**, not
by adding a class to ~40 screens, so the tier also holds on the next screen
nobody has written yet.

Each family ships an Arabic and a Latin subset with `unicode-range` preserved
from Google's own stylesheet, so a Latin-only screen downloads ~10 KB instead of
~43 KB. Tajawal has **no 600 cut** — declaring one would make the browser
synthesise it, which is visibly wrong for Arabic and reported by no test; the
typography suite asserts each family declares only weights it really ships.

### Numerals are always Latin

Even inside an Arabic sentence, and including on buttons. Two reasons:

- An Arabic-Indic digit is drawn for prose, does not align vertically in a
  column, and is measurably slower to scan than a Latin digit.
- It is a real **bidi** hazard. Under `dir="rtl"` a digit run is absorbed into
  the sentence's bidi run, so `من 12 إلى 5` can render with its ends swapped.

`.num` / `.text-numeric` set `unicode-bidi: isolate` and `direction: ltr` to
prevent that, and `body` pins `lining-nums` so a screen cannot inherit the
Arabic-Indic set from its locale. Both are asserted in CI — nothing fails when a
number mis-renders, it is simply wrong on screen.

## Credentials

Two runtimes serve this product and they must agree byte-for-byte, because
production is the Cloudflare Worker while every credential is written by the
Express path. Three things have to match, and each has been a real outage:

| Property | Rule | Consequence if it drifts |
|---|---|---|
| Salt | the **hex string**'s 32 ASCII bytes, not the bytes it decodes to | the edge derives a different key from the correct password → 401 forever |
| Iterations | **≤ 100,000** | Cloudflare *throws* above that → 500 on every sign-in |
| Shape | PBKDF2-SHA512, 128-char hex digest | silent fallback to a wrong path |

Measured on the deployed Worker, not assumed:

```
100,000 -> 200
210,000 -> 500 "Pbkdf2 failed: iteration counts above 100000 are not supported"
```

That ceiling is why `ITERATIONS` is 100,000 rather than a higher figure from
guidance. A stored count above it is not "slow to verify" — it is **permanently
unverifiable in production**, because the runtime throws before comparing a
single character.

Asserted by `npm run test:credentials` (13 assertions, both directions, plus a
rotation performed on the edge). It is in `npm run ci`; do not remove it.

### Bootstrap credentials

After running `npm run migrate`, run:

```
npm run release:credentials
```

This script:
1. Generates temporary 20-character passwords for `DYPOS_BOOTSTRAP_YACOUB` and
   `DYPOS_BOOTSTRAP_ABDULRAHMAN` if the environment variables are not already set.
2. Applies the v135 schema migration (`server/migrations/v135_release_auth.sql`).
3. Sets the operator credentials with forced rotation enabled.
4. Prints a credential sheet with the temporary passwords (capture them — they
   are not stored anywhere else).
5. Stamps the release version in `dypos.app_releases`.

The temporary passwords must be delivered to operators via a secure channel. After
each operator's first sign-in, the system forces a password change before any
business screen is accessible.

### Re-issuing a credential the edge cannot run

```
npm run migrate:iterations
```

PBKDF2 is not re-derivable without the plaintext password, which the database
does not hold — so this is a credential **reset**, not a transformation. Each
affected account gets a new random password at the portable cost, is marked
`must_change_password`, and the value is printed **once**. There is no default
password and no silent downgrade. Accounts already portable are untouched, and
throwaway `*_probe_*` accounts are deleted rather than handed out as logins.

The script re-queries the table afterwards and exits non-zero if any row is
still above the ceiling, so it cannot report success it has not earned.