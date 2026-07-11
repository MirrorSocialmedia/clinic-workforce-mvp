-- AlterTable
ALTER TABLE "LeaveRequest" ADD COLUMN     "clinicId" TEXT;

-- CreateIndex
CREATE INDEX "LeaveRequest_clinicId_idx" ON "LeaveRequest"("clinicId");
