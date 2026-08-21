-- PL 標記：員工自請休息日（純顯示，零下游影響）
-- ★ 純 ALTER ADD COLUMN DEFAULT false —— 現有 row 全部 false，零回歸
ALTER TABLE "LeaveRequest"
  ADD COLUMN "isEmployeeRequested" BOOLEAN NOT NULL DEFAULT false;
