-- CreateTable is not needed, just add column and relation

-- AlterTable: Add targetEmployeeId to AuditLog
ALTER TABLE "AuditLog" ADD COLUMN "targetEmployeeId" TEXT;

-- CreateIndex: Add index for targetEmployee lookups
CREATE INDEX "AuditLog_targetEmployeeId_idx" ON "AuditLog"("targetEmployeeId");

-- CreateForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_targetEmployeeId_fkey" 
  FOREIGN KEY ("targetEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
