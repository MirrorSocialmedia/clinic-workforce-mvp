-- ★ cw-extapi-20260823-a1: Availability slot grid（MD §B.1）
-- external API /v1/availability 數據源。🔴 零病人資料（書寫前經 sanitize 白名單 assert）。
-- SQL 由 prisma migrate diff 產生（schema slice），同 prisma migrate dev 輸出一致。

-- CreateTable
CREATE TABLE "AvailabilityCache" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "providerApricotId" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "isOpen" BOOLEAN NOT NULL,
    "bookedCount" INTEGER NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AvailabilityCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AvailabilityCache_clinicId_date_idx" ON "AvailabilityCache"("clinicId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AvailabilityCache_clinicId_providerApricotId_date_startTime_key" ON "AvailabilityCache"("clinicId", "providerApricotId", "date", "startTime");
