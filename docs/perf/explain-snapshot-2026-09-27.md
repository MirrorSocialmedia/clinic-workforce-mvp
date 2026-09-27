# EXPLAIN 快照 — 2026-09-27（cwi-final Stage 6 驗收）

- **目的**：Stage 6 驗收項 — 熱查 EXPLAIN 快照入 `docs/perf/`（薪資計算 / 出勤查詢 / bookable-slots claim）。
- **方法**：`EXPLAIN (ANALYZE, BUFFERS)`，15532 dev PG 18.4，`clinic_workforce`。全部純 SELECT，read-only，零副作用。
- **快照時間**：2026-09-27 17:18 HKT。
- **快照時數據規模（dev，僅供解讀 plan 用）**：PunchRecord 220 行 / Shift 34 行 / Employee 30 人 / LeaveRequest 33 行 / AvailabilityCache 0 行 / ProviderHold 0 行 / ProviderBooking 0 行 / ProviderAvailability 0 行。

## 熱查來源

| # | 查 | 代碼位置 |
|---|---|---|
| Q1 | 員工當月 punch（void 過濾 + punchTime 排序） | `apps/web/src/lib/payroll-engine.ts:296` |
| Q2 | 員工當月排更（非 CANCELLED） | `apps/web/src/lib/payroll-engine.ts:591` |
| Q3 | REST_DAY APPROVED 假單 interval overlap（LeaveType join） | `apps/web/src/lib/payroll-engine.ts:606` |
| Q4a–e | bookable-slots claim 交易內 slot 重算（5 並發查）+ flowToken 冪等查 | `apps/web/src/lib/bookable-slots-service.ts:468`（`claimInTx`）、`:541`（`claimSlot`） |
| Q5 | AvailabilityCache 單日 grid（clinic+date） | `apps/web/src/lib/bookable-slots-service.ts`（grid 讀） |

## Q1 — 薪資計算：員工當月 punch

```sql
SELECT pr.id, pr."punchTime"
FROM "PunchRecord" pr
LEFT JOIN "PunchVoid" pv ON pv."punchRecordId" = pr.id
WHERE pr."employeeId" = 'cmtn52yow000m3e5o0ezw9c18'
  AND pr."punchTime" >= '2026-09-01T00:00:00+08' AND pr."punchTime" <= '2026-09-30T23:59:59.999+08'
  AND pv.id IS NULL
ORDER BY pr."punchTime" ASC
```

```
Sort  (cost=11.22..11.22 rows=1 width=34) (actual time=0.400..0.401 rows=0.00 loops=1)
  Sort Key: pr."punchTime"
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=9 read=1
  ->  Hash Right Join  (cost=8.25..11.21 rows=1 width=34) (actual time=0.383..0.384 rows=0.00 loops=1)
        Hash Cond: (pv."punchRecordId" = pr.id)
        Filter: (pv.id IS NULL)
        Rows Removed by Filter: 8
        ->  Seq Scan on "PunchVoid" pv  (cost=0.00..2.76 rows=76 width=52) (actual time=0.331..0.334 rows=72.00 loops=1)
        ->  Hash  (cost=8.24..8.24 rows=1 width=34) (actual time=0.032..0.033 rows=8.00 loops=1)
              ->  Seq Scan on "PunchRecord" pr  (cost=0.00..8.24 rows=1 width=34) (actual time=0.012..0.029 rows=8.00 loops=1)
                    Filter: (("punchTime" >= ...) AND ("punchTime" <= ...) AND ("employeeId" = ...))
                    Rows Removed by Filter: 212
Planning Time: 3.995 ms
Execution Time: 0.431 ms
```

**解讀**：dev 規模（220 行）planner 揀 Seq Scan 合理；`PunchRecord_employeeId_punchTime_idx` 已存在 — 生產數據大咗（單員工當月 punch 行數過千）planner 會自行轉 index scan，**無需新增索引**。void 過濾走 LEFT JOIN + IS NULL（Hash Right Join）— 正確。

