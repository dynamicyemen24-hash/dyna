# Account Management — DyPOS

**Document owner:** Platform Security
**Version:** 1.0
**Last reviewed:** 2026-10-10
**Classification:** Internal — operations
**Status:** Active

This document defines the account and access management rules for DyPOS: lifecycle, credentials, role lifecycle, and the registration contract between the operator and the platform.

---

## 1. Purpose

DyPOS is a commercial operating system. Account management must provide:

- Clear identity for every actor
- Secure credential handling
- Controlled, audited access to commercial and administrative data
- A defined path between sign-up and productive use
- Reconciliation with the data-protection obligations in `DATA-PROTECTION.md`

---

## 2. Account lifecycle

| Stage | Responsible | Action |
|---|---|---|
| Registration | Owner | Creates the account; platform security assigns the primary role |
| Onboarding | Owner + Platform | Confirms contact details, branch, and role; issues the first login |
| Initial credential | Owner | Operator sets their own password on first use |
| Credential change | Operator | Required on first login and after a suspected compromise |
| Role change | Owner | Operator escalates/escalates the role for the business need |
| Policy change | Owner | Owner may request changes to role, branch, or access; platform security applies the change |
| Deprovisioning | Owner | Account is disabled and all sessions are revoked |
| Deletion | Owner + Compliance | Record removal per retention schedule and the data-protection policy |

---

## 3. Registration contract

The platform does **not** provide open self-signup. DyPOS is a commercial operating system with tight tenant isolation, and account creation is a controlled act:

- The owner creates the account and the operator is provisioned by the platform team.
- Registration is bound to the commercial profile — a named organisation, branch, and register.
- Account identity is created once and never replaced; any change is a controlled amendment with an audit record.

---

## 4. Password rules

| Rule | Value |
|---|---|
| Minimum length | 12 characters |
| Complexity | At least three of: uppercase, lowercase, digit, symbol |
| History | Last 5 passwords cannot be reused |
| Expiry | No arbitrary expiry, but a reminder is issued when the operator has not changed their password in 12 months |
| Lock | Failed logins at the threshold (5) are locked for 15 minutes, or until supervisor release |
| Transmission | Never transmitted outside the authenticated session |
| Storage | Never persisted in the client or bundle |

---

## 5. Multi-factor

MFA is enforced where the server issues a challenge. The client never skips a factor. The challenge is issued by the server (`server/mfa.ts`) and verified only there.

---

## 6. Role and branch assignment

| Role | Branch scope | Commercial scope | Administrative scope |
|---|---|---|---|
| Owner | All | All | Account, branch, and commercial settings |
| Administrator | All | All | Everything except privileged administration |
| Operator | Own branch or shared register | Own commercial scope | Restrictions as defined by role |
| Viewer | Own branch or shared register | Own read scope | None |

---

## 7. Session management

| Control | Requirement |
|---|---|
| Storage | Token stored in `sessionStorage` only |
| Lifetime | Tied to the signed session; expired sessions are revoked |
| Single sign-on | Not required; the session persists for the browser session |
| Security re-tuning | On `mustChangePassword`, the session is discarded and the operator re-authenticates |

---

## 8. Audit

Every account event is logged with actor, timestamp, object, before/after, and outcome, in line with `AUDIT.md`.

---

## 9. Responsible parties

| Role | Responsibility |
|---|---|
| Owner | Owns the account registry; approves provisioning and deprovisioning |
| Platform security | Maintains the credential policy, reviews lock-outs, enforces change controls |
| Compliance | Maintains the privacy obligations and the data-protection records |
| Engineering | Implements the controls accurately and without drift |

---

## 10. Contact

All account issues are opened through the platform support channel. Owners escalate through the responsible lead in the governance body.
