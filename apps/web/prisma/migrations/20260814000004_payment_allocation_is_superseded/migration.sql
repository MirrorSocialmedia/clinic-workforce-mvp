-- C5: Add isSuperseded column to PaymentAllocation
-- isVoid = Apricot void (engine excludes); isSuperseded = recalculated superseded (engine excludes)

ALTER TABLE "PaymentAllocation" ADD COLUMN "isSuperseded" BOOLEAN NOT NULL DEFAULT false;

-- Replace old index with composite including both boolean flags
DROP INDEX IF EXISTS "PaymentAllocation_providerExtId_periodMonth_idx";
CREATE INDEX "PaymentAllocation_providerExtId_periodMonth_isVoid_isSuperseded_idx"
  ON "PaymentAllocation"("providerExtId", "periodMonth", "isVoid", "isSuperseded");
