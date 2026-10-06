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
| Lab invoice / statement originals | 7 years | Accounting records (Inland Revenue Ordinance); on expiry delete files and clear patient names |

> **Lab 單據備份保留（§4.5）**：lab_docs volume（原檔已 AES-256-GCM 加密落地）每日 `rclone copy` 備份至 `offsite:clinic-backups/lab-docs/`，offsite 跟同一個 7 年保留期（每月 1 號 `rclone sync --max-delete 500` 令已到期清除嘅檔喺 offsite 同步刪）。加密 key `LAB_DOC_ENC_KEY` 同 `APRICOT_ENC_KEY` 一樣離線另存一份——冇 key 備份檔無法解密。Purge 後保留：金額、單號、病人編號、配對紀錄（只清姓名欄）。

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

## 9. Lab 單據敏感數據處理（cwm-labdoc P1–P4，spec §5.6／§4.4）

### 9.1 敏感數字過濾（AI 讀單輸出前）

AI 讀單輸出（zod 驗證後、落庫前）對**特定欄位**做銀行/金融敏感數字過濾（取代舊「≥8 位＋dash」規則）：

- **檢查欄位**：`lab.*`、`billTo.*`、`description`、`readIssues`、`patientNameRaw`、`patientRaw`、`clinicRaw`、`doctorRaw`
- **唔檢查**（業務必需欄）：`docNoRaw`、`labCaseRef`、`patientCodeRaw`、`customerNoRaw`
- **命中即設該欄 null**＋ `readIssue` 加 `SENSITIVE_REMOVED:<欄名>`＋ `console.warn`（**只 log docId＋欄名，唔 log 原文**）：
  - 香港銀行帳號：`\b\d{3}-\d{6}-\d{3}\b`、`\b\d{3}-\d{3}-\d{6}\b`、`\b0\d{2}-\d{3}\b.*\d{9}`（Bank & Branch＋帳號）、`\b\d{9,12}\b` 且同欄出現 `account|a/c|戶口|帳號`
  - SWIFT：`\b[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?\b` 且同欄有 `swift`
  - MICR：`⑈|⑆|⑇` 或 `\b\d{6}\s+\d{3}\s+\d{3}\s+\d{6}\s+\d{3}\b`
  - FPS：同欄有 `FPS` 且 `\d{7,9}`
- 測試基準（真單遮咗樣本：必刪 5 類／不可刪 5 類）見 spec §5.6 同 `src/lib/labdoc/sensitive-filter.test.ts`（PDPO 文檔唔重述樣本字串）。

### 9.2 原檔 7 年 purge 策略（§4.4）

- 每晚 03:30 cron（`x-cron-key` 守門，見 `scripts/README-CRONTAB.md` §6）：`purgeAt = uploadedAt + 7 年` 到期嘅 LabFile 逐個刪碟上原檔＋顯示圖＋縮圖 → `purgedAt = now`。
- 單據**所有頁**檔都 purged 先清姓名欄（`extractedJson`／行 `patientNameRaw`／`patientRaw`）；**金額、單號、病人編號、配對紀錄保留**（會計紀錄 — 稅務 7 年）。
- 備份 offsite 跟同一 7 年期（每月 1 號 sync 同步刪）；加密 key 離線另存。

### 9.3 Audit 防漏（PII guard）

- 所有 labdoc 寫入審計經 `labdocAudit()`：`beforeJson`／`afterJson` 快照喺落庫前經 PII guard 檢查——**姓名欄（patientName/billTo.name/doctor.name 等）進 audit 會 throw**（unit test 守門）；audit 只記 id／數值／枚舉。
- P4 新增 `LAB_PROFILE_UPDATE`（Lab 設定前後快照）同 `LAB_ALIAS_DELETE`（被刪 alias 行快照）都經同一 guard。

### 9.4 存取控制

- 原檔/頁圖下載 = `lab_invoice`（每張下載有 audit）；敏感讀單/改數/設定 = `lab_statement`（`rbac-matrix.md` §10）。
- AI 讀單經 wa-inbox proxy（信封加密；Cloudflare 只見到密文）；LLM 唔見原檔，只見加密信封。

---

*Last updated: 2026-10-06*
*Review frequency: Annual or upon material change*
