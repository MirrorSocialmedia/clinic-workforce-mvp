-- CreateTable
CREATE TABLE "ResignSettlement" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "lastDay" TIMESTAMP(3) NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "noticeDays" INTEGER NOT NULL,
    "noticePay" DECIMAL(12,2) NOT NULL,
    "annualLeaveDays" DECIMAL(6,2) NOT NULL,
    "annualLeavePay" DECIMAL(12,2) NOT NULL,
    "tbMinutes" INTEGER NOT NULL,
    "tbAmount" DECIMAL(12,2) NOT NULL,
    "tbDeduction" DECIMAL(12,2),
    "excessRestDeduction" DECIMAL(12,2),
    "quarterCap" DECIMAL(12,2) NOT NULL,
    "adwUsed" DECIMAL(12,2) NOT NULL,
    "detailJson" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledBy" TEXT NOT NULL,
    CONSTRAINT "ResignSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResignSettlement_employeeId_key" ON "ResignSettlement"("employeeId");

-- CreateIndex
CREATE INDEX "ResignSettlement_periodMonth_idx" ON "ResignSettlement"("periodMonth");

-- AddForeignKey
ALTER TABLE "ResignSettlement" ADD CONSTRAINT "ResignSettlement_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
