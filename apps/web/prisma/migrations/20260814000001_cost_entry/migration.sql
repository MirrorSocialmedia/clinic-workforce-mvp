-- MD-B: Cost Entry — Lab / Implant / Invisalign

-- Lab 主檔
CREATE TABLE "Lab" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Lab_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Lab_name_key" ON "Lab"("name");

-- Universal 月度折扣
CREATE TABLE "LabMonthlyDiscount" (
    "id" TEXT NOT NULL,
    "labId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "discountPct" DECIMAL(5,2) NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabMonthlyDiscount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LabMonthlyDiscount_labId_periodMonth_key" ON "LabMonthlyDiscount"("labId", "periodMonth");

-- 材料主檔
CREATE TABLE "MaterialItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "MaterialItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MaterialItem_name_effectiveFrom_idx" ON "MaterialItem"("name", "effectiveFrom");

-- 成本 case
CREATE TABLE "CostCase" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "patientCode" TEXT NOT NULL,
    "patientName" TEXT,
    "orderedAt" TIMESTAMP(3) NOT NULL,
    "itemType" TEXT,
    "labId" TEXT,
    "labOrderNo" TEXT,
    "dsaName" TEXT,
    "baseCost" DECIMAL(12,2),
    "discountPct" DECIMAL(5,2),
    "finalCost" DECIMAL(12,2),
    "receivedAt" TIMESTAMP(3),
    "appointmentAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "periodMonth" TEXT NOT NULL,
    "lockedByRunId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostCase_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CostCase_providerId_periodMonth_idx" ON "CostCase"("providerId", "periodMonth");
CREATE INDEX "CostCase_status_idx" ON "CostCase"("status");
CREATE INDEX "CostCase_patientCode_idx" ON "CostCase"("patientCode");

-- IMPLANT 材料明細
CREATE TABLE "CostCaseMaterial" (
    "id" TEXT NOT NULL,
    "costCaseId" TEXT NOT NULL,
    "materialItemId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPriceUsed" DECIMAL(12,2) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "CostCaseMaterial_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CostCaseMaterial_costCaseId_idx" ON "CostCaseMaterial"("costCaseId");

-- Foreign keys
ALTER TABLE "LabMonthlyDiscount" ADD CONSTRAINT "LabMonthlyDiscount_labId_fkey"
    FOREIGN KEY ("labId") REFERENCES "Lab"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CostCase" ADD CONSTRAINT "CostCase_labId_fkey"
    FOREIGN KEY ("labId") REFERENCES "Lab"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CostCaseMaterial" ADD CONSTRAINT "CostCaseMaterial_costCaseId_fkey"
    FOREIGN KEY ("costCaseId") REFERENCES "CostCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
