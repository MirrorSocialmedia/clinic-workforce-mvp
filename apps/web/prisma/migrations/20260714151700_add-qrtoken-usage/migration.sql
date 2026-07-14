-- 新增 QRTokenUsage 表：每人對每個 QR 碼各用一次
CREATE TABLE "QRTokenUsage" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
    "tokenId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "usedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QRTokenUsage_pkey" PRIMARY KEY ("id")
);

-- ★ 每人對每碼一次：unique constraint 原子防競態
CREATE UNIQUE INDEX "QRTokenUsage_tokenId_employeeId_key" ON "QRTokenUsage"("tokenId", "employeeId");

-- 外鍵：token 刪除時級聯刪除 usages
ALTER TABLE "QRTokenUsage" ADD CONSTRAINT "QRTokenUsage_tokenId_fkey"
    FOREIGN KEY ("tokenId") REFERENCES "QRToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;
