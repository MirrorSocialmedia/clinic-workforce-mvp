-- ★ cw-extapi-20260823-a1: External API v1 框架（MD §A.1）
-- ExternalApiKey（sha256 hash 存 key，明文只 print 一次）+ ExternalApiAudit（零 PII metadata）。
-- SQL 由 prisma migrate diff 產生（schema slice），同 prisma migrate dev 輸出一致。

-- CreateTable
CREATE TABLE "ExternalApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalApiAudit" (
    "id" TEXT NOT NULL,
    "keyName" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalApiAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalApiKey_name_key" ON "ExternalApiKey"("name");

-- CreateIndex
CREATE INDEX "ExternalApiAudit_keyName_createdAt_idx" ON "ExternalApiAudit"("keyName", "createdAt");
