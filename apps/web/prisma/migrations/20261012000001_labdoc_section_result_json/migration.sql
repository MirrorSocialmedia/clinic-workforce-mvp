-- P3-3a: §8.2.5 虛擬結果／反向數據要存「section 結果 JSON」— §3.1 原 schema 冇呢欄，補上
ALTER TABLE "LabStatementSection" ADD COLUMN "resultJson" JSONB;
