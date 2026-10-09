# Security Policy — DyPOS

**Document owner:** Platform Security
**Version:** 1.0
**Last reviewed:** 2026-10-10
**Classification:** Internal — operations
**Status:** Active

This document defines the minimum security controls for the DyPOS platform. It is aligned to the global standard family ISO/IEC 27001:2022, NIST SP 800-53 Rev. 5, and the Saudi Personal Data Protection Law (Saudi PDPL, Law No. 45/2023). It applies to every repository under this organisation — frontend, API, worker, scripts, and third-party configuration.

---

## 1. Scope

Every component: `src/components/*`, `src/services/dyposApi.ts`, `src/App.tsx`, `src/contexts/*`, `src/services/*`, `wrangler.toml`, `package.json`, CI workflows, and the Cloudflare Worker deployment.

---

## 2. Authentication and identity

| Control | Requirement | Evidence |
|---|---|---|
| Login | `POST /api/auth/login` issues a signed session token stored in `sessionStorage` only (HttpOnly-disabled by design for edge SPA). | `src/services/dyposApi.ts` |
| Password | Never stored, transmitted, or echoed in any UI, bundle, or error message. A password is a zero-length string until the operator types it. | `LoginView.tsx:326-336` |
| Remember-me | Pre-fills the **username only** from `sessionStorage` (`dypos_remember_username`). The password is never persisted. | `LoginView.tsx:513-521` |
| Sessions | Session is bound to a signed token issued by the server; the client trusts only that token. `app.ts` restores the session from storage once on mount and discards it when `mustChangePassword` is set. | `App.tsx:896-943` |
| 2FA | `mfaRequired` flows through `server/mfa.ts`. No factor is skipped locally. | `LoginView.tsx:529-534` |

---

## 3. Access control

| Control | Requirement |
|---|---|
| Role and branch binding | Every request carries a `branchId` with an enforced effect check server-side. |
| Privilege escalation | Prohibited. No client-supplied `role`, `tenant`, or `branch` may override the server's authoritative identity. |
| Shared database | Row Level Security (`SET LOCAL app.tenant_id`) is enforced; a tenant can never read another tenant's rows at the SQL level. |
| Impersonation | Explicitly rejected. The legacy `x-dypos-user` header (client-chosen name) is refused. |

---

## 4. Data protection

- **Pieces of PII** (name, phone, email, address, notes, notes of appointments) are marked as non-public.
- GDPR / Saudi PDPL apply: every request that will return personal data carries **item-level consent**, and consent is re-confirmed at each amendment.
- Access to PII is logged with actor, timestamp, and object ID (see `AUDIT.md`).

---

## 5. Multi-tenant isolation (security boundary)

- Shared database, **not** shared schema. Row-level security is the enforcement point.
- No route is publicly reachable without authentication, **except** `/api/auth/login` (which never returns a password and therefore carries no secret).
- The token is the single reader of identity: `getToken()` reads `sessionStorage.getItem(TOKEN_KEY)`.

---

## 6. Operational security

| Control | Requirement |
|---|---|
| Dependency injection | `npm ci` with locked lockfile. No global installs in CI (`npm run build` runs `npx wrangler deploy`). |
| Secrets | Never committed. `wrangler.toml` carries only `account_id` (non-secret). Secrets are injected via GitHub Actions `secrets`. |
| Logging | All funding logs are `console.error` with structured payloads; no token, no password, no PII appended. |
| Rate limiting | Administrative routes (and all auth routes) rate-limit login attempts. |
| Fail-closed | Any request that cannot be verified fails closed with a 401/403, never with a degraded-but-available response. |

---

## 7. Change management

Every production change must pass the gate workflow (`.github/workflows/gate.yml`):

1. `type-check` (strict `tsc --noEmit`) — zero errors.
2. `constitution` — no tenant data in shipped code (e.g., hard-coded `DATABASE_URL`, passwords, PII).
3. `unit` — test suites.
4. `build` — production artefacts.
5. `integration` — against the production database.
6. `deploy` — deploys to Cloudflare only from a verified artefact.

---

## 8. Responsibilities

| Role | Responsibility |
|---|---|
| Product owner | Approves new features, defines scope, owns compliance calendar. |
| Architect | Defines boundaries, owns the contract between screens and server, reviews risky changes. |
| Security lead | Reviews security-critical changes, maintains this policy. |
| All engineers | Follow the policy, raise incidents within 24 hours via the project tracker. |

---

## 9. Review cadence

- **Policy review:** quarterly.
- **Conflict review:** each release.
- **Audit:** quarterly, covering authentication, data protection, and audit logs.

---

## 10. Related documents

- `GOVERNANCE.md` — governance framework
- `ACCESS-CONTROL.md` — access control and RBAC
- `DATA-PROTECTION.md` — data protection and privacy
- `AUDIT.md` — audit and logging
- `ACCOUNT-MANAGEMENT.md` — account lifecycle management

---

*Maintained by the Platform Security team. Any change to this policy must be accompanied by a change to the relevant CI gate.*
