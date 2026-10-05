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