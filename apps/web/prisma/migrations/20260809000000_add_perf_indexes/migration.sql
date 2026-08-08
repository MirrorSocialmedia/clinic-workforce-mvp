-- Performance indexes for query hotspots
-- PunchRecord: clinic-scoped + time-only queries
CREATE INDEX "PunchRecord_clinicId_punchTime" ON "PunchRecord"("clinicId", "punchTime");
CREATE INDEX "PunchRecord_punchTime" ON "PunchRecord"("punchTime");

-- LeaveRequest: date-range + employee-date queries
CREATE INDEX "LeaveRequest_startDate_endDate" ON "LeaveRequest"("startDate", "endDate");
CREATE INDEX "LeaveRequest_employeeId_startDate" ON "LeaveRequest"("employeeId", "startDate");

-- PunchCorrection: status + correctedTime queries
CREATE INDEX "PunchCorrection_status_correctedTime" ON "PunchCorrection"("status", "correctedTime");

-- PayRule: active rule lookup per employee
CREATE INDEX "PayRule_employeeId_isActive_effectiveFrom" ON "PayRule"("employeeId", "isActive", "effectiveFrom");
