-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT,
    "periodMonth" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PayrollRun_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PayrollItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workedHours" REAL NOT NULL DEFAULT 0,
    "otHours" REAL NOT NULL DEFAULT 0,
    "leaveDays" REAL NOT NULL DEFAULT 0,
    "absentDays" REAL NOT NULL DEFAULT 0,
    "basePay" REAL NOT NULL DEFAULT 0,
    "otPay" REAL NOT NULL DEFAULT 0,
    "splitPay" REAL,
    "deduction" REAL NOT NULL DEFAULT 0,
    "totalPayable" REAL NOT NULL DEFAULT 0,
    "detailJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PayrollItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PayrollItem_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PayrollRun_periodMonth_idx" ON "PayrollRun"("periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_clinicId_periodMonth_key" ON "PayrollRun"("clinicId", "periodMonth");

-- CreateIndex
CREATE INDEX "PayrollItem_employeeId_createdAt_idx" ON "PayrollItem"("employeeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollItem_runId_employeeId_key" ON "PayrollItem"("runId", "employeeId");
