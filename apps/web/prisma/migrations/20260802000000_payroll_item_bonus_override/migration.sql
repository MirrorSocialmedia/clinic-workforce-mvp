-- 勤工獎覆蓋：null = 自動判斷；'FORCE_ON' = 強制發放；'FORCE_OFF' = 強制取消
ALTER TABLE "PayrollItem" ADD COLUMN "attendanceBonusOverride" TEXT;
