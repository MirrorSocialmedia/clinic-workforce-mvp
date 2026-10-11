-- 2026-10-11：讀單排隊（先到先讀）— 入隊時間；舊單用上傳時間
ALTER TABLE "LabDocument" ADD COLUMN "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "LabDocument" SET "queuedAt" = "createdAt";
CREATE INDEX "LabDocument_status_queuedAt_idx" ON "LabDocument"("status", "queuedAt");
