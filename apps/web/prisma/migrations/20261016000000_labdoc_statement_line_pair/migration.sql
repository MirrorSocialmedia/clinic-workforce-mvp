-- 2026-10-11：月結單行人手配對成本（MANUAL）／「未配對到」唔再自動劃（NONE）
ALTER TABLE "LabStatementLine" ADD COLUMN "pairMode" TEXT;
ALTER TABLE "LabStatementLine" ADD COLUMN "pairCostCaseId" TEXT;
