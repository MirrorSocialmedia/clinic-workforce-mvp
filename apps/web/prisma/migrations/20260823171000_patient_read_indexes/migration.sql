-- ★ cwc-rdchain-20260823-a1: Patient Read 鏈 Round A — 兩張索引表（read-chain MD §2）
-- SQL 形狀同 prisma migrate dev 輸出一致（參照 20260823034100_availability_cache）。
-- 白名單 v2：visitReasons String[] / remarks String?；phoneNum 只准 HMAC hash（phoneHash）。
-- AppointmentIndex 唔剷歷史行（治療摘要來源）；PatientIndex = 病人電話 hash 索引（wa-inbox 對照）。

-- CreateTable
CREATE TABLE "AppointmentIndex" (
    "id" TEXT NOT NULL,
    "apricotApptId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "providerApricotId" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "bookingStatus" INTEGER NOT NULL,
    "patientApricotId" TEXT NOT NULL,
    "patientCode" TEXT NOT NULL,
    "patientName" TEXT NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "visitReasons" TEXT[] NOT NULL,
    "remarks" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentIndex_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientIndex" (
    "id" TEXT NOT NULL,
    "patientApricotId" TEXT NOT NULL,
    "patientCode" TEXT NOT NULL,
    "patientName" TEXT NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientIndex_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppointmentIndex_phoneHash_idx" ON "AppointmentIndex"("phoneHash");

-- CreateIndex
CREATE INDEX "AppointmentIndex_patientApricotId_date_idx" ON "AppointmentIndex"("patientApricotId", "date");

-- CreateIndex
CREATE INDEX "AppointmentIndex_clinicId_date_idx" ON "AppointmentIndex"("clinicId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentIndex_apricotApptId_key" ON "AppointmentIndex"("apricotApptId");

-- CreateIndex
CREATE INDEX "PatientIndex_phoneHash_idx" ON "PatientIndex"("phoneHash");

-- CreateIndex
CREATE UNIQUE INDEX "PatientIndex_patientApricotId_key" ON "PatientIndex"("patientApricotId");
