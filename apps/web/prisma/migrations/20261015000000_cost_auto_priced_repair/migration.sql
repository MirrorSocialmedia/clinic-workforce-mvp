-- 2026-10-11 修：成本錄入改價唔會自動由「未有價」轉「已定價」（見 api/cost-cases/[id] PUT）。
-- 已有價（finalCost 有數）但仍係 PENDING 嘅成本 → PRICED。只改狀態，唔郁金額。
UPDATE "CostCase"
SET "status" = 'PRICED'
WHERE "status" = 'PENDING'
  AND "finalCost" IS NOT NULL;
