-- 2026-10-11：月結單行「計入下個月」結轉 — 下個月分段入面嘅副本指返上個月嗰行
ALTER TABLE "LabStatementLine" ADD COLUMN "carriedFromLineId" TEXT;
ALTER TABLE "LabStatementLine" ADD COLUMN "carriedFromMonth" TEXT;
CREATE UNIQUE INDEX "LabStatementLine_sectionId_carriedFromLineId_key" ON "LabStatementLine"("sectionId", "carriedFromLineId");
CREATE INDEX "LabStatementLine_carriedFromLineId_idx" ON "LabStatementLine"("carriedFromLineId");
