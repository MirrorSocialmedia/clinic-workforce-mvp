# PDPO Compliance Statement

## Personal Data (Privacy) Ordinance — Compliance

This document outlines how the Clinic Workforce Management System complies with Hong Kong's Personal Data (Privacy) Ordinance (Cap. 486).

---

## 1. Data Collected

| Category | Fields | Purpose | Legal Basis |
|----------|--------|---------|-------------|
| Identity | name, phone, email | Authentication, HR records | Employment contract necessity |
| Employment | joinDate, leaveDate, status, clinics, role | Workforce management | Employment contract necessity |
| Attendance | punchTime, punchType, source, location | Attendance tracking | Employment contract necessity |
| Compensation | payType, baseAmount, pay records | Payroll processing | Employment contract necessity |
| Leave | leave requests, balances | Leave management | Employment contract necessity |
| System | ipAddress, userAgent, audit actions | Security & audit trail | Legitimate interest (fraud prevention) |

## 2. Data Security Measures

### Encryption
- **At rest**: PostgreSQL runs with file system level encryption (recommend LUKS on VPS)
- **In transit**: All external traffic encrypted via HTTPS (TLS 1.2+) enforced by Nginx
- **Passwords**: bcrypt hashed with salt (cost factor 10+) — never stored in plain text
- **JWT tokens**: Signed with server-side secret, httpOnly cookies

### Access Control (RBAC)
- Four-tier role-based access: OWNER → MANAGER → ACCOUNTANT → EMPLOYEE
- Every API endpoint enforces role checking server-side
- Clinic-level data isolation (non-OWNER users only see their assigned clinics)
- Audit trail on all write operations (append-only `AuditLog` table)

### Anti-Tampering
- Punch records are **append-only** — no UPDATE/DELETE API
- Corrections use overlay records (`PunchCorrection`) preserving originals
- Daily SHA-256 hash chain (`DailyHash`) detects unauthorized modifications
- All modifications logged to `AuditLog` with actor, timestamp, IP, before/after data

## 3. Data Retention Policy

| Data Type | Retention Period | Rationale |
|-----------|-----------------|-----------|
| Active employee records | Indefinite (until resignation + 7 years) | HK Employment Ordinance |
| Attendance records | 7 years | HK Employment Ordinance minimum |
| Payroll records | 7 years | HK Inland Revenue Department |
| Audit logs | Configurable (default: 730 days / 2 years) | Legal + operational audit |
| Daily hash chain | Indefinite (append-only, immutable) | Anti-tampering integrity |
| Resigned employee data | 7 years post-leave | Legal compliance |

**Configuration**: `DATA_RETENTION_DAYS` environment variable controls automated cleanup.

## 4. Data Subject Rights (Part IV of PDPO)

### Right to Access (Data Access Request — DAR)
Employees can request access to their personal data via the system or by contacting the data controller. The system supports exporting individual employee records.

### Right to Correction
- Employees can request correction of inaccurate data
- System corrections are tracked via append-only correction records
- Original records are preserved for audit integrity

### Right to Object / Erasure
- Subject to legal retention requirements (Employment Ordinance, IRD)
- Data minimization: only necessary fields are collected
- After retention period expires, data is automatically purged via scheduled cleanup

## 5. Data Breach Response

1. **Detection**: Monitor audit logs for unauthorized access patterns
2. **Containment**: Revoke compromised credentials, disable affected accounts
3. **Assessment**: Determine scope and impact of breach
4. **Notification**: Notify affected data subjects and PPZO if required
5. **Remediation**: Fix vulnerability, update security measures
6. **Documentation**: Record incident in audit trail

## 6. Third-Party Data Sharing

| Recipient | Data Shared | Purpose | Safeguard |
|-----------|-------------|---------|-----------|
| None (default) | — | — | No third-party sharing by default |

System does not transmit personal data to third parties. Administrator discretion applies for legal obligations (e.g., IRD filing).

## 7. International Data Transfer

System is designed for local (Hong Kong) deployment. No data is transferred outside Hong Kong by default.

## 8. Compliance Checklist

- [x] Personal data collected for specified purposes only
- [x] Adequate security measures implemented (encryption, RBAC, audit)
- [x] Data retention policy defined and configurable
- [x] Data subject access mechanisms available
- [x] No unauthorized third-party sharing
- [x] Data minimization practiced
- [ ] Privacy policy displayed to users (TODO: add to UI)
- [ ] Staff training on data handling (TODO: administrative)

---

*Last updated: 2026-07-05*
*Review frequency: Annual or upon material change*
