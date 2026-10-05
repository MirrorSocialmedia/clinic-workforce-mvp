-- ★ cwm-chequeprint-20261005：支票打印（戶口／版面／抬頭／Lab 月結金額／支票紀錄）

-- CreateTable
CREATE TABLE "ChequeAccount" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "bankName" TEXT NOT NULL DEFAULT 'HSBC',
    "accountLast4" TEXT,
    "layoutId" TEXT,
    "bookFirstNo" INTEGER,
    "bookLastNo" INTEGER,
    "nextNo" INTEGER,
    "noWidth" INTEGER NOT NULL DEFAULT 6,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChequeAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChequeAccountClinic" (
    "clinicId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChequeAccountClinic_pkey" PRIMARY KEY ("clinicId")
);

-- CreateTable
CREATE TABLE "ChequeLayout" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fieldsJson" TEXT NOT NULL,
    "offsetXmm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "offsetYmm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "printerMode" TEXT NOT NULL DEFAULT 'ESCP',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChequeLayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChequePayee" (
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "payeeName" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChequePayee_pkey" PRIMARY KEY ("kind","refId")
);

-- CreateTable
CREATE TABLE "LabChequeAmount" (
    "id" TEXT NOT NULL,
    "labId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "statementRef" TEXT,
    "note" TEXT,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabChequeAmount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cheque" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chequeNo" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "clinicId" TEXT,
    "payeeName" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "chequeDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PRINTED',
    "confirmedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "voidedAt" TIMESTAMP(3),
    "printedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cheque_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChequeAccountClinic_accountId_idx" ON "ChequeAccountClinic"("accountId");

-- CreateIndex
CREATE INDEX "LabChequeAmount_periodMonth_idx" ON "LabChequeAmount"("periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "LabChequeAmount_labId_clinicId_periodMonth_key" ON "LabChequeAmount"("labId", "clinicId", "periodMonth");

-- CreateIndex
CREATE INDEX "Cheque_sourceType_sourceId_idx" ON "Cheque"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "Cheque_periodMonth_idx" ON "Cheque"("periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "Cheque_accountId_chequeNo_key" ON "Cheque"("accountId", "chequeNo");

-- 同一筆款只可以有一張有效（未作廢）支票
CREATE UNIQUE INDEX "Cheque_active_source_key" ON "Cheque"("sourceType", "sourceId") WHERE "status" <> 'VOID';
