-- Add face verification columns to PunchRecord
ALTER TABLE "PunchRecord" ADD COLUMN "faceStatus" VARCHAR;
ALTER TABLE "PunchRecord" ADD COLUMN "faceScore" DOUBLE PRECISION;
ALTER TABLE "PunchRecord" ADD COLUMN "faceLiveness" DOUBLE PRECISION;
ALTER TABLE "PunchRecord" ADD COLUMN "faceFramePath" VARCHAR;
ALTER TABLE "PunchRecord" ADD COLUMN "faceReviewedAt" TIMESTAMPTZ;
ALTER TABLE "PunchRecord" ADD COLUMN "faceReviewedBy" VARCHAR;

-- Create FaceTemplate table
CREATE TABLE "FaceTemplate" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "embedding" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "enrolledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enrolledBy" TEXT NOT NULL,
    "consentAt" TIMESTAMPTZ(3) NOT NULL,
    "consentVersion" TEXT NOT NULL,

    CONSTRAINT "FaceTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FaceTemplate_employeeId_active_idx" ON "FaceTemplate"("employeeId", "active");

ALTER TABLE "FaceTemplate" ADD CONSTRAINT "FaceTemplate_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Create FaceEnrollCode table
CREATE TABLE "FaceEnrollCode" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "FaceEnrollCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FaceEnrollCode_code_key" ON "FaceEnrollCode"("code");

