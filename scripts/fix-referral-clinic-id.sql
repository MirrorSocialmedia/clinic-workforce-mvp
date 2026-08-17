-- ★ Y1: 診斷 ProviderReferral 的 clinicId 狀態
-- 用途：檢查有無 clinicId 為 null 或有值但 clinic 已刪除的記錄

-- 1. 統計各 billCode + clinicId 組合
SELECT "billCode", "clinicId", count(*)
FROM "ProviderReferral"
GROUP BY "billCode", "clinicId"
ORDER BY "billCode";

-- 2. 找出 clinicId 為 null 的記錄（需要修復）
SELECT id, "billCode", "billExtId", "periodMonth", "fromProviderId"
FROM "ProviderReferral"
WHERE "clinicId" IS NULL
  AND "status" = 'CONFIRMED'
ORDER BY "periodMonth" DESC;

-- 3. 找出 clinicId 有值但對應 Clinic 記錄已刪除的記錄
SELECT pr.id, pr."billCode", pr."clinicId", pr."periodMonth"
FROM "ProviderReferral" pr
LEFT JOIN "Clinic" c ON pr."clinicId" = c.id
WHERE c.id IS NULL
  AND pr."clinicId" IS NOT NULL
ORDER BY pr."periodMonth" DESC;

-- 4. 修復：由 ApricotBill → Clinic 補 clinicId
-- ⚠️ 只在確認無誤後才執行
-- UPDATE "ProviderReferral"
-- SET "clinicId" = (
--   SELECT cl.id
--   FROM "ApricotBill" ab
--   JOIN "Clinic" cl ON cl."apricotClinicId" = ab."clinicExtId"
--   WHERE ab."extId" = "ProviderReferral"."billExtId"
--   LIMIT 1
-- )
-- WHERE "clinicId" IS NULL
--   AND "billExtId" IS NOT NULL
--   AND "status" = 'CONFIRMED';