## Q2 — 薪資計算：員工當月排更

```sql
SELECT date FROM "Shift"
WHERE "employeeId" = 'cmtn52yoz000z3e5o2jc0hpp8'
  AND date >= '2026-09-01T00:00:00+08' AND date <= '2026-09-30T23:59:59.999+08'
  AND status <> 'CANCELLED'
```

```
Seq Scan on "Shift"  (cost=0.00..2.68 rows=1 width=8) (actual time=0.010..0.010 rows=0.00 loops=1)
  Filter: ((date >= ...) AND (date <= ...) AND (status <> 'CANCELLED'::"ShiftStatus") AND ("employeeId" = ...))
  Rows Removed by Filter: 34
Planning Time: 0.551 ms
Execution Time: 0.024 ms
```

**解讀**：dev 34 行 → Seq Scan 合理。`Shift_employeeId_date_idx` 已存在（生產規模會轉用）。注意：`status <> 'CANCELLED'` 喺 enum 上 — 冇 status 選擇性問題（值少）。

## Q3 — 薪資計算：REST_DAY APPROVED 假單 interval overlap

```sql
SELECT lr."startDate", lr."endDate"
FROM "LeaveRequest" lr
JOIN "LeaveType" lt ON lt.id = lr."leaveTypeId"
WHERE lr."employeeId" = 'cmtn52you000i3e5oxfjjt2o9'
  AND lr.status = 'APPROVED'
  AND lt."systemKey" = 'REST_DAY'
  AND lr."startDate" <= '2026-09-30T23:59:59.999+08' AND lr."endDate" >= '2026-09-01T00:00:00+08'
```

```
Nested Loop  (cost=0.15..10.84 rows=1 width=16) (actual time=0.013..0.014 rows=0.00 loops=1)
  Join Filter: (lr."leaveTypeId" = lt.id)
  ->  Seq Scan on "LeaveRequest" lr  (cost=0.00..2.66 rows=1 width=42) (actual time=0.013..0.013 rows=0.00 loops=1)
        Filter: ((startDate <= ...) AND (endDate >= ...) AND (employeeId = ...) AND (status = 'APPROVED'))
        Rows Removed by Filter: 33
  ->  Index Scan using "LeaveType_systemKey_key" on "LeaveType" lt  (cost=0.15..8.17 rows=1 width=32) (never executed)
        Index Cond: ("systemKey" = 'REST_DAY'::text)
Planning Time: 5.217 ms
Execution Time: 0.034 ms
```

**解讀**：`LeaveType_systemKey_key` unique index 正確命中（REST_DAY 類目查）。interval overlap 用 `startDate <= end AND endDate >= start`（標準，唔存在 range 型別 — 如未來 LeaveRequest 量大，可考評 `tsrange`/GiST，**現階段唔需要**）。

## Q4a–e — bookable-slots claim（交易內重算 + 冪等）

claim 鐵律：單一交易內重算 offerable（唔信任 client 中間狀態）。交易內 5 條並發查 + 1 條冪等查：

### Q4a — 當日出勤時段（providerAvailability）

```sql
SELECT "startTime", "endTime" FROM "ProviderAvailability"
WHERE "clinicId" = '...' AND "providerId" = '...' AND date = '2026-09-26'
```

```
Index Scan using "ProviderAvailability_clinicId_providerId_date_startTime_key"  (cost=0.15..8.17 rows=1 width=64) (actual time=0.026..0.026 rows=0.00 loops=1)
  Index Cond: (("clinicId" = ...) AND ("providerId" = ...) AND (date = '2026-09-26'))
Execution Time: 0.042 ms
```

✅ unique index `(clinicId, providerId, date, startTime)` 前三欄完整命中。

### Q4b — active bookings（status IN 0/1/102）

```sql
SELECT "startMin", "endMin" FROM "ProviderBooking"
WHERE "clinicId" = '...' AND "providerId" = '...' AND date = '2026-09-26'
  AND status IN (0, 1, 102)
```

