-- cwm-recon-clinic-20260909 S5 (E 章)：ReconciliationImport 同一 provider+clinic+month 覆蓋
-- MD E 章：@@unique([providerId, clinicId, periodMonth]) + upload 改 upsert
-- 注意：clinicId nullable → Postgres NULL 唔等於 NULL，舊 NULL 記錄唔受保護（生產預清見 progress s5）
-- dev 15532 上載前已確認 0 行重覆（GROUP BY HAVING count(*)>1 = 0 行）
CREATE UNIQUE INDEX "ReconciliationImport_providerId_clinicId_periodMonth_key" ON "ReconciliationImport"("providerId", "clinicId", "periodMonth");
