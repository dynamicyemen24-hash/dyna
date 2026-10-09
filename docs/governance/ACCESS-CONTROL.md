# Access Control and Role Management — DyPOS

**Document owner:** Platform Architecture
**Version:** 1.0
**Last reviewed:** 2026-10-10
**Classification:** Internal — operations
**Status:** Active

This document defines the access-control model for DyPOS. It is aligned with commercial standard practice (IAAA: identification, authentication, authorisation, accountability) and with tenant isolation requirements.

---

## 1. Model

DyPOS uses a **role-and-branch** model:

- **Identity** — the signed session token issued by the server; never trust client-supplied identity.
- **Branch** — the operating location; every request names a branch and the server enforces the effect.
- **Role** — the set of actions the operator may perform.
- **Tenant** — the commercial boundary; row-level security is enforced at the database layer.

---

## 2. Authentication

| Control | Requirement |
|---|---|
| Credential storage | Password never stored or transmitted except to the server's auth endpoint, where it is verified and then discarded from the client. |
| Session token | Issued by `POST /api/auth/login`; stored in `sessionStorage` only. |
| Remember-me | Pre-fills username only; password never persisted. |
| Multi-factor | Required where the server issues a challenge; never skipped locally. |
| Account lock | Failed logins increment a counter and lock the account after a defined threshold; lockout is lifted by supervisor action. |

---

## 3. Authorisation

Every screen and capability declares what it may do. The server evaluates the effect before any record is read or changed.

| Level | Permission |
|---|---|
| Owner | Full access to the commercial and administrative domain, including staff, records, configuration, and settings. |
| Administrator | Full access except privileged admin actions (user administration, system settings, audit). |
| Operator | Standard commercial actions (sales, inventory, appointments, orders) for their branch. |
| Viewer | Read-only access to defined records. |

---

## 4. Data access

- Tenant isolation is enforced at the SQL layer (row-level security) and cannot be bypassed by the client.
- Personal data (PII) requires **item-level consent** and may only be accessed by roles authorised for that action.
- Audit logs are immutable and accessible only to the security and compliance roles.

---

## 5. Principles

1. **Least privilege** — every role receives only the access it needs and no more.
2. **Default deny** — access to any record or action requires an explicit, server-enforced permission.
3. **Made-visible** — permissions are governed and shown in the interface; no action is available when the operator lacks authority.
4. **Auditability** — every access, change, and administrative action is logged with actor, timestamp, object, and before/after state.
5. **Separation of duties** — no single role performs a sensitive chain of actions alone; the audit trail remains complete.

---

## 6. Privilege escalation

Prohibited. Client-supplied fields that could be used to override branch, role, or tenant are rejected server-side. The only identity authority is the signed session token.

---

## 7. Account lifecycle

| Event | Action |
|---|---|
| Account creation | Owner creates the account and issues credentials; platform security assigns the role. |
| Password change | Required on first login and after any suspected compromise; enforced by `mustChangePassword`. |
| Role change | Admin reviews the need; owner approves; platform security applies the change. |
| Account lock | Failed-login threshold exceeded; auto-released or supervisor-released. |
| Account deletion | Per data-retention policy; the owner may request and the platform enforces. |
| Credential expiry | Managed per policy; reminders are tracked by the platform. |

---

## 8. Monitoring and review

- Log access, administration, and data-protection events.
- Review role assignments and access at least quarterly.
- Review the access-control model when a new capability crosses a data-protection boundary.
- Incident response includes access review to determine whether an account was compromised.

---

## 9. Related documents

- `SECURITY.md`
- `DATA-PROTECTION.md`
- `AUDIT.md`
- `ACCOUNT-MANAGEMENT.md`
