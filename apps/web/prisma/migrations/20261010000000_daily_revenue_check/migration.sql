-- ★ cwm-dailycheck-20261006：每日大數護士核對
CREATE TABLE "DailyRevenueCheck" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "nurseEmployeeId" TEXT NOT NULL,
    "nurseName" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "byProviderJson" JSONB NOT NULL,
    "checkedBy" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokeReason" TEXT,
    CONSTRAINT "DailyRevenueCheck_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DailyRevenueCheck_clinicId_date_idx" ON "DailyRevenueCheck"("clinicId", "date");
-- 同一店同一日只可以有一條有效核對（連撳兩下／兩部機同時剔 → 第二個撞 unique）
CREATE UNIQUE INDEX "DailyRevenueCheck_active_key" ON "DailyRevenueCheck"("clinicId", "date") WHERE "revokedAt" IS NULL;
