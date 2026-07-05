-- Append-only triggers: Prevent UPDATE and DELETE on audit-critical tables

CREATE OR REPLACE FUNCTION prevent_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'This table is append-only: % not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

-- PunchRecord: append-only
CREATE TRIGGER no_mutate_punch
  BEFORE UPDATE OR DELETE ON "PunchRecord"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- AuditLog: append-only
CREATE TRIGGER no_mutate_audit
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- DailyHash: append-only
CREATE TRIGGER no_mutate_hash
  BEFORE UPDATE OR DELETE ON "DailyHash"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
