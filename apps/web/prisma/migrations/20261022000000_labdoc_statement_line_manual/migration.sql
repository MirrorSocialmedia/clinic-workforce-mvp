-- ★ 2026-10-13：月結單人手改行／加行（純加欄，唔郁現有數據）
ALTER TABLE "LabStatementLine" ADD COLUMN "manualSource" TEXT;
ALTER TABLE "LabStatementLine" ADD COLUMN "aiOriginal" JSONB;
ALTER TABLE "LabStatementLine" ADD COLUMN "manualBy" TEXT;
ALTER TABLE "LabStatementLine" ADD COLUMN "manualAt" TIMESTAMP(3);
ALTER TABLE "LabStatementLine" ADD COLUMN "manualNote" TEXT;
