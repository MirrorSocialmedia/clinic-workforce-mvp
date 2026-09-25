-- cwi-final S5-3②: BookingWriteLog.requestHash（payload fingerprint — 同 key 重放 hash 核對）
-- cwi-final S5-5: Clinic.shortName partial unique（防新增重複簡稱；
--   Prisma schema 唔支援 WHERE 子句 → raw SQL。DB 已核：無重複才落呢行 — 見施工單）
--   ⚠️ 呢個 index 唔喺 schema.prisma（Prisma 限制）— 由 migration 管住，shadow DB replay 一致，唔算 drift。

-- AlterTable
ALTER TABLE "BookingWriteLog" ADD COLUMN "requestHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Clinic_shortName_unique" ON "Clinic"("shortName") WHERE "shortName" IS NOT NULL;
