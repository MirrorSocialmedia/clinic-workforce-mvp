-- CreateTable
CREATE TABLE "MiscIncome" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "incomeAt" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "note" TEXT,
    "methodNorm" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "isVoid" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MiscIncome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MiscIncome_clinicId_periodMonth_idx" ON "MiscIncome"("clinicId", "periodMonth");

-- AddForeignKey
ALTER TABLE "MiscIncome" ADD CONSTRAINT "MiscIncome_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

