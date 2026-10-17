-- ★ cwi-patient-identify-20261017：AppointmentIndex 多號 E.164 hash（新預約未有到診記錄都配到）
ALTER TABLE "AppointmentIndex" ADD COLUMN "phoneHashes" TEXT[] DEFAULT ARRAY[]::TEXT[];
