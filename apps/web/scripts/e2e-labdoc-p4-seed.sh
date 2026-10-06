#!/usr/bin/env bash
# e2ep4-seed.sh — cwm-labdoc P4 E2E 系統數據（DB cwm_labdoc_p4）
#
# 冪等：先清 e2ep4% 殘留（含 P4 上傳 doc 生成嘅 LabFile）再插。
# 內容（§15.1/§15.2 fixture 對接）：
#   - 用戶 2（同 P3 id — token 由 driver 用 P4 JWT_SECRET 現簽）
#   - Labs 3：Sodental（DETAIL docNoSame=true）/ Excel（OUTSTANDING）/ Modern（INVOICE_LIST docNoSame=false）
#   - Clinic（Aegis）+ Providers 3（Tong/Yiu/Ho）
#   - 系統 invoice：Sodental 09 ×4（P3 同）；Excel 09 ×2（0509/0811）+ 202512-0885（窗口外）；Modern 06 ×2（250/980）
#   - 月結單（seed 落 NEEDS_REVIEW，driver 走 live reconcile）：
#       Excel 2026-09（0509/0811 CURRENT + 0885 D31_90 + 1202；statedCurrent 1,061）
#       Excel 2026-08 舊版（section CONFIRMED + 0885 MATCHED → PREVIOUSLY_MATCHED 來源）
#       Modern 2026-06（fallback 250 + 980 vs 1030 AMOUNT_DIFF）
#       Sodental 2026-08（§5.5 Σ 17,490 vs 21,330 + DETAIL 無單號 NEEDS_MANUAL 行）
#   - 折扣 B4：CostCase（labInvoiceLinked=true）+ LabMonthlyDiscount 8.5%
#   - P4 alias API live：LabAlias ×3（NAME_EN/NAME_CN/PAYEE）+ ClinicNameAlias + ProviderNameAlias
#
# 跑法：cd apps/web && bash scripts/e2e-labdoc-p4-seed.sh
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"  # apps/web
export PGPASSWORD=$(awk -F'"' '/^DATABASE_URL=/{print $2}' .env.local | sed -E 's#^postgres(ql)?://[^:@]+:([^@]+)@.*#\2#')
PSQL="psql -h 127.0.0.1 -p 15532 -U cw_dev -d cwm_labdoc_p4 -q -v ON_ERROR_STOP=1"

# ── ID 表（全部 25 位 lowercase alnum = cuid 形；route regex 硬要求）────
OWN='own9kfh68sthp00000000000'
EMP='empxytdbvbwpf80000000000'
LAB_SOD='e2ep4labsodental000000000'
LAB_EXC='e2ep4labexcellent00000000'
LAB_MOD='e2ep4labmodernlab00000000'
CLINIC='e2ep4clinicaegis000000000'
PROV_T='e2ep4provesmond0000000000'
PROV_Y='e2ep4provyiu0000000000000'
PROV_H='e2ep4provho00000000000000'
CUST88='e2ep4cust88231a0000000000'
ALIASEN='e2ep4aliasen0000000000000'
ALIASCN='e2ep4aliascn0000000000000'
ALIASPAY='e2ep4aliaspay000000000000'
CLINALIAS='e2ep4clinalias00000000000'
PROVALIAS='e2ep4provalias00000000000'
SODINV1='e2ep4sod09inv100000000000'
SODINV2='e2ep4sod09inv200000000000'
SODINV3='e2ep4sod09inv300000000000'
SODINV4='e2ep4sod09inv400000000000'
SODLN1='e2ep4sod09ln1000000000000'
SODLN2='e2ep4sod09ln2000000000000'
SODLN3='e2ep4sod09ln3000000000000'
SODLN4='e2ep4sod09ln4000000000000'
EXCINV1='e2ep4exc09inv100000000000'
EXCINV2='e2ep4exc09inv200000000000'
EXC12INV1='e2ep4exc12inv100000000000'
MODINV1='e2ep4mod06inv100000000000'
MODINV2='e2ep4mod06inv200000000000'
EXC08DOC='e2ep4exc08stmd00000000000'
EXC08SEC='e2ep4exc08stms00000000000'
EXC08LN='e2ep4exc08stml00000000000'
EXC09DOC='e2ep4exc09stmd00000000000'
EXC09SEC='e2ep4exc09stms00000000000'
EXC09LN1='e2ep4exc09stml10000000000'
EXC09LN2='e2ep4exc09stml20000000000'
EXC09LN3='e2ep4exc09stml30000000000'
EXC09LN4='e2ep4exc09stml40000000000'
MOD06DOC='e2ep4mod06stmd00000000000'
MOD06SEC='e2ep4mod06stms00000000000'
MOD06LN1='e2ep4mod06stml10000000000'
MOD06LN2='e2ep4mod06stml20000000000'
SOD08DOC='e2ep4sod08stmd00000000000'
SOD08SEC='e2ep4sod08stms00000000000'
SOD08LN1='e2ep4sod08stml10000000000'
SOD08LN2='e2ep4sod08stml20000000000'
SOD08LN3='e2ep4sod08stml30000000000'
SOD08LN4='e2ep4sod08stml40000000000'
SOD08LN5='e2ep4sod08stml50000000000'
SOD08LN6='e2ep4sod08stml60000000000'
SOD08LN7='e2ep4sod08stml70000000000'
COST='e2ep4costcase100000000000'
DISC='e2ep4disc0100000000000000'

