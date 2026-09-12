-- CreateTable
CREATE TABLE "HolidayOtAdjustment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "deductMinutes" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HolidayOtAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HolidayOtAdjustment_employeeId_workDate_idx" ON "HolidayOtAdjustment"("employeeId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "HolidayOtAdjustment_employeeId_workDate_key" ON "HolidayOtAdjustment"("employeeId", "workDate");

-- AddForeignKey
ALTER TABLE "HolidayOtAdjustment" ADD CONSTRAINT "HolidayOtAdjustment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

