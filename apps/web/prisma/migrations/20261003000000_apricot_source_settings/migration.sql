-- ★ cwm-datasource-20261003：資料來源設定（第二期）
-- 純加欄／加表，冇資料遷移：ApricotSource 冇 row = 沿用診所名做顯示名；patientCodePrefix null = 沿用 shortName 推斷。
ALTER TABLE "Clinic" ADD COLUMN "patientCodePrefix" TEXT;

CREATE TABLE "ApricotSource" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "patientCodePattern" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApricotSource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApricotSource_account_key" ON "ApricotSource"("account");
