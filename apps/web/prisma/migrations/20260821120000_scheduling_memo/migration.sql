-- 排班頁月備註（純文字，冇任何下游影響）
-- ★ 2026-08-21: 只做記事 —— 唔入計糧／唔入 audit／唔影響任何計算
CREATE TABLE "SchedulingMemo" (
  "id"          TEXT NOT NULL,
  "companyId"   TEXT NOT NULL,
  "periodMonth" TEXT NOT NULL,
  "text"        TEXT NOT NULL,
  "updatedBy"   TEXT NOT NULL,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SchedulingMemo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SchedulingMemo_companyId_periodMonth_key"
  ON "SchedulingMemo"("companyId", "periodMonth");
ALTER TABLE "SchedulingMemo" ADD CONSTRAINT "SchedulingMemo_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
