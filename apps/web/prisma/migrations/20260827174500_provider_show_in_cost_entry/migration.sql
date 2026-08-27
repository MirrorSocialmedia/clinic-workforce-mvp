-- ★ cwm-costentry-20260827 §1：Provider.showInCostEntry — 成本錄入下拉隱藏開關
-- NOT NULL DEFAULT true：現有醫生全部自動 = true；
-- PG 11+ ADD COLUMN ... NOT NULL DEFAULT 係 metadata-only（唔 rewrites 表）→ 零鎖表。
ALTER TABLE "Provider" ADD COLUMN "showInCostEntry" BOOLEAN NOT NULL DEFAULT true;
