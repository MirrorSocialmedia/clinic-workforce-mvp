-- 2026-10-11 修：成本錄入人手改價會錯誤剔上 labInvoiceLinked（見 api/cost-cases/[id] PUT）。
-- 清返冇任何 MATCHED Lab invoice 行嘅成本；有配對嘅照留 true。
-- 只改標記，唔郁金額（月度折扣要重算，請喺「Lab 月度折扣」頁人手按重算）。
UPDATE "CostCase" c
SET "labInvoiceLinked" = false
WHERE c."labInvoiceLinked" = true
  AND NOT EXISTS (
    SELECT 1 FROM "LabDocumentLine" l
    WHERE l."costCaseId" = c."id" AND l."status" = 'MATCHED'
  );
