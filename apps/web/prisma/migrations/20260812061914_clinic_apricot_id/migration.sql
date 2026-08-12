-- Apricot clinic ID correspondence — unique per clinic (NULLs OK)
ALTER TABLE "Clinic" ADD COLUMN "apricotClinicId" TEXT;
CREATE UNIQUE INDEX "Clinic_apricotClinicId_key" ON "Clinic"("apricotClinicId") WHERE "apricotClinicId" IS NOT NULL;
