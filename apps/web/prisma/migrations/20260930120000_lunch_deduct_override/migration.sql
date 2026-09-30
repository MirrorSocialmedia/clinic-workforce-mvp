-- CreateTable
CREATE TABLE "LunchDeductOverride" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "lunchMinutes" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LunchDeductOverride_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LunchDeductOverride_employeeId_workDate_idx" ON "LunchDeductOverride"("employeeId", "workDate");
CREATE UNIQUE INDEX "LunchDeductOverride_employeeId_workDate_key" ON "LunchDeductOverride"("employeeId", "workDate");
ALTER TABLE "LunchDeductOverride" ADD CONSTRAINT "LunchDeductOverride_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ★ TimeBankDirty 水位：同 HolidayOtAdjustment 一樣要觸發（見 20260921010000_timebank_dirty_watermark）
--   2026-09-30 實測對過 15532 現行 trg_tb_dirty（含 LeaveRequest／Shift 行內註解），以現行為底只改：
--   ELSIF TG_TABLE_NAME IN ('HolidayOtAdjustment', 'LunchDeductOverride')
CREATE OR REPLACE FUNCTION trg_tb_dirty() RETURNS trigger AS $$
DECLARE r RECORD;
BEGIN
  IF TG_TABLE_NAME = 'PunchRecord' THEN
    PERFORM tb_mark_dirty(NEW."employeeId", hk_ym(NEW."punchTime"));
  ELSIF TG_TABLE_NAME = 'PunchVoid' THEN
    SELECT "employeeId", "punchTime" INTO r FROM "PunchRecord" WHERE id = COALESCE(NEW."punchRecordId", OLD."punchRecordId");
    PERFORM tb_mark_dirty(r."employeeId", hk_ym(r."punchTime"));
  ELSIF TG_TABLE_NAME = 'PunchCorrection' THEN
    IF TG_OP <> 'INSERT' THEN PERFORM tb_mark_dirty(OLD."employeeId", hk_ym(OLD."correctedTime")); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM tb_mark_dirty(NEW."employeeId", hk_ym(NEW."correctedTime")); END IF;
  ELSIF TG_TABLE_NAME = 'LeaveRequest' THEN          -- startDate 係 UTC 午夜 = 香港日期本身
    IF TG_OP <> 'INSERT' THEN PERFORM tb_mark_dirty(OLD."employeeId", to_char(OLD."startDate", 'YYYY-MM')); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM tb_mark_dirty(NEW."employeeId", to_char(NEW."startDate", 'YYYY-MM')); END IF;
  ELSIF TG_TABLE_NAME = 'Shift' THEN                 -- Shift.date 係香港午夜（UTC 前一日 16:00）
    IF TG_OP <> 'INSERT' THEN PERFORM tb_mark_dirty(OLD."employeeId", hk_ym(OLD."date")); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM tb_mark_dirty(NEW."employeeId", hk_ym(NEW."date")); END IF;
  ELSIF TG_TABLE_NAME = 'TimeBankEntry' THEN
    IF TG_OP <> 'INSERT' THEN PERFORM tb_mark_dirty(OLD."employeeId", hk_ym(OLD."date")); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM tb_mark_dirty(NEW."employeeId", hk_ym(NEW."date")); END IF;
  ELSIF TG_TABLE_NAME IN ('HolidayOtAdjustment', 'LunchDeductOverride') THEN
    IF TG_OP <> 'INSERT' THEN PERFORM tb_mark_dirty(OLD."employeeId", hk_ym(OLD."workDate")); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM tb_mark_dirty(NEW."employeeId", hk_ym(NEW."workDate")); END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER tb_dirty AFTER INSERT OR UPDATE OR DELETE ON "LunchDeductOverride" FOR EACH ROW EXECUTE FUNCTION trg_tb_dirty();
