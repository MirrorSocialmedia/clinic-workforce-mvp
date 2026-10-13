-- ★ cwm-dailyreview2-20261014：每日大數「核對同事」逐醫生逐日覆核
CREATE TABLE "DailyDoctorReview" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    "doctorRaw" DECIMAL(12,2) NOT NULL,
    "storeTotal" DECIMAL(12,2) NOT NULL,
    "reviewedBy" TEXT NOT NULL,
    "reviewerName" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,

    CONSTRAINT "DailyDoctorReview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DailyDoctorReview_clinicId_providerId_date_idx" ON "DailyDoctorReview"("clinicId", "providerId", "date");

-- 同一格（店 × 醫生 × 日）同一時間只可以有一條有效覆核
CREATE UNIQUE INDEX "DailyDoctorReview_active_key" ON "DailyDoctorReview"("clinicId", "providerId", "date") WHERE "revokedAt" IS NULL;
