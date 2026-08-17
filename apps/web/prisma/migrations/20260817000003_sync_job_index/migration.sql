-- Prisma migration: sync_job_index
-- ApricotSyncJob: change index [status] to [status, startedAt]

DROP INDEX IF EXISTS "ApricotSyncJob_status_idx";
CREATE INDEX "ApricotSyncJob_status_startedAt_idx" ON "ApricotSyncJob"("status", "startedAt");