```
Index Scan using "ProviderBooking_providerId_date_idx"  (cost=0.15..8.17 rows=1 width=8) (actual time=0.026..0.027 rows=0.00 loops=1)
  Index Cond: (("providerId" = ...) AND (date = '2026-09-26'))
  Filter: (("clinicId" = ...) AND (status = ANY ('{0,1,102}')))
Execution Time: 0.039 ms
```

✅ `(providerId, date)` index 命中，clinicId+status 做 filter（同 provider 同日 booking 行數少，合理）。

### Q4c — active holds（HELD/IN_APRICOT）

```sql
SELECT "startMin", "endMin" FROM "ProviderHold"
WHERE "clinicId" = '...' AND "providerId" = '...' AND date = '2026-09-26'
  AND status IN ('HELD', 'IN_APRICOT')
```

```
Index Scan using provider_hold_slot_active  (cost=0.12..8.15 rows=1 width=8) (actual time=0.006..0.007 rows=0.00 loops=1)
  Index Cond: (("providerId" = ...) AND (date = '2026-09-26'))
  Filter: ("clinicId" = ...)
Execution Time: 0.025 ms
```

✅ **partial unique index** `provider_hold_slot_active = (providerId, date, startMin) WHERE status IN ('HELD','IN_APRICOT')` 命中 — 呢個 index 同時係 S5-4 兩階段 claim 嘅 race 兜底（P2002 → 409）：讀取快 + 並發唯一性保證，一 index 兩用。

### Q4d — AvailabilityCache grid（isOpen，多帳號 in-list）

```sql
SELECT "startTime", "endTime", "bookedCount" FROM "AvailabilityCache"
WHERE "clinicId" = '...' AND "providerApricotId" IN ('APR-HO') AND date = '2026-09-26'
  AND "isOpen" = true
```

```
Index Scan using "AvailabilityCache_clinicId_providerApricotId_date_startTime_key"  (cost=0.15..8.17 rows=1 width=68) (actual time=0.003..0.003 rows=0.00 loops=1)
  Index Cond: (("clinicId" = ...) AND ("providerApricotId" = 'APR-HO') AND (date = '2026-09-26'))
  Filter: "isOpen"
Execution Time: 0.019 ms
```

✅ unique index 前三欄命中（`IN` 單一值 = equality；多帳號時每個值各跑一次 index scan — 單醫生帳號數少，合理）。

### Q4e — claim 冪等：flowToken 唯一查

```sql
SELECT id, date, "startMin" FROM "ProviderHold" WHERE "flowToken" = 't694-drill-flow-token'
```

```
Index Scan using "ProviderHold_flowToken_key"  (cost=0.14..8.16 rows=1 width=68) (actual time=0.005..0.005 rows=0.00 loops=1)
  Index Cond: ("flowToken" = 't694-drill-flow-token')
Execution Time: 0.019 ms
```

✅ `flowToken` unique index 直達（Meta 重試冪等路徑）。

## Q5 — AvailabilityCache 單日 grid（clinic+date）

```sql
SELECT "providerApricotId", "startTime", "endTime", "isOpen", "bookedCount"
FROM "AvailabilityCache"
WHERE "clinicId" = '...' AND date = '2026-09-26'
ORDER BY "providerApricotId", "startTime"
```

```
Index Scan using "AvailabilityCache_clinicId_providerApricotId_date_startTime_key"  (cost=0.15..8.18 rows=1 width=101) (actual time=0.008..0.009 rows=0.00 loops=1)
  Index Cond: (("clinicId" = ...) AND (date = '2026-09-26'))
Execution Time: 0.024 ms
```

✅ 用 unique key 嘅 `(clinicId, ..., date)` 前綴（planner 揀咗 unique key 而非 `AvailabilityCache_clinicId_date_idx` — 兩者都可用；前綴匹配 `(clinicId, date)` 需要跳過中間欄，planner 估 unique key 行數估計更準）。單日 grid 行數 = 該 clinic 該日開診時段數（十至幾十行），index scan 合理。

