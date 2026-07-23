-- CreateExpenseEntry table
CREATE TABLE "ExpenseEntry" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "clinicId" TEXT,
    "periodMonth" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExpenseEntry_employeeId_periodMonth_idx" ON "ExpenseEntry"("employeeId", "periodMonth");

-- CreateIndex
CREATE INDEX "ExpenseEntry_periodMonth_clinicId_idx" ON "ExpenseEntry"("periodMonth", "clinicId");

-- Add misc fields to PayrollItem
ALTER TABLE "PayrollItem" ADD COLUMN "miscAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "PayrollItem" ADD COLUMN "miscDetailJson" TEXT;

-- AddForeignKey
ALTER TABLE "ExpenseEntry" ADD CONSTRAINT "ExpenseEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseEntry" ADD CONSTRAINT "ExpenseEntry_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE SET NULL ON UPDATE CASCADE;
