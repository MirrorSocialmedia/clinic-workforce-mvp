-- PunchRecord:事實欄不可變、註腳欄可寫;DELETE 一律禁止
-- (AuditLog / DailyHash 維持原 prevent_mutation 全封鎖,不動)

CREATE OR REPLACE FUNCTION punch_facts_guard() RETURNS trigger AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'PunchRecord is append-only: DELETE not allowed';
 END IF;
 IF NEW."id" IS DISTINCT FROM OLD."id"
 OR NEW."employeeId" IS DISTINCT FROM OLD."employeeId"
 OR NEW."clinicId" IS DISTINCT FROM OLD."clinicId"
 OR NEW."punchTime" IS DISTINCT FROM OLD."punchTime"
 OR NEW."punchType" IS DISTINCT FROM OLD."punchType"
 OR NEW."source" IS DISTINCT FROM OLD."source"
 OR NEW."tokenValid" IS DISTINCT FROM OLD."tokenValid"
 OR NEW."deviceInfo" IS DISTINCT FROM OLD."deviceInfo"
 OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
 THEN
  RAISE EXCEPTION 'PunchRecord facts are append-only: UPDATE to fact columns not allowed';
 END IF;
 RETURN NEW; -- 只動註腳欄(face* 六欄、notes)→ 放行
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS no_mutate_punch ON "PunchRecord";
CREATE TRIGGER no_mutate_punch
 BEFORE UPDATE OR DELETE ON "PunchRecord"
 FOR EACH ROW EXECUTE FUNCTION punch_facts_guard();
