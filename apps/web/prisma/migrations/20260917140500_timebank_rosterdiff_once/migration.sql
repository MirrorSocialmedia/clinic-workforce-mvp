-- cwm-money P2-1：每人每月最多一筆 ROSTER_DIFF（雙擊／524 重試雙寫兜底）
-- 建前已核 dev 15532 無重複行（GROUP BY HAVING 回 0 行）。
CREATE UNIQUE INDEX "TimeBankEntry_rosterdiff_once" ON "TimeBankEntry" ("employeeId", "date") WHERE "type" = 'ROSTER_DIFF';
