-- cwm-resigpay-20260904：離職結算寫入 PayrollItem（JSON，NULL = 無結算）
-- 結構：{ lastDay, noticeDays, noticePay, annualLeaveDays, annualLeavePay,
--         tbMinutes, tbAmount, tbDeduction, quarterCap, adwUsed, settledAt, settledBy }
-- ⚠️ 唔存 monthWage —— 引擎自 2026-09-04 起會按受僱日數 prorate，
--    PayrollItem.salary/basePay 本身已係啱嘅數，存兩份會分歧（MD §六）。
ALTER TABLE "PayrollItem" ADD COLUMN "resignSettlementJson" TEXT;
