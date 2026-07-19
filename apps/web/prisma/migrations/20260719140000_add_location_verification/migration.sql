-- Clinic 加座標
ALTER TABLE "Clinic" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "Clinic" ADD COLUMN "longitude" DOUBLE PRECISION;
ALTER TABLE "Clinic" ADD COLUMN "geoRadius" INTEGER;

-- PunchRecord 加位置欄位
ALTER TABLE "PunchRecord" ADD COLUMN "punchLat" DOUBLE PRECISION;
ALTER TABLE "PunchRecord" ADD COLUMN "punchLng" DOUBLE PRECISION;
ALTER TABLE "PunchRecord" ADD COLUMN "distanceM" INTEGER;
ALTER TABLE "PunchRecord" ADD COLUMN "locationFlag" TEXT;