# contract-lock extractionHint（P3 seed:39 逐字，494 字 ≤ 500 硬限 — route HINT_MAX / prompt cap）
# P3 17:00 E2E2 34/34 綠 = 「有契約鎖 + 真 pipeline」證據；Qwen3.8-27B-FP8 無 hint 必漂移（P4 run1/3 實測）
CONTRACT_HINT='所有key必現(冇值填null,禁省略); lineType正常行=INVOICE; 欄名逐字: kind, lab{nameRaw,nameCnRaw,payeeRaw}, billTo{nameRaw,addressRaw,customerNoRaw,shortCodeRaw,doctorRaw}, docNoRaw, docNoLabel, dateRaw, date, deliveryDate, orderReceivedDate, statementMonth, sections[{clinicRaw,doctorRaw,customerNoRaw,addressRaw,pageFrom,pageTo,total,currentTotal,lines[{lineType,docNoRaw,date,patientRaw,patientCodeRaw,labCaseRef,description,toothRaw,qty,unitPrice,amount,agingBucket}]}], subtotal, total, readIssues[], groups[]'

# bcrypt hash（'e2e-pass'）— JWT 流程唔使登入；唔印
BCH=$(node -e "console.log(require('bcryptjs').hashSync('e2e-pass', 10))")

# 冪等清理
$PSQL -c "
CREATE TEMP TABLE _p4_files AS SELECT DISTINCT \"fileId\" FROM \"LabDocumentPage\"
  WHERE \"documentId\" IN (
    SELECT id FROM \"LabDocument\"
    WHERE id LIKE 'e2ep4%' OR \"labId\" LIKE 'e2ep4%' OR \"uploadedBy\" IN ('$OWN','$EMP')
  );
DELETE FROM \"LabDocument\" WHERE id LIKE 'e2ep4%' OR \"labId\" LIKE 'e2ep4%' OR \"uploadedBy\" IN ('$OWN','$EMP');
DELETE FROM \"LabFile\" WHERE id IN (SELECT \"fileId\" FROM _p4_files);
DROP TABLE _p4_files;
DELETE FROM \"LabCustomerNo\" WHERE id LIKE 'e2ep4%' OR \"labId\" LIKE 'e2ep4%';
DELETE FROM \"LabAlias\" WHERE id LIKE 'e2ep4%' OR \"labId\" LIKE 'e2ep4%';
DELETE FROM \"ClinicNameAlias\" WHERE id LIKE 'e2ep4%';
DELETE FROM \"ProviderNameAlias\" WHERE id LIKE 'e2ep4%';
DELETE FROM \"LabMonthlyDiscount\" WHERE id LIKE 'e2ep4%' OR \"labId\" LIKE 'e2ep4%';
DELETE FROM \"CostCase\" WHERE id LIKE 'e2ep4%';
DELETE FROM \"LabProfile\" WHERE \"labId\" LIKE 'e2ep4%';
DELETE FROM \"Lab\" WHERE id LIKE 'e2ep4%';
DELETE FROM \"Provider\" WHERE id LIKE 'e2ep4%';
DELETE FROM \"Clinic\" WHERE id LIKE 'e2ep4%';
"

