-- ★ cwm-reconclinic-20261006：全店月報 Practitioner 名 → 醫生

-- CreateTable
CREATE TABLE "ProviderReportName" (
    "nameNorm" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderReportName_pkey" PRIMARY KEY ("nameNorm")
);

-- CreateIndex
CREATE INDEX "ProviderReportName_providerId_idx" ON "ProviderReportName"("providerId");

-- AddForeignKey
ALTER TABLE "ProviderReportName" ADD CONSTRAINT "ProviderReportName_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
