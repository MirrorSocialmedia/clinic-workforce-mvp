-- CreateTable (from 183835, moved here)
CREATE TABLE "Company" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- AlterTable: Clinic add companyId (from 183835)
ALTER TABLE "Clinic" ADD COLUMN "companyId" TEXT;

ALTER TABLE "Clinic" ADD CONSTRAINT "Clinic_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable (from original 114144 - type fixes)
ALTER TABLE "Company" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);
