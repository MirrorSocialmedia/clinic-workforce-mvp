-- Add KIOSK to UserRole enum
ALTER TYPE "UserRole" ADD VALUE 'KIOSK';

-- Add tokenVersion and ipAllowlist to User
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "ipAllowlist" TEXT;
