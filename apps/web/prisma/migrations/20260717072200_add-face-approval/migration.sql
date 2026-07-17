-- Add approval fields to FaceTemplate
ALTER TABLE "FaceTemplate" ADD COLUMN "approvedAt" TIMESTAMPTZ;
ALTER TABLE "FaceTemplate" ADD COLUMN "approvedBy" VARCHAR;
ALTER TABLE "FaceTemplate" ADD COLUMN "refFrameId" VARCHAR;
