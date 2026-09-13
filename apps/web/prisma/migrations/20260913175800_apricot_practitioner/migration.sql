-- cwm-apricotacct-20260913 Stage 1 · Migration 1
-- ★ 只准 CREATE：新表 ApricotPractitioner + enum + 索引 + FK。
-- ★ 零 DROP、零 ALTER TABLE "Provider"（Provider.apricotId 本段唔郁）。
-- 生成方式：prisma migrate diff --from-migrations --to-schema-datamodel --script
-- （surgical 抽取 — diff 內既有 drift 修正語句已核實 dev DB 早已處於 datamodel 狀態，不納入本 migration）

-- CreateEnum
CREATE TYPE "ApricotAccountKind" AS ENUM ('PROVIDER', 'CLINIC', 'UNKNOWN');
-- CreateTable
CREATE TABLE "ApricotPractitioner" (
    "id" TEXT NOT NULL,
    "apricotId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ApricotAccountKind" NOT NULL,
    "providerId" TEXT,
    "clinicId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ApricotPractitioner_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "ApricotPractitioner_apricotId_key" ON "ApricotPractitioner"("apricotId");
-- CreateIndex
CREATE INDEX "ApricotPractitioner_kind_idx" ON "ApricotPractitioner"("kind");
-- CreateIndex
CREATE INDEX "ApricotPractitioner_providerId_idx" ON "ApricotPractitioner"("providerId");
-- AddForeignKey
ALTER TABLE "ApricotPractitioner" ADD CONSTRAINT "ApricotPractitioner_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ApricotPractitioner" ADD CONSTRAINT "ApricotPractitioner_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE SET NULL ON UPDATE CASCADE;
