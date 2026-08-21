-- CreateTable
CREATE TABLE "LeaveBalanceSnapshot" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "remaining" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveBalanceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeaveBalanceSnapshot_employeeId_leaveTypeId_periodMonth_key" ON "LeaveBalanceSnapshot"("employeeId", "leaveTypeId", "periodMonth");

-- AddForeignKey
ALTER TABLE "LeaveBalanceSnapshot" ADD CONSTRAINT "LeaveBalanceSnapshot_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveBalanceSnapshot" ADD CONSTRAINT "LeaveBalanceSnapshot_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