$PSQL <<SQL
-- ── 用戶（同 P3 id；JWT 由 driver 用 P4 JWT_SECRET 現簽）────────────────
INSERT INTO "User" (id, name, phone, password, role, status, "tokenVersion", "permissionsJson", "createdAt", "updatedAt")
VALUES
 ('$OWN', 'E2E Owner', '90000001', '$BCH', 'OWNER', 'ACTIVE', 0, NULL, now(), now()),
 ('$EMP', 'E2E Emp Inv', '90000002', '$BCH', 'EMPLOYEE', 'ACTIVE', 0, '{"grant":["lab_invoice"],"deny":[]}', now(), now())
ON CONFLICT (id) DO NOTHING;

-- ── Labs / Clinic / Providers ────────────────────────────────────────
INSERT INTO "Lab" (id, name, "isActive", "sortOrder", "createdAt", "updatedAt") VALUES
 ('$LAB_SOD', 'Sodental Company Limited', true, 0, now(), now()),
 ('$LAB_EXC', 'Excel Laboratory', true, 1, now(), now()),
 ('$LAB_MOD', 'Modern Dental Laboratory', true, 2, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Clinic" (id, name, "createdAt", "updatedAt")
VALUES ('$CLINIC', 'Tung Kai Wah Dental Clinic (Aegis)', now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Provider" (id, name, "isActive", "createdAt", "updatedAt") VALUES
 ('$PROV_T', 'Esmond Tong', true, now(), now()),
 ('$PROV_Y', 'Yiu Tsz Ching', true, now(), now()),
 ('$PROV_H', 'Ho Ka Chun', true, now(), now())
ON CONFLICT (id) DO NOTHING;

-- ── LabProfile（§12.6 三型）──────────────────────────────────────────
-- 三間 lab 全帶 contract-lock hint：LLM 讀單時 W prompt 必收到契約（extract.ts 讀 DB → labHint → W payload）。
-- 原 Sodental 專屬 hint「單號欄喺最左」+ 契約 = 504 字 > 500 硬限 → 按工單保留契約部分（P3 已用逐字版 34/34 綠）。
INSERT INTO "LabProfile" ("labId", "statementKind", "statementDocNoSameAsInvoice", "defaultDocNoKind", "extractionHint", "updatedBy", "updatedAt") VALUES
 ('$LAB_SOD', 'DETAIL', true, 'INVOICE_NO', '$CONTRACT_HINT', '$OWN', now()),
 ('$LAB_EXC', 'OUTSTANDING', true, 'INVOICE_NO', '$CONTRACT_HINT', '$OWN', now()),
 ('$LAB_MOD', 'INVOICE_LIST', false, 'INVOICE_NO', '$CONTRACT_HINT', '$OWN', now())
ON CONFLICT ("labId") DO NOTHING;

-- ── customer no + aliases（P4 alias API live 數據）──────────────────
INSERT INTO "LabCustomerNo" (id, "labId", "customerNo", "clinicId", "providerId", "createdBy", "createdAt") VALUES
 ('$CUST88', '$LAB_SOD', '88231', '$CLINIC', NULL, '$OWN', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "LabAlias" (id, "labId", kind, "rawNorm", "createdBy") VALUES
 ('$ALIASEN', '$LAB_SOD', 'NAME_EN', 'sodental', '$OWN'),
 ('$ALIASCN', '$LAB_SOD', 'NAME_CN', '禾呈', '$OWN'),
 ('$ALIASPAY', '$LAB_SOD', 'PAYEE', 'honestygifts', '$OWN')
ON CONFLICT (id) DO NOTHING;

INSERT INTO "ClinicNameAlias" (id, "rawNorm", "clinicId", "createdBy")
VALUES ('$CLINALIAS', 'tungkaiwah', '$CLINIC', '$OWN')
ON CONFLICT (id) DO NOTHING;

INSERT INTO "ProviderNameAlias" (id, "rawNorm", "providerId", "createdBy")
VALUES ('$PROVALIAS', 'esmondtong', '$PROV_T', '$OWN')
ON CONFLICT (id) DO NOTHING;

-- ── 系統 invoice：Sodental 2026-09（P3 同 — 供 PDF LLM live flow）────
INSERT INTO "LabDocument" (id, kind, status, "labId", "clinicId", "providerId", "docNo", "docDate", total, "uploadedBy", "version", "createdAt", "updatedAt") VALUES
 ('$SODINV1', 'INVOICE', 'CONFIRMED', '$LAB_SOD', '$CLINIC', '$PROV_T', 'INV-26090101', '2026-09-01', 1120.00, '$OWN', 0, now(), now()),
 ('$SODINV2', 'INVOICE', 'CONFIRMED', '$LAB_SOD', '$CLINIC', '$PROV_T', 'INV-26090102', '2026-09-03', 1250.00, '$OWN', 0, now(), now()),
 ('$SODINV3', 'INVOICE', 'CONFIRMED', '$LAB_SOD', '$CLINIC', '$PROV_Y', 'INV-26091001', '2026-09-10', 950.00, '$OWN', 0, now(), now()),
 ('$SODINV4', 'INVOICE', 'CONFIRMED', '$LAB_SOD', '$CLINIC', '$PROV_H', 'INV-26092001', '2026-09-20', 1500.00, '$OWN', 0, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "LabDocumentLine" (id, "documentId", "groupIndex", "lineIndex", "description", "toothRaw", "patientCode", qty, "unitPrice", "amount") VALUES
 ('$SODLN1', '$SODINV1', 0, 0, 'Crown Zirconia', '16', 'TW001001', 2.00, 560.00, 1120.00),
 ('$SODLN2', '$SODINV2', 0, 0, 'Crown PSK', '22', 'TW001002', 1.00, 1250.00, 1250.00),
 ('$SODLN3', '$SODINV3', 0, 0, 'Inlay Gold', '13', 'TW001003', 1.00, 950.00, 950.00),
 ('$SODLN4', '$SODINV4', 0, 0, 'Bridge PSK', '11-12', 'TW001004', 1.00, 1500.00, 1500.00)
ON CONFLICT (id) DO NOTHING;

-- ── 系統 invoice：Excel 2026-09（0509/0811 窗口內）+ 202512-0885（窗口外）
INSERT INTO "LabDocument" (id, kind, status, "labId", "clinicId", "providerId", "docNo", "docDate", total, "uploadedBy", "version", "createdAt", "updatedAt") VALUES
 ('$EXCINV1', 'INVOICE', 'CONFIRMED', '$LAB_EXC', '$CLINIC', '$PROV_T', '202609-0509', '2026-09-05', 800.00, '$OWN', 0, now(), now()),
 ('$EXCINV2', 'INVOICE', 'CONFIRMED', '$LAB_EXC', '$CLINIC', '$PROV_T', '202609-0811', '2026-09-11', 261.00, '$OWN', 0, now(), now()),
 ('$EXC12INV1', 'INVOICE', 'CONFIRMED', '$LAB_EXC', '$CLINIC', '$PROV_T', '202512-0885', '2025-12-08', 500.00, '$OWN', 0, now(), now())
ON CONFLICT (id) DO NOTHING;

-- ── 系統 invoice：Modern 2026-06（250 / 980）────────────────────────
INSERT INTO "LabDocument" (id, kind, status, "labId", "clinicId", "providerId", "docNo", "docDate", total, "uploadedBy", "version", "createdAt", "updatedAt") VALUES
 ('$MODINV1', 'INVOICE', 'CONFIRMED', '$LAB_MOD', '$CLINIC', '$PROV_T', 'I260120289', '2026-06-05', 250.00, '$OWN', 0, now(), now()),
 ('$MODINV2', 'INVOICE', 'CONFIRMED', '$LAB_MOD', '$CLINIC', '$PROV_T', 'I260120290', '2026-06-10', 980.00, '$OWN', 0, now(), now())
ON CONFLICT (id) DO NOTHING;

-- ── Excel 2026-08 舊版（section CONFIRMED + 0885 MATCHED = PREVIOUSLY_MATCHED 來源）
INSERT INTO "LabDocument" (id, kind, status, "labId", "clinicId", "statementMonth", "uploadedBy", "version", "createdAt", "updatedAt")
VALUES ('$EXC08DOC', 'STATEMENT', 'RECONCILED', '$LAB_EXC', '$CLINIC', '2026-08', '$OWN', 0, now(), now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO "LabStatementSection" (id, "documentId", "sectionIndex", "clinicId", "providerId", "clinicBasis", "providerBasis", status, "confirmedBy", "confirmedAt")
VALUES ('$EXC08SEC', '$EXC08DOC', 0, '$CLINIC', '$PROV_T', 'CUSTOMER_NO', 'CUSTOMER_NO', 'CONFIRMED', '$OWN', now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO "LabStatementLine" (id, "sectionId", "lineIndex", "lineType", "docNo", "amount", "agingBucket", "result", "matchBasis", "matchedDocumentId")
VALUES ('$EXC08LN', '$EXC08SEC', 0, 'INVOICE', '202512-0885', 500.00, 'D31_90', 'MATCHED', 'DOC_NO', '$EXC12INV1')
ON CONFLICT (id) DO NOTHING;

-- ── Excel 2026-09 月結單（§15.2：0509/0811 MATCHED、0885 PREVIOUSLY_MATCHED、1202 MISSING_IN_SYSTEM；statedCurrent 1,061）
INSERT INTO "LabDocument" (id, kind, status, "labId", "clinicId", "statementMonth", "uploadedBy", "version", "createdAt", "updatedAt")
VALUES ('$EXC09DOC', 'STATEMENT', 'NEEDS_REVIEW', '$LAB_EXC', '$CLINIC', '2026-09', '$OWN', 0, now(), now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO "LabStatementSection" (id, "documentId", "sectionIndex", "clinicId", "providerId", "clinicBasis", "providerBasis", status, "statedCurrent")
VALUES ('$EXC09SEC', '$EXC09DOC', 0, '$CLINIC', '$PROV_T', 'CUSTOMER_NO', 'CUSTOMER_NO', 'PENDING', 1061.00)
ON CONFLICT (id) DO NOTHING;
INSERT INTO "LabStatementLine" (id, "sectionId", "lineIndex", "lineType", "docNo", "date", "amount", "agingBucket", "result") VALUES
 ('$EXC09LN1', '$EXC09SEC', 0, 'INVOICE', '202609-0509', '2026-09-05', 800.00, 'CURRENT', 'PENDING'),
 ('$EXC09LN2', '$EXC09SEC', 1, 'INVOICE', '202609-0811', '2026-09-11', 261.00, 'CURRENT', 'PENDING'),
 ('$EXC09LN3', '$EXC09SEC', 2, 'INVOICE', '202512-0885', '2025-12-08', 500.00, 'D31_90', 'PENDING'),
 ('$EXC09LN4', '$EXC09SEC', 3, 'INVOICE', '202603-1202', '2026-03-10', 300.00, 'D91_365', 'PENDING')
ON CONFLICT (id) DO NOTHING;

-- ── Modern 2026-06 月結單（§15.2：docNoSame=false → fallback MATCHED 250；980 vs 1,030 AMOUNT_DIFF）
INSERT INTO "LabDocument" (id, kind, status, "labId", "clinicId", "statementMonth", "uploadedBy", "version", "createdAt", "updatedAt")
VALUES ('$MOD06DOC', 'STATEMENT', 'NEEDS_REVIEW', '$LAB_MOD', '$CLINIC', '2026-06', '$OWN', 0, now(), now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO "LabStatementSection" (id, "documentId", "sectionIndex", "clinicId", "providerId", "clinicBasis", "providerBasis", status, "statedTotal")
VALUES ('$MOD06SEC', '$MOD06DOC', 0, '$CLINIC', '$PROV_T', 'CUSTOMER_NO', 'CUSTOMER_NO', 'PENDING', 1280.00)
ON CONFLICT (id) DO NOTHING;
INSERT INTO "LabStatementLine" (id, "sectionId", "lineIndex", "lineType", "docNo", "date", "amount", "result") VALUES
 ('$MOD06LN1', '$MOD06SEC', 0, 'INVOICE', NULL, '2026-06-05', 250.00, 'PENDING'),
 ('$MOD06LN2', '$MOD06SEC', 1, 'INVOICE', 'MOD-X-980', '2026-06-10', 1030.00, 'PENDING')
ON CONFLICT (id) DO NOTHING;

-- ── Sodental 2026-08 月結單（§5.5：Σ 17,490 vs statedTotal 21,330 → SUM_MISMATCH；DETAIL 無單號 → NEEDS_MANUAL）
INSERT INTO "LabDocument" (id, kind, status, "labId", "clinicId", "statementMonth", "uploadedBy", "version", "createdAt", "updatedAt")
VALUES ('$SOD08DOC', 'STATEMENT', 'NEEDS_REVIEW', '$LAB_SOD', '$CLINIC', '2026-08', '$OWN', 0, now(), now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO "LabStatementSection" (id, "documentId", "sectionIndex", "clinicId", "providerId", "clinicBasis", "providerBasis", status, "statedTotal")
VALUES ('$SOD08SEC', '$SOD08DOC', 0, '$CLINIC', '$PROV_T', 'CUSTOMER_NO', 'CUSTOMER_NO', 'PENDING', 21330.00)
ON CONFLICT (id) DO NOTHING;
INSERT INTO "LabStatementLine" (id, "sectionId", "lineIndex", "lineType", "docNo", "amount", "result") VALUES
 ('$SOD08LN1', '$SOD08SEC', 0, 'INVOICE', '202608-0001', 10000.00, 'PENDING'),
 ('$SOD08LN2', '$SOD08SEC', 1, 'INVOICE', '202608-0002', 5000.00, 'PENDING'),
 ('$SOD08LN3', '$SOD08SEC', 2, 'CREDIT', '202608-0003', -1500.00, 'PENDING'),
 ('$SOD08LN4', '$SOD08SEC', 3, 'CHARGE', '202608-0004', 3990.00, 'PENDING'),
 ('$SOD08LN5', '$SOD08SEC', 4, 'PAYMENT', NULL, -2000.00, 'PENDING'),
 ('$SOD08LN6', '$SOD08SEC', 5, 'BF', NULL, -1000.00, 'PENDING'),
 ('$SOD08LN7', '$SOD08SEC', 6, 'INVOICE', NULL, 700.00, 'PENDING')
ON CONFLICT (id) DO NOTHING;

-- ── 折扣 B4：CostCase（labInvoiceLinked=true）+ LabMonthlyDiscount 8.5% ─
INSERT INTO "CostCase" (id, "clinicId", "providerId", category, "patientCode", "patientCodeNorm", "orderedAt", "receivedAt", "periodMonth", "labId", "baseCost", "discountPct", "finalCost", "status", "labInvoiceLinked", "createdBy", "createdAt", "updatedAt")
VALUES ('$COST', '$CLINIC', '$PROV_T', 'LAB', 'TW007159', 'TW007159', '2026-09-01', '2026-09-15', '2026-09', '$LAB_SOD', 500.00, 8.50, 457.50, 'PRICED', true, '$OWN', now(), now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO "LabMonthlyDiscount" (id, "labId", "periodMonth", "discountPct", "createdBy", "createdAt")
VALUES ('$DISC', '$LAB_SOD', '2026-09', 8.50, '$OWN', now())
ON CONFLICT (id) DO NOTHING;
SQL

echo "seeded:"
$PSQL -c "
SELECT 'user' AS t, id FROM \"User\" WHERE id IN ('$OWN','$EMP');
SELECT 'lab', id FROM \"Lab\" WHERE id LIKE 'e2ep4%';
SELECT 'inv', id, \"docNo\", \"docDate\", total FROM \"LabDocument\" WHERE id LIKE 'e2ep4%' AND kind='INVOICE' ORDER BY id;
SELECT 'stmt', id, \"statementMonth\" FROM \"LabDocument\" WHERE id LIKE 'e2ep4%' AND kind='STATEMENT' ORDER BY id;
SELECT 'cost', id, \"labInvoiceLinked\", \"baseCost\", \"finalCost\" FROM \"CostCase\" WHERE id LIKE 'e2ep4%';
"
