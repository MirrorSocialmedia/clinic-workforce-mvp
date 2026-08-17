-- ★ 2026-08-16: ScheduleNote 加 row 欄位（底部五行備註）
-- DEFAULT 0 令現有備註全部維持 row=0（表頭原有嗰行）

ALTER TABLE "ScheduleNote" ADD COLUMN "row" INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS "ScheduleNote_companyId_date_key";
CREATE UNIQUE INDEX "ScheduleNote_companyId_date_row_key" ON "ScheduleNote"("companyId", "date", "row");
