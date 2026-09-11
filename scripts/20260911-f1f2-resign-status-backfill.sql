-- ============================================================================
-- cwm-resignflow-20260911 · F1+F2 一次性補數據（生產版 · idempotent）
--
-- 執行時機：老總 deploy cwm-resignflow-20260911 之後，對生產 DB 跑一次。
--   psql "$PROD_DATABASE_URL" -f scripts/20260911-f1f2-resign-status-backfill.sql
--
-- 背景：舊「標記離職」只寫 Employee.status + leaveDate（標記當日），
--   冇寫 User.status（離職員工仍然登入得到）+ 冇寫 resignedAt。
--   F1 補 User.status；F2 兜底「已結算但未標記離職」的人。
--
-- ★ 全部 idempotent — 重跑零副作用（UPDATE 條件自帶 <> 'RESIGNED' 守衛）。
-- ============================================================================

-- ── F1 · Kelly 等已標記離職員工嘅 User.status ─────────────────────────────
BEGIN;

-- 先睇實（預期：Kelly，user_status=ACTIVE，emp_status=RESIGNED）
SELECT u.id, u.name, u.role,
       u.status  AS user_status,
       e.status  AS emp_status,
       e."leaveDate"::date  AS leaveDate,
       e."resignedAt"::date AS resignedAt
FROM "Employee" e
JOIN "User" u ON u.id = e."userId"
WHERE e.status = 'RESIGNED';

-- 補 User.status（預期回 UPDATE 1 = Kelly；已補過再跑 = UPDATE 0）
UPDATE "User" u SET status = 'RESIGNED'
FROM "Employee" e
WHERE e."userId" = u.id
  AND e.status = 'RESIGNED'
  AND u.status <> 'RESIGNED';

-- 核（預期全部 user_status=RESIGNED）
SELECT u.name, u.status AS user_status
FROM "User" u
JOIN "Employee" e ON e."userId" = u.id
WHERE e.status = 'RESIGNED';

COMMIT;

-- ----------------------------------------------------------------------------
-- ⚠️ Kelly 真實最後工作日（老總才知道）— 而家 leaveDate 係「標記當日」，
--    resignedAt 係 NULL。確認日期之後解開註解跑（唔跑都唔阻其他功能，
--    但「最後 X」顯示會用錯日）：
--
-- BEGIN;
-- UPDATE "Employee"
-- SET "leaveDate"  = TIMESTAMP '2026-0X-XX 00:00:00+08',  -- ← 最後工作日（HK 00:00）
--     "resignedAt" = TIMESTAMP '2026-0X-XX 00:00:00+08'   -- ← 最後工作日 + 1（生效日，語義寫死）
-- WHERE id = '<Kelly 的 employeeId>';  -- 用上面 F1 SELECT 嘅 e.id
-- COMMIT;
-- ----------------------------------------------------------------------------

-- ── F2 · 已結算但未標記離職（預期零行；老總講之前多數結算唔到 / 撞 409）────
-- 舊 JSON 位（resignflow 之前嘅結算寄生喺 PayrollItem）：
SELECT u.name,
       pr."periodMonth"::date AS period,
       e.status AS emp_status,
       us.status AS user_status,
       pi."resignSettlementJson"::jsonb ->> 'lastDay' AS lastDay
FROM "PayrollItem" pi
JOIN "PayrollRun" pr ON pr.id = pi."runId"
JOIN "Employee" e  ON e.id = pi."employeeId"
JOIN "User" us     ON us.id = e."userId"
LEFT JOIN "User" u ON u.id = e."userId"
WHERE pi."resignSettlementJson" IS NOT NULL
  AND e.status <> 'RESIGNED'
ORDER BY pr."periodMonth" DESC;

-- 新表位（resignflow 之後嘅結算；呢單 deploy 後先會有新結算入呢度，
-- 正常唔應該出現「已結算但未標記」— 結算本身就同步標記）：
SELECT u.name,
       rs."periodMonth",
       e.status AS emp_status,
       us.status AS user_status,
       rs."lastDay"::date AS lastDay
FROM "ResignSettlement" rs
JOIN "Employee" e  ON e.id = rs."employeeId"
JOIN "User" us     ON us.id = e."userId"
LEFT JOIN "User" u ON u.id = e."userId"
WHERE e.status <> 'RESIGNED'
ORDER BY rs."periodMonth" DESC;

-- ★ 有行就逐個補 F1 嗰組欄（lastDay 用上面查返嚟嘅值）：
--
-- BEGIN;
-- UPDATE "Employee"
-- SET "status"     = 'RESIGNED',
--     "leaveDate"  = TIMESTAMP '<lastDay 00:00:00+08>',
--     "resignedAt" = TIMESTAMP '<lastDay+1 00:00:00+08>'
-- WHERE id = '<employeeId>';
-- UPDATE "User" SET status = 'RESIGNED'
-- WHERE id = '<userId>' AND status <> 'RESIGNED';
-- COMMIT;
--
-- ────────────────────────────────────────────────────────────────────────────
-- 生死格（跑完 F1 後核一次，預期零行）：
-- SELECT u.name, e.status AS emp, u.status AS user_status
-- FROM "Employee" e JOIN "User" u ON u.id = e."userId"
-- WHERE (e.status = 'RESIGNED') <> (u.status = 'RESIGNED');
-- ============================================================================
