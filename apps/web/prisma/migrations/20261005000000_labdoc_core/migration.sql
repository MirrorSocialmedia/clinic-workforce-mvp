-- cwm-labdoc P1（施工單 §3 資料模型 P1 份）：Lab 單據對數 — 存底＋上傳
--   新表：LabFile / LabDocument / LabDocumentPage / LabDocumentLine / LabProfile /
--         LabAlias / LabCustomerNo / ClinicNameAlias / ProviderNameAlias / LabDocWriteLog
--   改舊表：Clinic.addressEn、CostCase.patientCodeNorm+labInvoiceLinked
--   偏離記錄：LabDocument.sections 關係留 P3（20261012000000_labdoc_statement）；
--             LabStatementSection/LabStatementLine 兩表 P3 先建。
-- ⚠️ partial index 由 migration 管（Prisma 唔支援 WHERE 子句）— 見 schema.prisma LabDocument 註解

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "addressEn" TEXT;
-- AlterTable
ALTER TABLE "CostCase" ADD COLUMN     "labInvoiceLinked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "patientCodeNorm" TEXT;
-- CreateTable
CREATE TABLE "LabFile" (
    "id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "hasTextLayer" BOOLEAN NOT NULL DEFAULT false,
    "storageKey" TEXT NOT NULL,
    "encKeyId" TEXT NOT NULL,
    "pagesJson" JSONB NOT NULL,
    "originalName" TEXT,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgeAt" TIMESTAMP(3) NOT NULL,
    "purgedAt" TIMESTAMP(3),

    CONSTRAINT "LabFile_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "LabDocumentPage" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "pageNo" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "LabDocumentPage_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "LabDocument" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "labId" TEXT,
    "labNameRaw" TEXT,
    "labBasis" TEXT,
    "clinicId" TEXT,
    "clinicBasis" TEXT,
    "clinicEvidence" TEXT,
    "providerId" TEXT,
    "providerBasis" TEXT,
    "providerEvidence" TEXT,
    "customerNoRaw" TEXT,
    "docNo" TEXT,
    "docNoKind" TEXT,
    "docDate" DATE,
    "deliveryDate" DATE,
    "orderReceivedDate" DATE,
    "statementMonth" TEXT,
    "statementKind" TEXT,
    "subtotal" DECIMAL(12,2),
    "total" DECIMAL(12,2),
    "payeeRaw" TEXT,
    "payeeIsNew" BOOLEAN NOT NULL DEFAULT false,
    "extractSource" TEXT,
    "extractedJson" JSONB,
    "readIssues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "extractAttempts" INTEGER NOT NULL DEFAULT 0,
    "extractError" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "manualAmountEdit" BOOLEAN NOT NULL DEFAULT false,
    "amountReviewedBy" TEXT,
    "amountReviewedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "duplicateOfId" TEXT,
    "supersededById" TEXT,
    "voidReason" TEXT,
    "voidedBy" TEXT,
    "voidedAt" TIMESTAMP(3),
    "uploadedBy" TEXT NOT NULL,
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabDocument_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "LabDocumentLine" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "groupIndex" INTEGER NOT NULL,
    "lineIndex" INTEGER NOT NULL,
    "patientNameRaw" TEXT,
    "patientCodeRaw" TEXT,
    "patientCode" TEXT,
    "labCaseRef" TEXT,
    "description" TEXT NOT NULL,
    "toothRaw" TEXT,
    "qty" DECIMAL(10,2),
    "unitPrice" DECIMAL(12,2),
    "listPrice" DECIMAL(12,2),
    "discountRaw" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "isZero" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "ignoreReason" TEXT,
    "costCaseId" TEXT,
    "linkType" TEXT,
    "matchedBy" TEXT,
    "matchedAt" TIMESTAMP(3),

    CONSTRAINT "LabDocumentLine_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "LabProfile" (
    "labId" TEXT NOT NULL,
    "statementKind" TEXT NOT NULL DEFAULT 'INVOICE_LIST',
    "statementDocNoSameAsInvoice" BOOLEAN NOT NULL DEFAULT true,
    "defaultDocNoKind" TEXT NOT NULL DEFAULT 'INVOICE_NO',
    "extractionHint" TEXT,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabProfile_pkey" PRIMARY KEY ("labId")
);
-- CreateTable
CREATE TABLE "LabAlias" (
    "id" TEXT NOT NULL,
    "labId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rawNorm" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabAlias_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "LabCustomerNo" (
    "id" TEXT NOT NULL,
    "labId" TEXT NOT NULL,
    "customerNo" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "providerId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabCustomerNo_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ClinicNameAlias" (
    "id" TEXT NOT NULL,
    "rawNorm" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicNameAlias_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ProviderNameAlias" (
    "id" TEXT NOT NULL,
    "rawNorm" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderNameAlias_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "LabDocWriteLog" (
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "responseJson" JSONB,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabDocWriteLog_pkey" PRIMARY KEY ("idempotencyKey")
);
-- CreateIndex
CREATE UNIQUE INDEX "LabFile_storageKey_key" ON "LabFile"("storageKey");
-- CreateIndex
CREATE INDEX "LabFile_sha256_idx" ON "LabFile"("sha256");
-- CreateIndex
CREATE INDEX "LabFile_purgeAt_purgedAt_idx" ON "LabFile"("purgeAt", "purgedAt");
-- CreateIndex
CREATE INDEX "LabDocumentPage_fileId_idx" ON "LabDocumentPage"("fileId");
-- CreateIndex
CREATE UNIQUE INDEX "LabDocumentPage_documentId_fileId_pageNo_key" ON "LabDocumentPage"("documentId", "fileId", "pageNo");
-- CreateIndex
CREATE INDEX "LabDocument_kind_status_idx" ON "LabDocument"("kind", "status");
-- CreateIndex
CREATE INDEX "LabDocument_labId_clinicId_providerId_docDate_idx" ON "LabDocument"("labId", "clinicId", "providerId", "docDate");
-- CreateIndex
CREATE INDEX "LabDocument_labId_statementMonth_idx" ON "LabDocument"("labId", "statementMonth");
-- CreateIndex
CREATE INDEX "LabDocumentLine_costCaseId_idx" ON "LabDocumentLine"("costCaseId");
-- CreateIndex
CREATE INDEX "LabDocumentLine_patientCode_idx" ON "LabDocumentLine"("patientCode");
-- CreateIndex
CREATE UNIQUE INDEX "LabDocumentLine_documentId_groupIndex_lineIndex_key" ON "LabDocumentLine"("documentId", "groupIndex", "lineIndex");
-- CreateIndex
CREATE INDEX "LabAlias_labId_idx" ON "LabAlias"("labId");
-- CreateIndex
CREATE UNIQUE INDEX "LabAlias_kind_rawNorm_key" ON "LabAlias"("kind", "rawNorm");
-- CreateIndex
CREATE UNIQUE INDEX "LabCustomerNo_labId_customerNo_key" ON "LabCustomerNo"("labId", "customerNo");
-- CreateIndex
CREATE UNIQUE INDEX "ClinicNameAlias_rawNorm_key" ON "ClinicNameAlias"("rawNorm");
-- CreateIndex
CREATE UNIQUE INDEX "ProviderNameAlias_rawNorm_key" ON "ProviderNameAlias"("rawNorm");
-- CreateIndex
CREATE INDEX "LabDocWriteLog_createdAt_idx" ON "LabDocWriteLog"("createdAt");
-- CreateIndex
CREATE INDEX "CostCase_patientCodeNorm_idx" ON "CostCase"("patientCodeNorm");
-- AddForeignKey
ALTER TABLE "LabDocumentPage" ADD CONSTRAINT "LabDocumentPage_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "LabDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "LabDocumentPage" ADD CONSTRAINT "LabDocumentPage_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "LabFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "LabDocument" ADD CONSTRAINT "LabDocument_labId_fkey" FOREIGN KEY ("labId") REFERENCES "Lab"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "LabDocumentLine" ADD CONSTRAINT "LabDocumentLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "LabDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "LabDocumentLine" ADD CONSTRAINT "LabDocumentLine_costCaseId_fkey" FOREIGN KEY ("costCaseId") REFERENCES "CostCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "LabProfile" ADD CONSTRAINT "LabProfile_labId_fkey" FOREIGN KEY ("labId") REFERENCES "Lab"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "LabAlias" ADD CONSTRAINT "LabAlias_labId_fkey" FOREIGN KEY ("labId") REFERENCES "Lab"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill（§3.2）：CostCase.patientCodeNorm 由 patientCode 計。
-- §6.5 規則嘅 SQL 版：upper(trim) 去空格同 #；^([A-Z]+)0*([0-9]+)$ → 前綴 + 數字補零到 6 位；
-- 唔符合就 upper(trim)。純數字無前綴此處留 upper(trim)（P2 配對時先按診所 shortName 補前綴 — §6.5 step 3）。
-- ⚠️ 保守偏離：施工單寫 lpad(數字,6,'0')，但 Postgres lpad 對 >6 位數字會【截斷】（實測 9003874→900387），
--    改用 greatest(length(數字),6) 防截斷（>6 位 = 超出 §6.5 定義域，照原樣保留，唔丢數據）。
WITH t AS (
  SELECT id,
         upper(replace(replace(trim(coalesce("patientCode", '')), ' ', ''), '#', '')) AS c
  FROM "CostCase"
)
UPDATE "CostCase" cc
SET "patientCodeNorm" = CASE
  WHEN t.c = '' THEN NULL
  WHEN t.c ~ '^([A-Z]+)0*([0-9]+)$'
    THEN regexp_replace(t.c, '^([A-Z]+)0*([0-9]+)$', '\1')
         || lpad(regexp_replace(t.c, '^([A-Z]+)0*([0-9]+)$', '\2'),
                 greatest(length(regexp_replace(t.c, '^([A-Z]+)0*([0-9]+)$', '\2')), 6), '0')
  ELSE t.c
END
FROM t
WHERE cc.id = t.id
;

-- Partial unique index（§6.4：同一 Lab 同一 INVOICE_NO 只有一張有效 invoice）
-- ⚠️ index 由 migration 管 — Prisma schema 無對應欄位（見 schema.prisma LabDocument 註解）
CREATE UNIQUE INDEX "LabDocument_invoice_docNo_active" ON "LabDocument"("labId","docNo")
  WHERE "kind"='INVOICE' AND "docNoKind"='INVOICE_NO' AND "docNo" IS NOT NULL
    AND "labId" IS NOT NULL AND "status" NOT IN ('VOID','DUPLICATE');
