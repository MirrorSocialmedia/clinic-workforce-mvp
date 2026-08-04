-- DropIndex
DROP INDEX "AuditLog_targetEmployeeId_idx";

-- AlterTable
ALTER TABLE "FaceEnrollCode" ALTER COLUMN "expiresAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "usedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "FaceTemplate" ALTER COLUMN "enrolledAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "consentAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "approvedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "approvedBy" SET DATA TYPE TEXT,
ALTER COLUMN "refFrameId" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "PunchRecord" ALTER COLUMN "faceStatus" SET DATA TYPE TEXT,
ALTER COLUMN "faceFramePath" SET DATA TYPE TEXT,
ALTER COLUMN "faceReviewedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "faceReviewedBy" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "Shift" ALTER COLUMN "secondaryClinicId" SET DATA TYPE TEXT;

-- CreateTable
CREATE TABLE "ScheduleNote" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleNote_companyId_date_idx" ON "ScheduleNote"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleNote_companyId_date_key" ON "ScheduleNote"("companyId", "date");

-- AddForeignKey
ALTER TABLE "ScheduleNote" ADD CONSTRAINT "ScheduleNote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "Shift_employeeId_startTime" RENAME TO "Shift_employeeId_startTime_idx";

-- RenameIndex
ALTER INDEX "Shift_secondaryClinicId" RENAME TO "Shift_secondaryClinicId_idx";

-- RenameIndex
ALTER INDEX "uniq_emp_clinic_start" RENAME TO "Shift_employeeId_clinicId_startTime_key";

-- RenameIndex
ALTER INDEX "ShiftTemplate_companyId" RENAME TO "ShiftTemplate_companyId_idx";
