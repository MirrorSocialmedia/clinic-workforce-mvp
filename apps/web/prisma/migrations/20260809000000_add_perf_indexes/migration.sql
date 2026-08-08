-- Performance indexes for query hotspots
-- PunchRecord: clinic-scoped + time-only queries
CREATE INDEX IF NOT EXISTS "PunchRecord_clinicId_punchTime_idx" ON "PunchRecord"("clinicId", "punchTime");
CREATE INDEX IF NOT EXISTS "PunchRecord_punchTime_idx" ON "PunchRecord"("punchTime");

-- LeaveRequest: date-range + employee-date queries
CREATE INDEX IF NOT EXISTS "LeaveRequest_startDate_endDate_idx" ON "LeaveRequest"("startDate", "endDate");
CREATE INDEX IF NOT EXISTS "LeaveRequest_employeeId_startDate_idx" ON "LeaveRequest"("employeeId", "startDate");

-- PunchCorrection: status + correctedTime queries
CREATE INDEX IF NOT EXISTS "PunchCorrection_status_correctedTime_idx" ON "PunchCorrection"("status", "correctedTime");

-- PayRule: active rule lookup per employee
CREATE INDEX IF NOT EXISTS "PayRule_employeeId_isActive_effectiveFrom_idx" ON "PayRule"("employeeId", "isActive", "effectiveFrom");

-- Update table statistics after index creation
ANALYZE "PunchRecord";
ANALYZE "LeaveRequest";
ANALYZE "PunchCorrection";
ANALYZE "PayRule";
