-- ★ 2026-08-04：生日假獨立 LeaveType
INSERT INTO "LeaveType" (id, name, "systemKey", "isPaid", "annualQuota", color, "isActive")
VALUES (gen_random_uuid()::text, '生日假', 'BIRTHDAY_LEAVE', true, 0, '#D4537E', true)
ON CONFLICT ("systemKey") DO NOTHING;
