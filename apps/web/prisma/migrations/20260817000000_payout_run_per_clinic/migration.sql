-- PayoutRun: add clinicId (NOT NULL, default '' for migration, then drop default)
ALTER TABLE "PayoutRun" ADD COLUMN "clinicId" TEXT NOT NULL DEFAULT '';

-- Drop old unique key: providerId + periodMonth
DROP INDEX IF EXISTS "PayoutRun_providerId_periodMonth_key";

-- Create ternary unique key: providerId + clinicId + periodMonth
CREATE UNIQUE INDEX "PayoutRun_providerId_clinicId_periodMonth_key" ON "PayoutRun"("providerId","clinicId","periodMonth");

-- Index for clinic+month lookups
CREATE INDEX "PayoutRun_clinicId_periodMonth_idx" ON "PayoutRun"("clinicId","periodMonth");

-- Remove the DEFAULT so clinicId is truly NOT NULL from now on
ALTER TABLE "PayoutRun" ALTER COLUMN "clinicId" DROP DEFAULT;

-- SpSubsidy: add clinicId snapshot
ALTER TABLE "SpSubsidy" ADD COLUMN "clinicId" TEXT;

-- ProviderReferral: add clinicId snapshot
ALTER TABLE "ProviderReferral" ADD COLUMN "clinicId" TEXT;

-- PayoutAdjustment: add clinicId snapshot
ALTER TABLE "PayoutAdjustment" ADD COLUMN "clinicId" TEXT;

-- ReconciliationImport: add clinicId
ALTER TABLE "ReconciliationImport" ADD COLUMN "clinicId" TEXT;
