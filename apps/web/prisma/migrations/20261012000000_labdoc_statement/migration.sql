-- cwm-labdoc P3（施工單 §8 月結單對數）：LabStatementSection / LabStatementLine
--   月結單分段（診所＋醫生）＋分段行（INVOICE/CREDIT/PAYMENT/CHARGE/BF）
--   LabDocument.sections 關係（schema.prisma 同步加入）

-- CreateTable
CREATE TABLE "LabStatementSection" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "sectionIndex" INTEGER NOT NULL,
    "pageFrom" INTEGER,
    "pageTo" INTEGER,
    "clinicRaw" TEXT,
    "doctorRaw" TEXT,
    "customerNoRaw" TEXT,
    "clinicId" TEXT,
    "providerId" TEXT,
    "clinicBasis" TEXT,
    "providerBasis" TEXT,
    "statedTotal" DECIMAL(12,2),
    "statedCurrent" DECIMAL(12,2),
    "systemTotal" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "LabStatementSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabStatementLine" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "lineIndex" INTEGER NOT NULL,
    "lineType" TEXT NOT NULL DEFAULT 'INVOICE',
    "docNoRaw" TEXT,
    "docNo" TEXT,
    "date" DATE,
    "patientRaw" TEXT,
    "patientCode" TEXT,
    "labCaseRef" TEXT,
    "description" TEXT,
    "toothRaw" TEXT,
    "qty" DECIMAL(10,2),
    "unitPrice" DECIMAL(12,2),
    "amount" DECIMAL(12,2) NOT NULL,
    "agingBucket" TEXT,
    "matchedDocumentId" TEXT,
    "matchedLineId" TEXT,
    "matchBasis" TEXT,
    "result" TEXT NOT NULL DEFAULT 'PENDING',
    "resolution" TEXT,
    "resolutionNote" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "followUpClosedAt" TIMESTAMP(3),
    "followUpClosedBy" TEXT,

    CONSTRAINT "LabStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LabStatementSection_clinicId_providerId_idx" ON "LabStatementSection"("clinicId", "providerId");

-- CreateIndex
CREATE UNIQUE INDEX "LabStatementSection_documentId_sectionIndex_key" ON "LabStatementSection"("documentId", "sectionIndex");

-- CreateIndex
CREATE INDEX "LabStatementLine_matchedDocumentId_idx" ON "LabStatementLine"("matchedDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "LabStatementLine_sectionId_lineIndex_key" ON "LabStatementLine"("sectionId", "lineIndex");

-- AddForeignKey
ALTER TABLE "LabStatementSection" ADD CONSTRAINT "LabStatementSection_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "LabDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabStatementLine" ADD CONSTRAINT "LabStatementLine_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "LabStatementSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
