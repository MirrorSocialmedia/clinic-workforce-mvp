-- ★ cwm-dailyv2-20261007：每日大數逐格核對（醫生 × 付款方式）
-- 無 append-only trigger（取消 tick = delete；審計靠 AuditLog）— MD ④
CREATE TABLE "DailyRevenueCellCheck" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "colKey" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "checkedBy" TEXT NOT NULL,
    "checkedName" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DailyRevenueCellCheck_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DailyRevenueCellCheck_clinicId_date_idx" ON "DailyRevenueCellCheck"("clinicId", "date");
CREATE UNIQUE INDEX "DailyRevenueCellCheck_clinicId_date_rowKey_colKey_key" ON "DailyRevenueCellCheck"("clinicId", "date", "rowKey", "colKey");
