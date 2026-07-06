-- Add isPlanned to LeaveRequest
ALTER TABLE "LeaveRequest" ADD COLUMN "isPlanned" BOOLEAN NOT NULL DEFAULT true;

-- Create TimeBank table
CREATE TABLE "TimeBank" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodMonth" TIMESTAMP(3) NOT NULL,
    "otMinutes" INTEGER NOT NULL DEFAULT 0,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "carriedFrom" INTEGER NOT NULL DEFAULT 0,
    "monthEndNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeBank_pkey" PRIMARY KEY ("id")
);

-- Foreign key
ALTER TABLE "TimeBank" ADD CONSTRAINT "TimeBank_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Unique constraint: one record per employee per month
CREATE UNIQUE INDEX "TimeBank_employeeId_periodMonth_key" ON "TimeBank"("employeeId", "periodMonth");

-- Index for queries
CREATE INDEX "TimeBank_employeeId_periodMonth_idx" ON "TimeBank"("employeeId", "periodMonth");
