/*
  Warnings:

  - A unique constraint covering the columns `[systemKey]` on the table `LeaveType` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "LeaveType" ADD COLUMN     "systemKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "LeaveType_systemKey_key" ON "LeaveType"("systemKey");
