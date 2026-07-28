-- ============================================================================
-- cleanup-sick-balance.sql
-- 清理誤建的病假 LeaveBalance row（B-06③）
-- 病假不應有餘額 row，成本由 computeSickDeduction 喺計糧端結算
-- ============================================================================

-- 1. 先查看有冇誤建的病假餘額 row
SELECT lb.id, e.id AS emp, lb.entitled, lb.remaining
FROM "LeaveBalance" lb
JOIN "LeaveType" lt ON lt.id = lb."leaveTypeId"
JOIN "Employee" e ON e.id = lb."employeeId"
WHERE lt."systemKey" = 'SICK';

-- 2. 確認之後執行刪除（⚠️ 先跑 ./backup.sh 備份！）
-- DELETE FROM "LeaveBalance"
-- WHERE "leaveTypeId" IN (SELECT id FROM "LeaveType" WHERE "systemKey" = 'SICK');
