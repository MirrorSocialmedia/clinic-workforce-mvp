-- ADW Compliance Phase 1: WageHistory + PayrollItem ADW fields + LeaveType systemKey expansion

-- Create WageHistory table
CREATE TABLE "WageHistory" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "totalWage" DOUBLE PRECISION NOT NULL,
    "excludedDays" INTEGER NOT NULL DEFAULT 0,
    "excludedWage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "calendarDays" INTEGER NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WageHistory_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint: one WageHistory per employee per month
CREATE UNIQUE INDEX "WageHistory_employeeId_periodMonth_key" ON "WageHistory"("employeeId", "periodMonth");

-- Create index for fast period queries
CREATE INDEX "WageHistory_employeeId_periodMonth_idx" ON "WageHistory"("employeeId", "periodMonth");

-- AddForeignKey for WageHistory → Employee (Cascade on delete)
ALTER TABLE "WageHistory" ADD CONSTRAINT "WageHistory_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add ADW compliance fields to PayrollItem
ALTER TABLE "PayrollItem" ADD COLUMN "eoWage" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "PayrollItem" ADD COLUMN "excludedDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PayrollItem" ADD COLUMN "excludedWage" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "PayrollItem" ADD COLUMN "adwUsed" DOUBLE PRECISION;
ALTER TABLE "PayrollItem" ADD COLUMN "maternityPay" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "PayrollItem" ADD COLUMN "paternityPay" DOUBLE PRECISION NOT NULL DEFAULT 0;
