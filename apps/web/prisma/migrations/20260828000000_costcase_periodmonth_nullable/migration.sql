-- ★ 2026-08-27 cwm-costarrival-20260828：periodMonth 由 receivedAt 導出；
--   未到貨（receivedAt NULL）→ periodMonth NULL → 唔入任何月結。
ALTER TABLE "CostCase" ALTER COLUMN "periodMonth" DROP NOT NULL;
