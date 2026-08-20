-- ★ cw-pa P1: Apricot 醫生時間表兩張表（零 PII）
-- ⚠️ 手動縮細咗：prisma migrate dev 自動 fold 入 4 項 pre-existing schema-history
--    drift（ApricotBillItem_feeItemDes_idx / ProviderReferral_..._key / Lab 欄型 /
--    ProviderReferral.qty default / PaymentAllocation index rename）。
--    呢啲係歷史 migration 同現有 schema 嘅 divergence（唔屬 P1 範圍），
--    若跟住自動 fold，生產 deploy 時可能撞 DB 狀態 → 只保留本 PR 需要嘅 DDL。
--    Drift 清單已報 CEO（Kairo note），日後單獨 cleanup。

-- CreateTable
CREATE TABLE "ProviderAvailability" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderBooking" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startMin" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL,
    "status" INTEGER NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderAvailability_clinicId_date_idx" ON "ProviderAvailability"("clinicId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderAvailability_clinicId_providerId_date_startTime_key" ON "ProviderAvailability"("clinicId", "providerId", "date", "startTime");

-- CreateIndex
CREATE INDEX "ProviderBooking_clinicId_date_idx" ON "ProviderBooking"("clinicId", "date");

-- CreateIndex
CREATE INDEX "ProviderBooking_providerId_date_idx" ON "ProviderBooking"("providerId", "date");

-- AddForeignKey
ALTER TABLE "ProviderAvailability" ADD CONSTRAINT "ProviderAvailability_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderAvailability" ADD CONSTRAINT "ProviderAvailability_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderBooking" ADD CONSTRAINT "ProviderBooking_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderBooking" ADD CONSTRAINT "ProviderBooking_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
