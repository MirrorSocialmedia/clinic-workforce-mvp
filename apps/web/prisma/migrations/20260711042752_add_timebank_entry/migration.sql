-- AlterTable
ALTER TABLE "TimeBank" ADD COLUMN     "earlyLeaveMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "makeupMinutes" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TimeBankEntry" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeBankEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TimeBankEntry_employeeId_date_idx" ON "TimeBankEntry"("employeeId", "date");

-- AddForeignKey
ALTER TABLE "TimeBankEntry" ADD CONSTRAINT "TimeBankEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
