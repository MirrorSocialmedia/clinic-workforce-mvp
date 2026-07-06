-- FIX #3: Partial unique index for clinicId=NULL on PayrollRun
-- PostgreSQL NULL != NULL, so @@unique([clinicId, periodMonth]) doesn't block
-- two (NULL, '2026-07') rows. This partial index fills the gap.
CREATE UNIQUE INDEX payroll_run_all_clinics
  ON "PayrollRun" ("periodMonth") WHERE "clinicId" IS NULL;
