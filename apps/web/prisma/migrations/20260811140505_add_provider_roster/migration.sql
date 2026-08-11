-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "phone" TEXT,
    "color" TEXT,
    "apricotId" TEXT,
    "companyId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderShift" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderShift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Provider_companyId_isActive_idx" ON "Provider"("companyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Provider_apricotId_key" ON "Provider"("apricotId");

-- CreateIndex
CREATE INDEX "ProviderShift_clinicId_date_idx" ON "ProviderShift"("clinicId", "date");

-- CreateIndex
CREATE INDEX "ProviderShift_providerId_date_idx" ON "ProviderShift"("providerId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderShift_providerId_date_startTime_key" ON "ProviderShift"("providerId", "date", "startTime");

-- AddForeignKey
ALTER TABLE "Provider" ADD CONSTRAINT "Provider_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderShift" ADD CONSTRAINT "ProviderShift_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderShift" ADD CONSTRAINT "ProviderShift_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
