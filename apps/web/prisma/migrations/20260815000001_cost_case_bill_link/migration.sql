-- ★ MD-F: CostCase bill linking fields
ALTER TABLE "CostCase" ADD COLUMN "billExtId" TEXT;
ALTER TABLE "CostCase" ADD COLUMN "billCode" TEXT;
ALTER TABLE "CostCase" ADD COLUMN "billItemEleId" TEXT;
ALTER TABLE "CostCase" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'BILL_LINKED';

-- Backfill: old records were manually entered
UPDATE "CostCase" SET "source" = 'MANUAL' WHERE "billExtId" IS NULL;

-- Index for bill lookups
CREATE INDEX "CostCase_billExtId_idx" ON "CostCase"("billExtId");
