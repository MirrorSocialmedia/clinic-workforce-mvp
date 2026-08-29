-- providerslot-20260830 T1: ProviderHold 硬保留 + Clinic 可約時段設定
-- MD: whatsapp-flow-booking.md §四（ProviderHold）＋ §六（診所設定 4 欄）

-- Clinic 設定欄（全行有 default，唔 break 現有行）
ALTER TABLE "Clinic" ADD COLUMN "capacityPerProvider" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "Clinic" ADD COLUMN "leadTimeMin" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Clinic" ADD COLUMN "flowWindowDays" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Clinic" ADD COLUMN "holdTimeoutHours" INTEGER NOT NULL DEFAULT 24;

-- ProviderHold（🔴 patientWaId/patientName 係 PII — 只 workforce 內部用）
CREATE TABLE "ProviderHold" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startMin" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL,
    "patientWaId" TEXT NOT NULL,
    "patientName" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "apricotRef" TEXT,
    "flowToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "ProviderHold_pkey" PRIMARY KEY ("id")
);

-- flowToken 冪等鍵（Meta 重試 → 同 hold；NULL 多值容許）
CREATE UNIQUE INDEX "ProviderHold_flowToken_key" ON "ProviderHold"("flowToken");

-- clinic 查詢（held 警報 / 日曆）
CREATE INDEX "ProviderHold_clinicId_date_idx" ON "ProviderHold"("clinicId", "date");

-- ★ 佔位鎖（MD §四）：同一醫生同一日同一 30 分鐘位，active hold 唔可以重覆。
--   Prisma 唔支援 partial index → raw SQL。RELEASED 唔入索引（位已放開）。
CREATE UNIQUE INDEX "provider_hold_slot_active" ON "ProviderHold"("providerId", "date", "startMin")
WHERE "status" IN ('HELD', 'IN_APRICOT');

ALTER TABLE "ProviderHold" ADD CONSTRAINT "ProviderHold_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderHold" ADD CONSTRAINT "ProviderHold_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
