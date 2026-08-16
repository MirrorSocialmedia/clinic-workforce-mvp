-- S3: 加 status 欄
ALTER TABLE "SpSubsidy" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PENDING';

-- S1: 加 hasMarker 欄
ALTER TABLE "SpSubsidy" ADD COLUMN "hasMarker" BOOLEAN NOT NULL DEFAULT true;
