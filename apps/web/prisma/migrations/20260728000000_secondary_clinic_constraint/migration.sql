-- ★ 調鋪方案 1：Shift 加 secondaryClinicId + unique constraint + indexes
-- ⚠️ 執行前先跑 scripts/check-shift-duplicates.sql 確認冇重複資料

-- 1. 加 nullable 欄位
ALTER TABLE "Shift" ADD COLUMN "secondaryClinicId" VARCHAR(255);

-- 2. 加 index
CREATE INDEX "Shift_secondaryClinicId" ON "Shift"("secondaryClinicId");
CREATE INDEX "Shift_employeeId_startTime" ON "Shift"("employeeId", "startTime");

-- 3. 加 unique constraint（先清重複先執行呢行）
ALTER TABLE "Shift" ADD CONSTRAINT "uniq_emp_clinic_start" UNIQUE("employeeId", "clinicId", "startTime");
