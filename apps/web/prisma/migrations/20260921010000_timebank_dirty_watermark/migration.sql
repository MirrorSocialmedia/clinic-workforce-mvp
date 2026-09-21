-- ★ cwm-consistency Stage 3：TimeBank 快取「髒水位」—— DB trigger 保證任何輸入改動都會令 cacheKey 失配
--   （唔再靠每條寫入路徑「記得叫」invalidateTimeBankFrom；/api/punch 同 templates 改扣飯都漏過）
CREATE SEQUENCE IF NOT EXISTS "tb_dirty_seq";
CREATE TABLE IF NOT EXISTS "TimeBankDirty" (
  "employeeId" TEXT NOT NULL,
  "ym"         TEXT NOT NULL,            -- 'YYYY-MM'（香港月份）
  "seq"        BIGINT NOT NULL,
  CONSTRAINT "TimeBankDirty_pkey" PRIMARY KEY ("employeeId", "ym")
);

-- ⚠️ 參數唔好叫 emp/ym —— 同欄名撞會 "column reference is ambiguous"（harness 實撞過）
CREATE OR REPLACE FUNCTION tb_mark_dirty(p_emp TEXT, p_ym TEXT) RETURNS void AS $$
BEGIN
  IF p_emp IS NULL OR p_ym IS NULL THEN RETURN; END IF;
  INSERT INTO "TimeBankDirty"("employeeId","ym","seq") VALUES (p_emp, p_ym, nextval('tb_dirty_seq'))
  ON CONFLICT ("employeeId","ym") DO UPDATE SET "seq" = EXCLUDED."seq";
END $$ LANGUAGE plpgsql;

-- timestamp(3) 欄存 UTC（without tz）→ 轉香港月份
CREATE OR REPLACE FUNCTION hk_ym(ts TIMESTAMP) RETURNS TEXT AS $$
  SELECT to_char((ts AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Hong_Kong', 'YYYY-MM')
$$ LANGUAGE sql IMMUTABLE;

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
  ELSIF TG_TABLE_NAME = 'HolidayOtAdjustment' THEN
    IF TG_OP <> 'INSERT' THEN PERFORM tb_mark_dirty(OLD."employeeId", hk_ym(OLD."workDate")); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM tb_mark_dirty(NEW."employeeId", hk_ym(NEW."workDate")); END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER tb_dirty AFTER INSERT                     ON "PunchRecord"         FOR EACH ROW EXECUTE FUNCTION trg_tb_dirty();
CREATE TRIGGER tb_dirty AFTER INSERT OR DELETE           ON "PunchVoid"           FOR EACH ROW EXECUTE FUNCTION trg_tb_dirty();
CREATE TRIGGER tb_dirty AFTER INSERT OR UPDATE OR DELETE ON "PunchCorrection"     FOR EACH ROW EXECUTE FUNCTION trg_tb_dirty();
CREATE TRIGGER tb_dirty AFTER INSERT OR UPDATE OR DELETE ON "LeaveRequest"        FOR EACH ROW EXECUTE FUNCTION trg_tb_dirty();
CREATE TRIGGER tb_dirty AFTER INSERT OR UPDATE OR DELETE ON "Shift"               FOR EACH ROW EXECUTE FUNCTION trg_tb_dirty();
CREATE TRIGGER tb_dirty AFTER INSERT OR UPDATE OR DELETE ON "TimeBankEntry"       FOR EACH ROW EXECUTE FUNCTION trg_tb_dirty();
CREATE TRIGGER tb_dirty AFTER INSERT OR UPDATE OR DELETE ON "HolidayOtAdjustment" FOR EACH ROW EXECUTE FUNCTION trg_tb_dirty();

-- 更次改「扣飯鐘」→ 所有用過佢嘅員工月份變髒（CA-08）
CREATE OR REPLACE FUNCTION trg_tb_dirty_template() RETURNS trigger AS $$
BEGIN
  IF NEW."deductLunch" IS DISTINCT FROM OLD."deductLunch" THEN
    INSERT INTO "TimeBankDirty"("employeeId","ym","seq")
      SELECT DISTINCT s."employeeId", hk_ym(s."date"), nextval('tb_dirty_seq') FROM "Shift" s WHERE s."templateId" = NEW.id
    ON CONFLICT ("employeeId","ym") DO UPDATE SET "seq" = EXCLUDED."seq";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tb_dirty AFTER UPDATE ON "ShiftTemplate" FOR EACH ROW EXECUTE FUNCTION trg_tb_dirty_template();
