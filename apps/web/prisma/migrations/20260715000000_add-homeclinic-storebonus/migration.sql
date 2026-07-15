-- AlterTable: Employee add homeClinicId
ALTER TABLE "Employee" ADD COLUMN     "homeClinicId" TEXT;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_homeClinicId_fkey" 
    FOREIGN KEY ("homeClinicId") REFERENCES "Clinic"("id") ON DELETE SET NULL ON UPDATE CASCADE;
