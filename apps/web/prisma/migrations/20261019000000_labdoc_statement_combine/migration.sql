-- 2026-10-12：同 Lab＋診所＋醫生＋月兩份月結單「加埋一齊對」— 後上傳嗰段指去前一段
ALTER TABLE "LabStatementSection" ADD COLUMN "combineWithSectionId" TEXT;
CREATE INDEX "LabStatementSection_combineWithSectionId_idx" ON "LabStatementSection"("combineWithSectionId");
