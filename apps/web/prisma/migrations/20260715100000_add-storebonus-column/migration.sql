-- Add storeBonus column to PayrollItem (drift repair: missed by 20260715000000)
-- IF NOT EXISTS is idempotent: safe to re-run if column already exists locally
ALTER TABLE "PayrollItem" ADD COLUMN IF NOT EXISTS "storeBonus" DOUBLE PRECISION NOT NULL DEFAULT 0;
