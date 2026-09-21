-- ★ cwm-consistency Stage 1.8：TimeBankEntry 防雙擊／524 重試雙寫（同 20260917140500 ROSTER_DIFF 同一做法）
-- 部署前先喺 prod 查重複；有結果就先人手處理，否則 CREATE INDEX 會失敗：
--   SELECT "employeeId","date",COUNT(*) FROM "TimeBankEntry" WHERE "type"='RESTDAY_GRANT' GROUP BY 1,2 HAVING COUNT(*)>1;
--   SELECT "employeeId","date",COALESCE("targetType",''),COUNT(*) FROM "TimeBankEntry" WHERE "type"='MAKEUP' GROUP BY 1,2,3 HAVING COUNT(*)>1;
--   SELECT "employeeId","date",COUNT(*) FROM "TimeBankEntry" WHERE "type"='EARLY_IN_OT' GROUP BY 1,2 HAVING COUNT(*)>1;
CREATE UNIQUE INDEX "TimeBankEntry_restdaygrant_once" ON "TimeBankEntry" ("employeeId", "date") WHERE "type" = 'RESTDAY_GRANT';
CREATE UNIQUE INDEX "TimeBankEntry_makeup_once"       ON "TimeBankEntry" ("employeeId", "date", COALESCE("targetType", '')) WHERE "type" = 'MAKEUP';
CREATE UNIQUE INDEX "TimeBankEntry_earlyin_once"      ON "TimeBankEntry" ("employeeId", "date") WHERE "type" = 'EARLY_IN_OT';
