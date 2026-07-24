-- PayRule: partial unique index to enforce at most one active rule per employee
-- ⚠️ 需先清理 DB 髒資料（同一 employeeId 不可有多筆 isActive=true）才能 apply
-- 指揮大神需執行清理後再 apply 此 migration
CREATE UNIQUE INDEX payrule_one_active_per_employee
  ON "PayRule" ("employeeId")
  WHERE "isActive" = true;
