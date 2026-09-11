-- ============================================================================
-- 20260910-d1d2-payrules-cleanup.sql   [cwm-reconkiosk-20260910 · S5]
-- PaymentMethodRule 清理：D1 重複 CASH 行 ＋ D2 死規則（FREE SP / WECHATPAY）
--
-- 背景（生產實測）：
--   CASH      | 0.000 | t | 2025-12-31 |  ← 重複兩行（同日生效、都冇到期）
--   CASH      | 0.000 | t | 2025-12-31 |  ←
--   FREE SP   | 0.000 | f | 2025-12-31 |  ← 死規則（有空格，永遠 match 唔到）
--   FREE_SP   | 0.000 | f | 2025-12-31 |  ← 生效嗰條（★ 要保留）
--   WECHATPAY | 2.000 | t | 2025-12-31 |  ← 死規則（METHOD_MAP 輸出 WECHAT 唔係 WECHATPAY）
--
-- ★ 執行次序：
--   0. 先 ./backup.sh 全庫備份
--   1. 行本 script（內置 guard：數值唔一樣 / FREE_SP 冇晒 → 自動 0 行刪除）
--   2. 之後先加 @@unique([method, effectiveFrom]) migration（prisma migrate deploy）
--      — 有重複未清就加唔到，所以次序唔好反
--
-- ★ 冪等：
--   D1 guard 要求「恰有 2 行 CASH 且數值完全一樣」— 清完只剩 1 行 → 重跑 0 刪除
--   D2 guard 要求 FREE_SP 存在 — 刪 FREE SP/WECHATPAY 唔影響 FREE_SP → 重跑 0 刪除
-- ============================================================================

BEGIN;

-- ---------- D1：CASH 重複 ----------
-- 1a) 先晒兩行分別係咩（ eyeball 確認 — MD 已預判兩行一樣，deploy 時再核）
SELECT id, method, label, "feePercent", "countAsIncome",
       "effectiveFrom"::date, "effectiveTo"::date, "createdBy"
FROM "PaymentMethodRule" WHERE method = 'CASH' ORDER BY id;

-- 1b) 帶 guard 刪：只係「恰 2 行 CASH 且 (label, feePercent, countAsIncome, effectiveFrom, effectiveTo)
--     完全一樣」先刪 id 細嗰條（留 id 大 = resolveMethodRule 而家實際用緊嗰條 → 零行為改變）
--     兩行數值唔同 → guard 唔成立 → 0 行刪除（唔好亂刪，貼出嚟再判）
DELETE FROM "PaymentMethodRule"
WHERE method = 'CASH'
  AND id = (SELECT min(id) FROM "PaymentMethodRule" WHERE method = 'CASH')
  AND EXISTS (
    SELECT 1
    FROM (
      SELECT label, "feePercent", "countAsIncome", "effectiveFrom", "effectiveTo", count(*) AS c
      FROM "PaymentMethodRule" WHERE method = 'CASH'
      GROUP BY label, "feePercent", "countAsIncome", "effectiveFrom", "effectiveTo"
      HAVING count(*) = 2
    ) dup
  );

-- 驗證 D1：CASH 應該只剩 1 行（重跑 = 1 行、0 刪除）
SELECT count(*) AS cash_rows FROM "PaymentMethodRule" WHERE method = 'CASH';

-- ---------- D2：死規則 ----------
-- 2a) 刪前確認 FREE_SP（底線）仲喺 — 佢先係生效嗰條
SELECT id, label, "feePercent", "countAsIncome", "effectiveFrom"::date
FROM "PaymentMethodRule" WHERE method = 'FREE_SP';

-- 2b) 帶 guard 刪：FREE_SP 存在先刪 FREE SP / WECHATPAY（normalizeMethod 只會輸出
--     METHOD_MAP 嘅 value，兩個死名永遠 match 唔到 → 零影響）
DELETE FROM "PaymentMethodRule"
WHERE method IN ('FREE SP', 'WECHATPAY')
  AND EXISTS (SELECT 1 FROM "PaymentMethodRule" WHERE method = 'FREE_SP');

-- 驗證 D2：FREE SP / WECHATPAY 應該 0；FREE_SP 應該 1
SELECT method, count(*) AS n FROM "PaymentMethodRule"
WHERE method IN ('FREE SP', 'WECHATPAY', 'FREE_SP') GROUP BY method ORDER BY method;

COMMIT;

-- 3) 清理後全表總覽（ eyeball ）
SELECT id, method, label, "feePercent", "countAsIncome",
       "effectiveFrom"::date, "effectiveTo"::date
FROM "PaymentMethodRule" ORDER BY method, "effectiveFrom";
