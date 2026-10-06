#!/usr/bin/env bash
# e2ep3-seed.sh — cwm-labdoc P3 E2E 系統數據（Sodental + 3 醫生 + 4 invoice + T20 =cmd 行）
# 冪等：每次先清 e2ep3* 殘留（含 driver 生成嘅 cuid doc + 佢哋嘅 LabFile — 重複檢查只豁免 VOID，
#       SUPERSEDED/IN_PROGRESS 舊 run doc 會擋新 upload → 必須 sweep；LabDocumentPage→LabFile 冇 cascade）
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"  # apps/web（portable）
export PGPASSWORD=$(awk -F'"' '/^DATABASE_URL=/{print $2}' .env.local | sed -E 's#^postgres(ql)?://[^:@]+:([^@]+)@.*#\2#')
PSQL="psql -h 127.0.0.1 -p 15532 -U cw_dev -d cwm_labdoc_p3 -q -v ON_ERROR_STOP=1"
LAB_ID="e2ep3lab0000000000000001"

# 冪等清理
$PSQL -c "
-- 先撳呢個 lab 嘅 file ids（LabDocumentPage.fileId→LabFile 係 RESTRICT — page 刪咗先刪到 file）
CREATE TEMP TABLE _e2e_files AS SELECT DISTINCT \"fileId\" FROM \"LabDocumentPage\"
  WHERE \"documentId\" IN (SELECT id FROM \"LabDocument\" WHERE \"labId\"='$LAB_ID');
-- sweep 成個 e2e lab 嘅 doc（cascade 帶走 pages/sections/lines）— 罩住 driver cuid doc
DELETE FROM \"LabDocument\" WHERE \"labId\"='$LAB_ID';
-- 删 orphan files（= 撳住嘅集，此刻已全部冇 page 引用）
DELETE FROM \"LabFile\" WHERE \"id\" IN (SELECT \"fileId\" FROM _e2e_files);
DROP TABLE _e2e_files;
DELETE FROM \"LabCustomerNo\" WHERE id LIKE 'e2ep3%';
DELETE FROM \"LabProfile\" WHERE \"labId\" LIKE 'e2ep3%';
DELETE FROM \"Lab\" WHERE id LIKE 'e2ep3%';
DELETE FROM \"Provider\" WHERE id LIKE 'e2ep3%';
DELETE FROM \"Clinic\" WHERE id LIKE 'e2ep3%';
"

