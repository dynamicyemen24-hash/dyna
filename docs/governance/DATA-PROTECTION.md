# Data Protection and Privacy — DyPOS

**Document owner:** Privacy Office
**Version:** 1.0
**Last reviewed:** 2026-10-10
**Classification:** Internal — operations
**Status:** Active

This document describes how DyPOS handles personal data in line with the Saudi Personal Data Protection Law (Saudi PDPL, Law No. 45/2023) and the GDPR (where applicable). It defines the principles, obligations, and controls for personal data across the platform.

---

## 1. Definitions

- **Personal data** — any information relating to an identified or identifiable natural person, including name, phone, email, identity number, address, notes, and account credentials.
- **Sensitive data** — genetic, biometric, health, religious, political, trade-union, or criminal-data elements. DyPOS does not collect or store sensitive data unless a regulated process requires it and explicit consent is recorded.
- **Item-level consent** — dedicated confirmation, captured at each exposure of personal data and at each amendment, never assumed.

---

## 2. Principles

1. **Purpose limitation** — personal data is collected only for registered, lawful purposes and is not further processed in a manner incompatible with those purposes.
2. **Data minimisation** — only the minimum necessary data is collected and retained.
3. **Accuracy** — data is kept accurate and, where necessary, kept up to date; supports the item-level consent ownership.
4. **Storage limitation** — records are retained only for as long as required by the purpose; retention schedules are enforced.
5. **Integrity and confidentiality** — data is protected against unauthorised access, accidental loss, or destruction.
6. **Accountability** — DyPOS can demonstrate compliance with every principle in this document.

---

## 3. Scope

Every piece of personal data processed by DyPOS, regardless of storage location or medium. This includes:

- Identity documents, name, phone, email, address
- Appointment, service, and customer records
- Client notes and communication history
- Access logs and audit records

---

## 4. Legal bases (Saudi PDPL / GDPR)

Personal data is processed only on a lawful basis. The primary bases are:

- **Contract necessity** — processing required to fulfil a registered, agreed, or valid contract with the customer.
- **Consent** — explicit, item-level consent for non-essential or sensitive purposes, with the right to withdraw at any time.
- **Legal obligation** — processing required by applicable law.

A lawful basis is recorded per dataset and cannot be replaced by a blanket, unpublished assumption.

---

## 5. Retention

| Data category | Retention rule |
|---|---|
| Identity and contact | Until the relationship is closed, then per retention schedule |
| Appointments | While active, plus statutory retention where applicable |
| Notes and communication | While active, plus statutory retention |
| Audit records | Minimum 7 years, or per statutory obligation |
| Consent record | Until withdrawal, then removed from service at earliest |

Retention schedules are enforced by the server; clients never retain data beyond what the server allows.

---

## 6. International transfers

No personal data leaves the organisation's controlled environment without explicit consent and the appropriate transfer safeguards. The platform does not export data to third countries unless a lawful transfer mechanism applies and an export register is maintained.

---

## 7. Rights of data subjects

Data subjects have the right to:

- Access their personal data
- Rectify inaccurate data
- Erase personal data
- Restrict processing where applicable
- Data portability of their records
- Withdraw consent at any time

Each right has a defined handling channel, a processing SLA, and an escalation route. No request is automatically refused.

---

## 8. Technical and organisational measures

| Category | Control |
|---|---|
| Confidentiality | Access restricted by role, item-level consent, audit trail, tenant-keyed encryption where applicable |
| Integrity | Transaction checks, reconciliation, controlled changes |
| Availability | Offline-first sync, redundancy, fail-closed behaviour on failure |
| Residue risk | Assessed and recorded; all residual risk is accepted by the product owner with documented evidence |

---

## 9. Cross-border considerations

Data residency is enforced at the database layer. Personal data is never passed to a third country without explicit legal grounds, documented controls, and the owner's review.

---

## 10. Violations

- All privacy violations are reported to the Privacy Office within **24 hours**.
- High-severity violations are escalated to the product owner and Data Protection Officer within **4 hours**.
- Every violation has a logged response record covering containment, investigation, and remediation.

---

## 11. Records of processing activities (ROPA)

The Privacy Office maintains a register of processing activities that includes:

- Name and contact of the data subject
- Purpose of the processing
- Categories of data and recipients
- Retention periods
- Security measures applied

---

## 12. Related documents

- `SECURITY.md`
- `ACCESS-CONTROL.md`
- `AUDIT.md`
- `ACCOUNT-MANAGEMENT.md`

---

*Maintained by the Privacy Office. Changes to this document require Compliance approval.*
