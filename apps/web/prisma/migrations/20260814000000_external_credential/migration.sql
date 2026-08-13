-- ExternalCredential: encrypted 3rd-party API tokens

CREATE TABLE "ExternalCredential" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "cipherText" TEXT NOT NULL,
    "refreshExpiry" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "lastError" TEXT,
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "rotationCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalCredential_provider_key" ON "ExternalCredential"("provider");
