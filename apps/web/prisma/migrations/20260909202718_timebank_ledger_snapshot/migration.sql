-- CreateTable
CREATE TABLE "TimeBankLedgerSnapshot" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "opening" INTEGER NOT NULL,
    "closing" INTEGER NOT NULL,
    "linesJson" TEXT NOT NULL,
    "engineVersion" INTEGER NOT NULL,
    "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "frozenBy" TEXT NOT NULL,

    CONSTRAINT "TimeBankLedgerSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TimeBankLedgerSnapshot_employeeId_periodMonth_idx" ON "TimeBankLedgerSnapshot"("employeeId", "periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "TimeBankLedgerSnapshot_employeeId_periodMonth_key" ON "TimeBankLedgerSnapshot"("employeeId", "periodMonth");

-- AddForeignKey
ALTER TABLE "TimeBankLedgerSnapshot" ADD CONSTRAINT "TimeBankLedgerSnapshot_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
