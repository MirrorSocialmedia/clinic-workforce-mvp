-- CreateTable
CREATE TABLE "ClinicalTermMap" (
    "id" TEXT NOT NULL,
    "shorthand" TEXT NOT NULL,
    "nameCn" TEXT NOT NULL,
    "nameEn" TEXT,
    "usedFor" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicalTermMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicalRxCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameCn" TEXT,
    "isAntibiotic" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicalRxCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalTermMap_shorthand_key" ON "ClinicalTermMap"("shorthand");

-- CreateIndex
CREATE INDEX "ClinicalTermMap_active_idx" ON "ClinicalTermMap"("active");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalRxCode_code_key" ON "ClinicalRxCode"("code");

-- CreateIndex
CREATE INDEX "ClinicalRxCode_active_idx" ON "ClinicalRxCode"("active");
