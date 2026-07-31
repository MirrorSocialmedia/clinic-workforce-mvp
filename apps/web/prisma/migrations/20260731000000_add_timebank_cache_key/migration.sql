-- Add cacheKey fingerprint column to TimeBank for auto-invalidation
-- Nullable: old rows cacheKey=null → mismatch → first read triggers recalc
ALTER TABLE "TimeBank" ADD COLUMN "cacheKey" TEXT;
