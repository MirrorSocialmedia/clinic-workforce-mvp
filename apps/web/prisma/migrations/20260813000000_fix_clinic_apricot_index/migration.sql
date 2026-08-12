-- Fix: replace partial unique index with standard unique index
-- Prisma schema uses `String? @unique` which does not support partial indexes (WHERE clause).
-- Postgres standard unique index already treats NULLs as distinct (SQL standard: NULL ≠ NULL),
-- so multiple NULL values are allowed just like the partial index.
DROP INDEX IF EXISTS "Clinic_apricotClinicId_key";
CREATE UNIQUE INDEX "Clinic_apricotClinicId_key" ON "Clinic"("apricotClinicId");
