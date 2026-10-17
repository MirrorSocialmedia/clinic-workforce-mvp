-- ★ cwm-tbmanual-20261017 ①：時間帳戶手動調整 —— 撤銷行指向原本行
ALTER TABLE "TimeBankEntry" ADD COLUMN "reversesEntryId" TEXT;
CREATE UNIQUE INDEX "TimeBankEntry_reversesEntryId_once"
  ON "TimeBankEntry" ("reversesEntryId") WHERE "reversesEntryId" IS NOT NULL;
