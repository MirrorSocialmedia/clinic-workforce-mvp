-- AB2: Add reportCharges and chargesVsPaid to ReconciliationImport
ALTER TABLE "ReconciliationImport" ADD COLUMN "reportCharges" DECIMAL(12,2);
ALTER TABLE "ReconciliationImport" ADD COLUMN "chargesVsPaid" DECIMAL(12,2);
