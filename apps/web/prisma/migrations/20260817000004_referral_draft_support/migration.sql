-- MD-U: ProviderReferral draft support
-- Add status column (DRAFT | CONFIRMED), patientNote, make bill-related columns nullable

-- Drop unique constraint before making billItemEleId nullable
ALTER TABLE "ProviderReferral" DROP CONSTRAINT IF EXISTS "ProviderReferral_billItemEleId_fromProviderId_key";

-- Add new columns
ALTER TABLE "ProviderReferral" ADD COLUMN "status" TEXT DEFAULT 'CONFIRMED';
ALTER TABLE "ProviderReferral" ADD COLUMN "patientNote" TEXT;

-- Make bill-related columns nullable (for DRAFT referrals without bill data)
ALTER TABLE "ProviderReferral" ALTER COLUMN "billExtId" DROP NOT NULL;
ALTER TABLE "ProviderReferral" ALTER COLUMN "billCode" DROP NOT NULL;
ALTER TABLE "ProviderReferral" ALTER COLUMN "billItemEleId" DROP NOT NULL;
ALTER TABLE "ProviderReferral" ALTER COLUMN "itemDes" DROP NOT NULL;
ALTER TABLE "ProviderReferral" ALTER COLUMN "unitPrice" DROP NOT NULL;
ALTER TABLE "ProviderReferral" ALTER COLUMN "amount" DROP NOT NULL;

-- Add index on status
CREATE INDEX "ProviderReferral_status_idx" ON "ProviderReferral"("status");
