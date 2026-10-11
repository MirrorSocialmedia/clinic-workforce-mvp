-- ★ cwm-storedoc-20261011（方案一）：確認核對嗰陣，全店仲有幾多格「店舖營收」未對（未剔／剔完有變）
--   老闆：未剔晒都准確認，但要記低。NULL = 舊紀錄（未有呢個功能）。
ALTER TABLE "DailyRevenueCheck" ADD COLUMN "uncheckedCells" INTEGER;
