-- CreateTable: cwm-attexempt-20260914 A 章
-- 免考勤員工（會計等）：唔打卡、唔排更、唔計 OT／遲到／編更差額，只按月薪出糧。
-- ⚠️ 計糧、MPF、年假、法定權利一律照常。

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN "attendanceExempt" BOOLEAN NOT NULL DEFAULT false;

-- ★ ACCOUNTANT 預設免考勤（2026-09-14 拍板①）
UPDATE "Employee" e SET "attendanceExempt" = true
FROM "User" u WHERE u.id = e."userId" AND u.role = 'ACCOUNTANT';
