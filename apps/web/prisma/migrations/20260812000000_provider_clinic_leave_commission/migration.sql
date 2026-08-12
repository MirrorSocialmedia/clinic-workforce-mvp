-- Add source column to ProviderShift (Phase 2 placeholder)
ALTER TABLE "ProviderShift" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL';

-- CreateTable: ProviderClinic (doctor ↔ clinic binding, for filtering only)
CREATE TABLE "ProviderClinic" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderClinic_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ProviderLeave (doctor leave — no quota, display only)
CREATE TABLE "ProviderLeave" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderLeave_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ProviderCommission (append-only commission settings)
CREATE TABLE "ProviderCommission" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "clinicId" TEXT,
    "percent" DECIMAL(5,2) NOT NULL,
    "basis" TEXT NOT NULL,
    "minGuarantee" DECIMAL(12,2),
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderCommission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderClinic_providerId_clinicId_key" ON "ProviderClinic"("providerId", "clinicId");

-- CreateIndex
CREATE INDEX "ProviderClinic_clinicId_idx" ON "ProviderClinic"("clinicId");

-- CreateIndex
CREATE INDEX "ProviderLeave_providerId_startDate_idx" ON "ProviderLeave"("providerId", "startDate");

-- CreateIndex
CREATE INDEX "ProviderLeave_startDate_endDate_idx" ON "ProviderLeave"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "ProviderCommission_providerId_effectiveFrom_idx" ON "ProviderCommission"("providerId", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "ProviderClinic" ADD CONSTRAINT "ProviderClinic_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderClinic" ADD CONSTRAINT "ProviderClinic_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderLeave" ADD CONSTRAINT "ProviderLeave_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCommission" ADD CONSTRAINT "ProviderCommission_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
