-- cwi-final S5-3②: BookingWriteLog.requestHash（payload fingerprint — 同 key 重放 hash 核對）
-- cwi-final S5-5: Clinic.shortName partial unique（防新增重複簡稱；
--   Prisma schema 唔支援 WHERE 子句 → raw SQL。DB 已核：無重複才落呢行 — 見施工單）
--   ⚠️ 呢個 index 唔喺 schema.prisma（Prisma 限制）— 由 migration 管住，shadow DB replay 一致，唔算 drift。

-- cwi-qa FX-18 (QA-18): 重複 shortName fail-fast 守門。
-- production 有重複 → migrate 步即刻失敗（唔會半途炸喺 CREATE UNIQUE INDEX），
-- 錯誤訊息列明邊個 shortName 重複 → 先改名再 re-deploy。
-- production 實查（2026-09-28，老細確認）：0 行 — 6 間店 shortName 全唯一
-- （TY=青衣 / TW=大圍 / TKW=土瓜環 / YL=元朗 / MF=美孚 / YMT=油麻地）。
DO $$
DECLARE
  _dup_names text;
BEGIN
  SELECT string_agg(d."shortName", ', ' ORDER BY d."shortName")
  INTO _dup_names
  FROM (
    SELECT "shortName", count(*)
    FROM "Clinic"
    WHERE "shortName" IS NOT NULL
    GROUP BY "shortName"
    HAVING count(*) > 1
  ) d;
  IF _dup_names IS NOT NULL THEN
    RAISE EXCEPTION '重複 shortName: %', _dup_names;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "BookingWriteLog" ADD COLUMN "requestHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Clinic_shortName_unique" ON "Clinic"("shortName") WHERE "shortName" IS NOT NULL;
