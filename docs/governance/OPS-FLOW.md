# Ops Flow Guide — Production Path

**Owner:** Platform Operations
**Version:** 1.0
**Reviewed:** 2026-10-10
**Status:** Active

Companion to GOVERNANCE.md, SECURITY.md, DATA-PROTECTION.md, and the technical architecture in ARCHITECTURE.md.

---

## 1. Production operation path

1. Account provisioning — Owner creates operator account and assigns role + branch.
2. Credential handover — Operator receives initial credentials and completes first-login steps.
3. Sign-in — Operator signs in at LoginView.
4. Session — Server issues a signed session token; SPA boots against it.
5. Shift open — Operator opens the cash drawer / counts float.
6. Page — Seller works the till (payment, returns, holds).
7. Shift close — Operator closes the shift and locks the till.
8. Audit — Every action above is recorded and verified (AUDIT.md).

---

## 2. Login and register

- Login: POST /api/auth/login → signed session token in sessionStorage.
- Remember-me: pre-fills username only; password never persisted.
- Registration: owner creates the account (platform team provisions).

---

## 3. Operations checklist (boot)

- [ ] Session valid (not expired)
- [ ] Branch resolved to the correct tenant
- [ ] Capabilities match the operator's role
- [ ] Offline queue healthy (no unresolved flags)
- [ ] Cash drawer / device report normal
- [ ] Consumables below the loss limit

---

## 4. Controls (minimum)

- No sensitive data (password, token, PAN) stored in the client bundle.
- All sensitive data encrypted in transit and at rest.
- All changes logged and verified before becoming visible.
- Every change recorded with actor, timestamp, object, and state.

---

## 5. Responsibilities

| Role | Responsibility |
|---|---|
| Owner | Registers account, assigns role, approves changes |
| Platform | Maintains system, applies patches, enforces security |
| Operator | Performs task, confirms data, reports issues |
| Compliance | Maintains privacy and audit records |

---

## 6. Change management

Every change to this path is recorded in the change register. Reviewed by architecture board and security lead before production.

---

## 7. Related documents

GOVERNANCE.md, SECURITY.md, ACCESS-CONTROL.md, DATA-PROTECTION.md, AUDIT.md, ACCOUNT-MANAGEMENT.md, API.md, ARCHITECTURE.md, DATABASE.md, DECISION_MAP.md

*Maintained by Platform Operations.*

