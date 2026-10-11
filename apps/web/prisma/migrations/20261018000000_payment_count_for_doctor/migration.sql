-- ★ cwm-doctorflag-20261011：付款方式規則加「計醫生收入」（countForDoctor），每筆 PaymentAllocation 同步時快照。
--   取代寫死嘅「countAsIncome OR methodNorm = 'FREE_SP'」—— backfill 用返【完全相同】嘅條件，數字零改變。

-- 1) 規則
ALTER TABLE "PaymentMethodRule" ADD COLUMN "countForDoctor" BOOLEAN NOT NULL DEFAULT true;
UPDATE "PaymentMethodRule"
SET "countForDoctor" = ("countAsIncome" OR UPPER(REPLACE(TRIM("method"), ' ', '_')) = 'FREE_SP');

-- 2) 付款分配快照（舊行 = 舊引擎口徑；之後由同步按規則寫入，唔留 default）
ALTER TABLE "PaymentAllocation" ADD COLUMN "countForDoctor" BOOLEAN NOT NULL DEFAULT true;
UPDATE "PaymentAllocation"
SET "countForDoctor" = ("countAsIncome" OR "methodNorm" = 'FREE_SP');
ALTER TABLE "PaymentAllocation" ALTER COLUMN "countForDoctor" DROP DEFAULT;
