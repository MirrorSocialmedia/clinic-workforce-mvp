-- AlterTable
-- ★ cwm-payrollsheet-20260921 S3：支票號碼（出糧後人手填；純記錄，唔影響計算）
-- 只准一句（工單鐵律）

ALTER TABLE "PayrollItem" ADD COLUMN "chequeNo" TEXT;
