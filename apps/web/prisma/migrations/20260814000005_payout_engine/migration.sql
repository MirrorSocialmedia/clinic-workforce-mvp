-- MD-D: Payout Engine — ProviderReferral, SpSubsidy, PayoutRun, PayoutAdjustment

-- ProviderCommission: add isActive column (default true)
ALTER TABLE "ProviderCommission" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

-- ProviderReferral
CREATE TABLE "ProviderReferral" (
    "id" TEXT NOT NULL,
    "fromProviderId" TEXT NOT NULL,
    "toProviderId" TEXT,
    "billExtId" TEXT NOT NULL,
    "billCode" TEXT NOT NULL,
    "billItemEleId" TEXT NOT NULL,
    "itemDes" TEXT NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "qty" INTEGER NOT NULL,
    "refPercent" DECIMAL(5,2) NOT NULL DEFAULT 2,
    "amount" DECIMAL(12,2) NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "note" TEXT,
    "lockedByRunId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderReferral_pkey" PRIMARY KEY ("id")
);

-- SpSubsidy
CREATE TABLE "SpSubsidy" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "billExtId" TEXT NOT NULL,
    "billItemEleId" TEXT NOT NULL,
    "itemDes" TEXT NOT NULL,
    "listPrice" DECIMAL(12,2) NOT NULL,
    "actualPrice" DECIMAL(12,2) NOT NULL,
    "headcount" INTEGER NOT NULL DEFAULT 1,
    "splitPercent" DECIMAL(5,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'AUTO',
    "confirmedBy" TEXT,
    "periodMonth" TEXT NOT NULL,
    "lockedByRunId" TEXT,

    CONSTRAINT "SpSubsidy_pkey" PRIMARY KEY ("id")
);

-- PayoutRun
CREATE TABLE "PayoutRun" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "grossAmount" DECIMAL(12,2) NOT NULL,
    "rawAmount" DECIMAL(12,2) NOT NULL,
    "labCost" DECIMAL(12,2) NOT NULL,
    "implantCost" DECIMAL(12,2) NOT NULL,
    "invisalignCost" DECIMAL(12,2) NOT NULL,
    "profitAmount" DECIMAL(12,2) NOT NULL,
    "percentUsed" DECIMAL(5,2) NOT NULL,
    "salaryAmount" DECIMAL(12,2) NOT NULL,
    "spSubsidy" DECIMAL(12,2) NOT NULL,
    "refAmount" DECIMAL(12,2) NOT NULL,
    "adjustAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "breakdownJson" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "lockedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "PayoutRun_pkey" PRIMARY KEY ("id")
);

-- PayoutAdjustment
CREATE TABLE "PayoutAdjustment" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "providerId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "sourceMonth" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "refCode" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoutAdjustment_pkey" PRIMARY KEY ("id")
);

-- Foreign key for PayoutAdjustment → PayoutRun
ALTER TABLE "PayoutAdjustment" ADD CONSTRAINT "PayoutAdjustment_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "PayoutRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Unique constraints
CREATE UNIQUE INDEX "ProviderReferral_billItemEleId_fromProviderId_key"
    ON "ProviderReferral"("billItemEleId", "fromProviderId");
CREATE UNIQUE INDEX "SpSubsidy_billItemEleId_key"
    ON "SpSubsidy"("billItemEleId");
CREATE UNIQUE INDEX "PayoutRun_providerId_periodMonth_key"
    ON "PayoutRun"("providerId", "periodMonth");

-- Indexes
CREATE INDEX "ProviderReferral_fromProviderId_periodMonth_idx"
    ON "ProviderReferral"("fromProviderId", "periodMonth");
CREATE INDEX "SpSubsidy_providerId_periodMonth_idx"
    ON "SpSubsidy"("providerId", "periodMonth");
CREATE INDEX "PayoutAdjustment_providerId_periodMonth_idx"
    ON "PayoutAdjustment"("providerId", "periodMonth");
