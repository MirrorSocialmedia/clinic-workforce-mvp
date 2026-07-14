-- AlterTable
ALTER TABLE "Company" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "payConfidential" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "QRTokenUsage" ALTER COLUMN "usedAt" SET DATA TYPE TIMESTAMP(3);
