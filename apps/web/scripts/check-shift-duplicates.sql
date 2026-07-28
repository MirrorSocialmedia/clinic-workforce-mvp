-- 睇有冇現存重複（同一員工、同日、同一店、同一開工時間）
-- ⚠️ 如果上面有結果，手動決定保留邊張，刪走重複嘅先，先 migrate。
SELECT "employeeId", "clinicId", "startTime", count(*), array_agg(id)
FROM "Shift" WHERE status <> 'CANCELLED'
GROUP BY 1,2,3 HAVING count(*) > 1;

-- 如果上面有結果，手動決定保留邊張，刪走重複嘅。
-- 例如：DELETE FROM "Shift" WHERE id IN ('重複嘅id1', '重複嘅id2');
