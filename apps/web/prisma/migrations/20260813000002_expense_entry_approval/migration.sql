-- 雜項費用審批流程：加 status 等欄位
ALTER TABLE "ExpenseEntry" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "ExpenseEntry" ADD COLUMN "submittedBy" TEXT;
ALTER TABLE "ExpenseEntry" ADD COLUMN "reviewedBy" TEXT;
ALTER TABLE "ExpenseEntry" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "ExpenseEntry" ADD COLUMN "rejectReason" TEXT;
ALTER TABLE "ExpenseEntry" ADD COLUMN "receiptUrl" TEXT;

-- ★★★ 現有記錄全部補做已批 —— 冇呢句，歷史雜項會即刻由糧單消失
UPDATE "ExpenseEntry" SET "status" = 'APPROVED';

CREATE INDEX "ExpenseEntry_status_periodMonth_idx" ON "ExpenseEntry"("status", "periodMonth");
