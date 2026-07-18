-- Add companyId to ShiftTemplate
ALTER TABLE "ShiftTemplate" ADD COLUMN "companyId" TEXT;
ALTER TABLE "ShiftTemplate" ADD CONSTRAINT "ShiftTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ShiftTemplate_companyId" ON "ShiftTemplate"("companyId");
