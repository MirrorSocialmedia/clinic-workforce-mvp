-- ★ 2026-08-25 拍板①：重做狀態（REDO）— 改原本嗰筆，唔開新 row
-- status 係 String 唔係 Prisma enum，加 'REDO' 值唔使 migration
ALTER TABLE "CostCase" ADD COLUMN "redoAt" TIMESTAMP(3);
ALTER TABLE "CostCase" ADD COLUMN "redoReason" TEXT;
