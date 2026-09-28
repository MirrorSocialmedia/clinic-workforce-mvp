-- cwi-qa FX-17 (QA-17): BookingWriteLog 加 updatedAt（stale IN_PROGRESS 判斷改用佢）。
-- 舊口徑用 createdAt：舊 ERROR:* 行被重用做 IN_PROGRESS 後，createdAt 仲係幾分鐘/幾小時前
-- → 並發請求即刻被判 stale → 假 MANUAL_RECONCILE（502）。
-- 既有行 backfill = now()（DEFAULT 只供 backfill，跟住 DROP — 之後 Prisma @updatedAt 係唯一寫入口）。
ALTER TABLE "BookingWriteLog" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now();
ALTER TABLE "BookingWriteLog" ALTER COLUMN "updatedAt" DROP DEFAULT;
