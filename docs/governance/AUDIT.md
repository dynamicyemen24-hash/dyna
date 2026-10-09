# Audit and Logging — DyPOS

**Document owner:** Platform Operations
**Version:** 1.0
**Last reviewed:** 2026-10-10
**Classification:** Internal — operations
**Status:** Active

This document defines the audit and logging framework for DyPOS. It ensures accountability, supports incident response, and provides a reliable record for internal review and lawful obligations.

---

## 1. Objectives

1. Record every action that affects data, configuration, or account state.
2. Enable reliable incident investigation and post-incident review.
3. Support internal control reviews and lawful obligations.
4. Preserve an immutable trail that cannot be silently modified or removed.

---

## 2. What must be logged

| Category | Data elements |
|---|---|
| Authentication | Login attempts, success/failure, factor use, IP, timestamp, user agent |
| Data access | View, export, filter, restore — with user, object ID, timestamp |
| Data changes | Before/after state, actor, timestamp, reason code |
| Configuration | Change to branding, role, branch, capabilities, settings |
| Administration | Account creation, role change, lock, delete, password change |
| Finance | Sales, adjustments, journal entries, balance checks, period locks |
| Sync | Offline writes, sequence numbers, conflicts, conflict resolution |

---

## 3. What must NOT be logged

- Passwords or password fragments
- Full session tokens
- Raw payment card numbers or PAN/EMV excerpts
- Full credit-card numbers or CVV
- Real identities of third-party workers, guests, or non-members

Any of the above is a security incident, not a log entry.

---

## 4. Format and retention

- Structured event records with a stable `eventId`, actor, timestamp, objectId, operation, before/after, and outcome.
- Every event is immutable and append-only; the system does not allow retroactive deletion.
- Audit logs are retained for a minimum of 7 years or as otherwise required by law.

---

## 5. Correlation

Every change is traceable to the actor and the tool that caused it. The `eventId` is used across systems to reconstruct the full chain of actions around any record.

---

## 6. Access to logs

- **Security and compliance roles** have read access.
- **Everyone else** has no access to audit data.
- Log export is reserved for the audit and incident teams.

---

## 7. Incident response

During an incident, the response team may:

1. Freeze write access while the record is being reconstructed.
2. Obtain the relevant audit records with the on-duty architect and security lead.
3. Publish a controlled report to the authorised stakeholders.

---

## 8. Review cycle

- Audit logs are reviewed at least quarterly, with event summaries and breach attempts.
- The security and compliance leads review the control effectiveness and the incident register.
- The review record includes findings, actions, and the responsible owner.

---

## 9. Related documents

- `SECURITY.md`
- `AUDIT.md` is referenced from GOVERNANCE.md

---

*Maintained by Platform Operations. Logs are a forensic asset and must be treated accordingly.*
