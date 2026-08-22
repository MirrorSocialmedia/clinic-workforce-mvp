-- AlterTable
ALTER TABLE "ProviderShift" ADD COLUMN     "slot" TEXT;

-- CreateTable
CREATE TABLE "ProviderWeeklyPattern" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "slot" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderWeeklyPattern_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderWeeklyPattern_clinicId_weekday_idx" ON "ProviderWeeklyPattern"("clinicId", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderWeeklyPattern_providerId_clinicId_weekday_key" ON "ProviderWeeklyPattern"("providerId", "clinicId", "weekday");

-- AddForeignKey
ALTER TABLE "ProviderWeeklyPattern" ADD CONSTRAINT "ProviderWeeklyPattern_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderWeeklyPattern" ADD CONSTRAINT "ProviderWeeklyPattern_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

