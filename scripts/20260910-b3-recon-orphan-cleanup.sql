-- ============================================================================
-- 20260910-b3-recon-orphan-cleanup.sql   [cwm-reconkiosk-20260910 · S4]
-- 清走 ReconciliationImport clinicId=NULL 孤兒（生產 5 筆；dev fixture 4 筆）
--
-- 背景：clinic-scope 修復前上載嘅記錄冇 clinicId → B1/B2（code）落咗之後
--       呢啲記錄永遠 match 唔到任何月結單，只係喺 /reconciliation 列表
--       顯示為診所欄空白嘅舊行。清走係整齊問題，非正確性問題。
--
-- ★ 執行次序（照單做）：
--   0. 先 ./backup.sh 全庫備份
--   1. 先 deploy 本單 code（B1/B2 clinicId 過濾）— 之後 NULL 行唔再影響 badge
--   2. 行呢個 script（單 transaction）
--   3. 老細留意：劉浩賢醫生 2026-07 嗰筆 difference=0.00 係有效「吻合」記錄，
--      刪咗之後佢 2026-07 月結單 ✅ badge 消失 → 要重新上載一次 MF 報表先有返
--      （今次上載會帶 clinicId）。何嘉俊 573,384×3 + 770,488 四筆係全診所混埋數，
--      刪咗係好事，重新上載會出正確數。
--
-- ★ 冪等：backup 表 CREATE IF NOT EXISTS（只備份第一次）；DELETE 天然冪等。
--   重跑：backup count 唔變、DELETE 0 行、第二個 count = 0。
-- ============================================================================

BEGIN;

-- 1) 備份（只係第一次執行先有 row 入去）
CREATE TABLE IF NOT EXISTS recon_import_backup_20260910 AS
SELECT * FROM "ReconciliationImport" WHERE "clinicId" IS NULL;

-- 驗證 1：備份表 count（生產要 5；dev fixture 要 4；重跑 = 舊值）
SELECT count(*) AS backup_count FROM recon_import_backup_20260910;

-- 2) 刪除
DELETE FROM "ReconciliationImport" WHERE "clinicId" IS NULL;

-- 驗證 2：剩餘 NULL 要 0
SELECT count(*) AS remaining_null FROM "ReconciliationImport" WHERE "clinicId" IS NULL;

COMMIT;

-- 3) 留底：晒少少刪咗咩（供老姐 eyeball）
SELECT id, "providerId", "periodMonth", "reportTotal", "systemTotal", "difference", status
FROM recon_import_backup_20260910 ORDER BY "periodMonth", "providerId";
