-- ★ cwm-invismerge-20261006：隱形矯正已喺 2026-08-28 併入 LAB（成本錄入冇咗呢個類別掣）。
--   老闆拍板：「Invisalign 類別直接刪走」。
--   未鎖定嘅舊 INVISALIGN 成本一併轉做 LAB：金額、折扣快照、到貨月全部唔變（兩類本來都跟到貨日、都套 Lab 折扣），
--   只係醫生月結由「Invisalign 成本」行搬去「Lab 成本」行，總額唔變。項目冇填嘅補 'Invisalign'，日後仲認得返。
--   已鎖定（lockedByRunId 有值）嘅唔郁：舊月結單嘅 invisalignCost 係鎖定時快照，明細／Excel 重出要對得返。
UPDATE "CostCase"
SET "category" = 'LAB',
    "itemType" = COALESCE(NULLIF("itemType", ''), 'Invisalign'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "category" = 'INVISALIGN'
  AND "lockedByRunId" IS NULL;
