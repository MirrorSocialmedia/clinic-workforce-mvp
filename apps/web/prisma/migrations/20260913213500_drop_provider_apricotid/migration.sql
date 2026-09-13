-- AlterTable
ALTER TABLE "ApricotBill" ADD COLUMN "providerName" TEXT;

-- AlterTable
ALTER TABLE "Provider" DROP COLUMN "apricotId";
