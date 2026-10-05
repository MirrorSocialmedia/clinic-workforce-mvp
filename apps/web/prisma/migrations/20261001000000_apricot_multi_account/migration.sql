-- ★ cwm-apricotty-20261001：Apricot 多帳號（青衣 = TY）
-- 全部欄位有 default 'MAIN' → 現有資料自動歸原帳號，行為零改變。
ALTER TABLE "Clinic" ADD COLUMN "apricotAccount" TEXT NOT NULL DEFAULT 'MAIN';
ALTER TABLE "Clinic" ADD COLUMN "apricotPayoutFrom" TEXT;

ALTER TABLE "PatientIndex" ADD COLUMN "apricotAccount" TEXT NOT NULL DEFAULT 'MAIN';

ALTER TABLE "ApricotDictionary" ADD COLUMN "apricotAccount" TEXT NOT NULL DEFAULT 'MAIN';
CREATE INDEX "ApricotDictionary_apricotAccount_kind_isRemoved_idx" ON "ApricotDictionary"("apricotAccount", "kind", "isRemoved");

ALTER TABLE "ClinicalIndexJob" ADD COLUMN "account" TEXT NOT NULL DEFAULT 'MAIN';
