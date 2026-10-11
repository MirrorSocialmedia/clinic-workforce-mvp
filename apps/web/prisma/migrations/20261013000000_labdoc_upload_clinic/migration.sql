-- KIOSK（店舖機）上傳 Lab 單據：記低上傳店，讀單以呢間店為準
ALTER TABLE "LabDocument" ADD COLUMN "uploadClinicId" TEXT;
