-- ★ 2026-09-10 cwm-payrollui 拍板⑤：計糧詳情自訂顯示（全公司統一設定）
-- Surgical：淨加一欄，唔改任何現有欄
-- AddField
ALTER TABLE "Company" ADD COLUMN "payrollViewJson" TEXT;