$PSQL <<'SQL'
INSERT INTO "Lab" (id, name, "isActive", "sortOrder", "createdAt", "updatedAt")
VALUES ('e2ep3lab0000000000000001', 'Sodental Company Limited', true, 0, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "LabProfile" ("labId", "statementKind", "statementDocNoSameAsInvoice", "defaultDocNoKind", "updatedBy", "updatedAt")
VALUES ('e2ep3lab0000000000000001', 'DETAIL', true, 'INVOICE_NO', 'own9kfh68sthp00000000000', now())
ON CONFLICT ("labId") DO NOTHING;

-- T20/extract 稳健性：sglang 忽略 guided_json（只有 json_object）— 模型偶發漂移 field name/省略 key
-- → 用官方 extractionHint 通道（§5.3，≤500 字）加固輸出契約（2026-10-06 實測 2/2 parse OK）
UPDATE "LabProfile" SET "extractionHint"='所有key必現(冇值填null,禁省略); lineType正常行=INVOICE; 欄名逐字: kind, lab{nameRaw,nameCnRaw,payeeRaw}, billTo{nameRaw,addressRaw,customerNoRaw,shortCodeRaw,doctorRaw}, docNoRaw, docNoLabel, dateRaw, date, deliveryDate, orderReceivedDate, statementMonth, sections[{clinicRaw,doctorRaw,customerNoRaw,addressRaw,pageFrom,pageTo,total,currentTotal,lines[{lineType,docNoRaw,date,patientRaw,patientCodeRaw,labCaseRef,description,toothRaw,qty,unitPrice,amount,agingBucket}]}], subtotal, total, readIssues[], groups[]', "updatedAt"=now()
WHERE "labId"='e2ep3lab0000000000000001';

INSERT INTO "Clinic" (id, name, "createdAt", "updatedAt")
VALUES ('e2ep3clin00000000000001', 'Tung Kai Wah Dental Clinic (Aegis)', now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Provider" (id, name, "isActive", "createdAt", "updatedAt") VALUES
 ('e2ep3prov00000000000001', 'Esmond Tong',   true, now(), now()),
 ('e2ep3prov00000000000002', 'Yiu Tsz Ching', true, now(), now()),
 ('e2ep3prov00000000000003', 'Ho Ka Chun',    true, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "LabCustomerNo" (id, "labId", "customerNo", "clinicId", "providerId", "createdBy", "createdAt")
VALUES ('e2ep3cust00000000000001', 'e2ep3lab0000000000000001', '88231', 'e2ep3clin00000000000001', NULL, 'own9kfh68sthp00000000000', now())
ON CONFLICT (id) DO NOTHING;

-- 系統 invoice（CONFIRMED；docDate 喺 2026-09）
-- Dr Tong: INV-26090101（系統 qty 2 → 月結單 qty 1 = QTY_DIFF，差 560）
INSERT INTO "LabDocument" (id, kind, status, "labId", "clinicId", "providerId", "docNo", "docDate", total, "uploadedBy", "version", "createdAt", "updatedAt")
VALUES
 ('e2ep3inv0000000000000001', 'INVOICE', 'CONFIRMED', 'e2ep3lab0000000000000001', 'e2ep3clin00000000000001', 'e2ep3prov00000000000001', 'INV-26090101', '2026-09-01', 1120.00, 'own9kfh68sthp00000000000', 0, now(), now()),
 ('e2ep3inv0000000000000002', 'INVOICE', 'CONFIRMED', 'e2ep3lab0000000000000001', 'e2ep3clin00000000000001', 'e2ep3prov00000000000001', 'INV-26090102', '2026-09-03', 1250.00, 'own9kfh68sthp00000000000', 0, now(), now()),
 ('e2ep3inv0000000000000003', 'INVOICE', 'CONFIRMED', 'e2ep3lab0000000000000001', 'e2ep3clin00000000000001', 'e2ep3prov00000000000002', 'INV-26091001', '2026-09-10', 950.00,  'own9kfh68sthp00000000000', 0, now(), now()),
 ('e2ep3inv0000000000000004', 'INVOICE', 'CONFIRMED', 'e2ep3lab0000000000000001', 'e2ep3clin00000000000001', 'e2ep3prov00000000000003', 'INV-26092001', '2026-09-20', 1500.00, 'own9kfh68sthp00000000000', 0, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "LabDocumentLine" (id, "documentId", "groupIndex", "lineIndex", "description", "toothRaw", "patientCode", qty, "unitPrice", "amount")
VALUES
 ('e2ep3line000000000000001', 'e2ep3inv0000000000000001', 0, 0, 'Crown Zirconia', '16', 'TW001001', 2.00, 560.00, 1120.00),
 ('e2ep3line000000000000002', 'e2ep3inv0000000000000002', 0, 0, 'Crown PSK',    '22', 'TW001002', 1.00, 1250.00, 1250.00),
 ('e2ep3line000000000000003', 'e2ep3inv0000000000000003', 0, 0, 'Inlay Gold',   '13', 'TW001003', 1.00, 950.00,  950.00),
 ('e2ep3line000000000000004', 'e2ep3inv0000000000000004', 0, 0, 'Bridge PSK',   '11-12', 'TW001004', 1.00, 1500.00, 1500.00)
ON CONFLICT (id) DO NOTHING;

-- T20 fixture：raw 行 docNo/description = '=cmd'（CSV 公式注入守衛實跑目標）
-- 需喺清理後重插（e2ep3% doc 已被 sweep）；ON CONFLICT DO NOTHING 保冪等
INSERT INTO "LabDocument"
  (id, kind, status, "labId", "clinicId", "statementMonth", "uploadedBy", "version", "payeeIsNew", "manualAmountEdit", "extractAttempts", "readIssues", "createdAt", "updatedAt")
VALUES
  ('e2ep3t20doc0000000000000', 'STATEMENT', 'NEEDS_REVIEW', 'e2ep3lab0000000000000001', 'e2ep3clin00000000000001', '2026-09',
   'own9kfh68sthp00000000000', 0, false, false, 0, ARRAY[]::text[], now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "LabStatementSection" (id, "documentId", "sectionIndex", "status")
VALUES ('e2ep3t20sec00000000000000', 'e2ep3t20doc0000000000000', 0, 'PENDING')
ON CONFLICT (id) DO NOTHING;

INSERT INTO "LabStatementLine"
  (id, "sectionId", "lineIndex", "lineType", "docNo", "description", "date", "amount", "result")
VALUES
  ('e2ep3t20line0000000000000', 'e2ep3t20sec00000000000000', 0, 'INVOICE', '=cmd', '=cmd', '2026-09-05', 100.00, 'NEEDS_MANUAL')
ON CONFLICT (id) DO NOTHING;
SQL

echo "seeded:"
$PSQL -c "SELECT id, name FROM \"Provider\" WHERE id LIKE 'e2ep3%' ORDER BY id; SELECT id, \"docNo\", \"docDate\", total FROM \"LabDocument\" WHERE id LIKE 'e2ep3inv%' ORDER BY id; SELECT id, \"docNo\", \"result\" FROM \"LabStatementLine\" WHERE id LIKE 'e2ep3t20%';"