## 索引清單（快照日相關表）

```
PunchRecord
  "PunchRecord_pkey" PRIMARY KEY, btree (id)
  "PunchRecord_clinicId_punchTime_idx" btree (clinicId, punchTime)
  "PunchRecord_employeeId_punchTime_idx" btree (employeeId, punchTime)
  "PunchRecord_punchTime_idx" btree (punchTime)

Shift
  "Shift_pkey" PRIMARY KEY, btree (id)
  "Shift_clinicId_date_idx" btree (clinicId, date)
  "Shift_employeeId_clinicId_startTime_key" UNIQUE, btree (employeeId, clinicId, startTime)
  "Shift_employeeId_date_idx" btree (employeeId, date)
  "Shift_employeeId_startTime_idx" btree (employeeId, startTime)
  "Shift_secondaryClinicId_idx" btree (secondaryClinicId)
  "Shift_status_idx" btree (status)
  CHECK shift_date_start_same_hk_day: (date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Hong_Kong' 同 HK 日 = (startTime ...) HK 日

LeaveRequest
  "LeaveRequest_pkey" PRIMARY KEY, btree (id)
  "LeaveRequest_clinicId_idx" btree (clinicId)
  "LeaveRequest_employeeId_startDate_idx" btree (employeeId, startDate)
  "LeaveRequest_employeeId_status_idx" btree (employeeId, status)
  "LeaveRequest_leaveTypeId_idx" btree (leaveTypeId)
  "LeaveRequest_startDate_endDate_idx" btree (startDate, endDate)

ProviderAvailability
  "ProviderAvailability_pkey" PRIMARY KEY, btree (id)
  "ProviderAvailability_clinicId_date_idx" btree (clinicId, date)
  "ProviderAvailability_clinicId_providerId_date_startTime_key" UNIQUE, btree (clinicId, providerId, date, startTime)

ProviderBooking
  "ProviderBooking_pkey" PRIMARY KEY, btree (id)
  "ProviderBooking_clinicId_date_idx" btree (clinicId, date)
  "ProviderBooking_providerId_date_idx" btree (providerId, date)

ProviderHold
  "ProviderHold_pkey" PRIMARY KEY, btree (id)
  "ProviderHold_clinicId_date_idx" btree (clinicId, date)
  "ProviderHold_flowToken_key" UNIQUE, btree (flowToken)
  "provider_hold_slot_active" UNIQUE, btree (providerId, date, startMin) WHERE status IN ('HELD','IN_APRICOT')

AvailabilityCache
  "AvailabilityCache_pkey" PRIMARY KEY, btree (id)
  "AvailabilityCache_clinicId_date_idx" btree (clinicId, date)
  "AvailabilityCache_clinicId_providerApricotId_date_startTime_key" UNIQUE, btree (clinicId, providerApricotId, date, startTime)

PunchVoid
  "PunchVoid_pkey" PRIMARY KEY, btree (id)
  "PunchVoid_punchRecordId_key" UNIQUE, btree (punchRecordId)
  trigger: tb_dirty AFTER INSERT OR DELETE → trg_tb_dirty()
```

## 總結

1. **claim 路徑（Q4a–e）全數 index-covered**，包括 partial unique index 同時擔 race 兜底 — 現階段**無 performance 風險、無新索引需求**。
2. **薪資計算（Q1–Q3）喺 dev 規模全部 sub-millisecond**；planner 喺小表揀 Seq Scan 係正確行為，所需 index（`(employeeId, punchTime)` / `(employeeId, date)` / `LeaveType_systemKey_key`）**全部已存在** — 生產規模放大時會自然轉 index path。
3. **本快照係 baseline**：絕對時間唔可同生產比（dev 220 punches vs 生產數月累積）；未來性能調查以「plan shape 有冇變（index → seq scan 退化 / join 策略變）」為準，用同一組 SQL 喺生產（維護視窗，read-only）重拍一次即得。
