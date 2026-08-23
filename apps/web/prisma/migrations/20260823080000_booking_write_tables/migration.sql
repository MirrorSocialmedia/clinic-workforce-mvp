-- ★ cw-apricotwrite-20260823-a1: Apricot 寫入功能兩表（MD v2.0 §2）
-- 老總已簽兩 checkbox（白名單 v2 + 自動化寫入同意）；flags 默認 off（APRICOT_WRITE=0）。
-- SQL 形狀同 prisma migrate dev 輸出一致（參照 20260823034100_availability_cache）。

-- CreateTable
CREATE TABLE "ApricotDictionary" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "apricotId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "des" TEXT NOT NULL,
    "isRemoved" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApricotDictionary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingWriteLog" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "apricotApptId" TEXT,
    "status" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingWriteLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApricotDictionary_kind_isRemoved_idx" ON "ApricotDictionary"("kind", "isRemoved");

-- CreateIndex
CREATE UNIQUE INDEX "ApricotDictionary_apricotId_key" ON "ApricotDictionary"("apricotId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingWriteLog_idempotencyKey_key" ON "BookingWriteLog"("idempotencyKey");
