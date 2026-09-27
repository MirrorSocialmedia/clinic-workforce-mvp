# Restore Drill 記錄 — 2026-09-27（cwi-final Stage 6 驗收）

- **目的**：Stage 6 驗收項 — backup → restore 入獨立 test DB → row count 對數 → 記錄（施工單 S6 驗收）。
- **執行環境**：本地 dev 機，15532 embedded PostgreSQL 18.4（`apps/web/.dev/pgdata`，embedded-postgres 18.4.0-beta.17），dev DB `clinic_workforce`（18 MB，81 張表）。
- **drill DB**：`clinic_drill_20260927_173636`（獨立 test DB，drill 完已 DROP，零殘留核對通過）。
- **源 DB 全程只讀**（pg_dump 等效讀取 + 只讀 count 查詢），`clinic_workforce` 本體零寫入。

## 1. 生產路徑（唔改，照舊）

| 腳本 | 作用 | 運行位置 |
|---|---|---|
| `scripts/backup.sh` | `docker exec clinic-prod-db pg_dump --format=plain --no-owner --no-acl --clean --if-exists` → row count 驗證 → sha256 → age+rclone offsite（offsite 失敗 exit 1） | 生產機（有 docker + prod DB 容器） |
| `scripts/restore.sh` | checksum 核對 → `RESTORE` 二次確認 → 安全 backup → DROP + recreate 還原 | 生產機 |
| `scripts/restore-drill.sh` | 還原 latest backup 入 temp DB `clinic_drill_<ts>` → 驗證 Employee/PayrollItem 等 row count → drop temp DB | 生產機 |

## 2. 本環境限制（實測，非猜測）

1. **無 docker socket 權限**（docker CLI 在，socket permission denied）→ `docker exec` 路徑行唔到。
2. **機上最新 `pg_dump` = 16.15（Ubuntu 16.15-0ubuntu0.24.04.1），server = PG 18.4** → `pg_dump` 硬錯：`aborting because of server version mismatch`。
3. **無 sudo**（password required）+ PGDG apt repo 未配 → 裝唔到 PG18 client。
4. **embedded-postgres 捆綁 `dblink.so` 壞**：`CREATE EXTENSION dblink` 失敗 — `undefined symbol: PQcancelStart`（libpq 版本錯配）→ cross-DB dblink 路徑唔得。
5. **age / rclone offsite** = 生產機步驟，dev 環境未裝。

→ 依施工單「有 dev 限制 = 記錄限制 + 做本地等效部分」：以下為本地等效 drill。

## 3. 本地等效 drill（實際執行方法）

全部用現成工具（psql 16.15 client — 對 PG 18 server 協議兼容 + 項目自己嘅 prisma CLI），無手造 dumper 邏輯：

1. **Backup artifact**：依 `schema.prisma` model 清單（81 張）逐表 `psql -c '\copy (SELECT * FROM "T") TO STDOUT'`（pg_dump plain format 數據段：`COPY public."T" FROM stdin;` + tab-separated rows + `\.`），gzip。
   - 附件：`<file>.sha256`（self-verify 通過）+ `<file>.rows`（逐表 row count，awk 解檔，同 `backup.sh` 口徑）。
   - **live vs backup 對數**：81/81 張表一致。
2. **Drill DB schema**：`createdb clinic_drill_<ts>` → `prisma migrate deploy`（項目自己嘅 115 個 migrations，正典 schema — 零手造 DDL）。
3. **欄位順序核對**：src vs drill 全部 81 張表 `information_schema.columns` 順序逐字對比（防 COPY 錯位）— 全部一致。
4. **Restore 預備**：`TRUNCATE` drill DB 全部表 + `ALTER TABLE ... DISABLE TRIGGER ALL`。
   - **必要原因（第一次跑實測撞到）**：migrations 會安裝 trigger 機制（e.g. `20260922010000_timebank_dirty_hotfix` 嘅 `trg_tb_dirty` 系列 — 寫 `Shift`/`PunchVoid` 等會自動 upsert `TimeBankDirty`）。COPY restore 行到 `TimeBankEntry`/`PunchVoid` 等表時 trigger 已經喺 drill DB 標咗 `TimeBankDirty` row → 後面 COPY `TimeBankDirty` 第一行即 `duplicate key ... TimeBankDirty_pkey`。
   - 標準 `pg_dump --clean` restore 無呢問題（dump 檔數據段喺 trigger DDL 之前執行），呢個係本等效路徑同 pg_dump 路徑嘅唯一行為差異 — 用 DISABLE TRIGGER 對齊。
5. **Restore**：`gunzip -c <backup> | psql -v ON_ERROR_STOP=1 --quiet`（同 `restore-drill.sh` 口徑），還原後重新 `ENABLE TRIGGER ALL`。
6. **還原後對數**：`.rows`（backup 內 row count）vs drill DB 全表 — **81/81 一致**。
7. **核心表摘要**（同 `restore.sh` 口徑）：`User / Employee / Shift / PunchRecord` = **40 / 30 / 34 / 220**；`max("punchTime")` = **2026-09-22 16:43:18.482**。
8. **Cleanup**：`dropdb` → `pg_database` 核 `clinic_drill_%` 殘留 = **0**。

## 4. 結果（2026-09-27 17:36 HKT）

| 項目 | 結果 |
|---|---|
| backup artifact | `clinic_workforce_20260927_173636.data.sql.gz`（116 KB，81 表數據段），2s |
| sha256 | `6cfafb4413e34f71ba1d3a6edc53bb945f2005b8e2979690328618748923bdc4`（self-verify OK） |
| live vs backup | 81/81 表 row count 一致 |
| schema（migrate deploy） | 115 migrations，1s |
| 欄位順序核對 | 81/81 一致 |
| restore（ON_ERROR_STOP） | 通過，<1s |
| backup vs drill 對數 | **81/81 表一致** |
| 核心表 | User 40 / Employee 30 / Shift 34 / PunchRecord 220 |
| drill DB 殘留 | 0（已 DROP） |
| **結論** | **DRILL PASS** |

## 5. 呢個 drill 證明咩 / 證明唔到咩（誠實口徑）

**證明**：
- backup artifact 完整還原入乾淨 DB（全表 row count 零漂移）；
- 項目 migrations 可以喺乾淨 DB 重現 schema；
- 「artifact → 空 DB → restore → 對數 → cleanup」drill 循環本身可用（未來喺有 PG18 client 嘅環境直接照做）。

**證明唔到**（需要生產環境）：
- `pg_dump` binary 路徑本身（本機無 PG18 client；生產機 `clinic-prod-db` 容器內有同版 pg_dump）；
- age/rclone offsite 步驟（生產機 only）；
- docker 容器路徑（本機無 socket 權限）；
- 生產數據規模下嘅 dump/restore 時間；
- sequence 值唔會同步（本等效路徑無 `setval` 段；drill 用途係 row count 核對，唔係接流量 — 生產 pg_dump 路徑有 setval，無呢問題）。

**跟進**：生產維護視窗喺生產機行 `scripts/restore-drill.sh`（路徑已備好，未改動）。

## 6. 重現

```bash
bash /tmp/cwi-g6-restore-drill2.sh
```

（腳本全文附錄 A。artifacts 喺 `/tmp/cwi-g6-drill/`：`clinic_workforce_20260927_173636.data.sql.gz{,.sha256,.rows}` + `drill_20260927_173636.log`。/tmp 唔入 git，需要時重跑即得。）

## 附錄 A — 腳本全文

```bash
#!/usr/bin/env bash
# cwi-final Stage 6 G6 — backup/restore drill（本地等效版 v2 — psql + prisma，無 pg_dump 18 client 環境）
#
# 生產路徑（唔改）：scripts/backup.sh（docker exec pg_dump）→ scripts/restore-drill.sh（還原入 temp DB）
# 本環境限制（實測記錄）：
#   - 無 docker socket 權限 → docker exec 路徑行唔到
#   - 機上最新 pg_dump = 16.15，server = PG 18.4 → pg_dump server version mismatch（拒行）
#   - 無 sudo → 裝唔到 PG18 client
#   - embedded-postgres 捆綁 dblink.so 壞（undefined symbol: PQcancelStart）
# 本地等效做法（全部用現成工具，無手造邏輯）：
#   backup artifact = pg_dump plain format 數據段（COPY ... FROM stdin，psql \copy 產生）+ sha256 + .rows
#   drill DB schema = 項目自己嘅 prisma migrate deploy（115 個 migration，正典 schema）
#   restore = gunzip | psql -v ON_ERROR_STOP=1（同 restore-drill.sh 口徑）
#   verify = 全表 row count 三向對數（live vs backup vs drill）
#   cleanup = DROP drill DB + 零殘留核
# 禁觸：clinic_workforce 本體（全程只讀）
set -euo pipefail
cd /home/kenneth/.openclaw/workspace/clinic-workforce-mvp

DRILL_DIR=/tmp/cwi-g6-drill
mkdir -p "$DRILL_DIR"
TS=$(date +%Y%m%d_%H%M%S)

DU="$(grep '^DATABASE_URL=postgresql' apps/web/.env.development | head -1 | cut -d= -f2-)"
[ -n "$DU" ] || { echo "FATAL: no 15532 URL"; exit 1; }
CREDPART="${DU#*://}"
CREDPART="${CREDPART%%@*}"
HOSTPORT="${DU##*@}"
export PGPASSWORD="${CREDPART#*:}"
export PGHOST="${HOSTPORT%%:*}"
export PGPORT="${HOSTPORT#*:}"
export PGPORT="${PGPORT%%/*}"
export PGUSER="${CREDPART%%:*}"

SRC_DB=clinic_workforce
BACKUP_RAW="${DRILL_DIR}/${SRC_DB}_${TS}.data.sql"
BACKUP="${BACKUP_RAW}.gz"
DRILL_DB="clinic_drill_${TS}"
DRILL_URL="${DU%/*}/${DRILL_DB}"
OUT="${DRILL_DIR}/drill_${TS}.log"

log() { echo "$@" | tee -a "$OUT"; }
TABLES=$(grep -oP '^model \K\w+' apps/web/prisma/schema.prisma | tr '\n' ' ')
log "📋 tables from schema: $(echo $TABLES | wc -w) | src db: ${SRC_DB} @ ${PGHOST}:${PGPORT}"

log "═══ STEP 1: backup artifact（pg_dump plain 數據段，psql \\copy 逐表）═══"
t0=$(date +%s)
{
  echo "-- logical backup (data section, pg_dump plain format compatible)"
  echo "-- source: ${SRC_DB} @ ${PGHOST}:${PGPORT}  at $(date '+%F %T %Z')"
  echo "-- schema DDL: 由 prisma migrate deploy 提供（本環境無 pg_dump 18 client — 見 docs/drills/restore-drill-2026-09-27.md）"
} > "$BACKUP_RAW"
SKIPPED=""
for TBL in $TABLES; do
  EXISTS=$(psql -X -d "$SRC_DB" -tAc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='${TBL}' AND c.relkind='r';")
  if [ "$EXISTS" != "1" ]; then SKIPPED="${SKIPPED} ${TBL}"; continue; fi
  {
    echo "COPY public.\"${TBL}\" FROM stdin;"
    psql -X -q -d "$SRC_DB" -c "\copy (SELECT * FROM \"${TBL}\") TO STDOUT"
    echo "\."
  } >> "$BACKUP_RAW"
done
gzip -c "$BACKUP_RAW" > "$BACKUP"
rm -f "$BACKUP_RAW"
log "✅ backup: ${BACKUP} ($(du -h "$BACKUP" | cut -f1), $(( $(date +%s) - t0 ))s) [skipped non-existent: ${SKIPPED:-none}]"
sha256sum "$BACKUP" > "${BACKUP}.sha256"
log "✅ sha256: $(cut -c1-24 "${BACKUP}.sha256")…"
sha256sum -c "${BACKUP}.sha256" --quiet && log "✅ checksum self-verify OK"

log "═══ STEP 2: backup 內容驗證（.rows + live 對數，同 backup.sh 口徑）═══"
gunzip -c "$BACKUP" | awk '
BEGIN { inblk = 0 }
inblk == 0 && index($0, "COPY public.\"") == 1 {
 s = substr($0, 14); q = index(s, "\"")
 if (q > 1) { tbl = substr(s, 1, q - 1); inblk = 1; n[tbl] = 0 }
 next
}
inblk == 1 && $0 == "\\." { inblk = 0; next }
inblk == 1 { n[tbl]++ }
END { for (t in n) printf "%s=%s\n", t, n[t] }
' > "${BACKUP}.rows"
VERIFY_FAIL=0
while read -r TBL; do
  LIVE_N=$(psql -X -d "$SRC_DB" -tAc "SELECT count(*) FROM \"${TBL}\";" 2>/dev/null || echo "SKIP")
  BK_N=$(awk -F= -v t="$TBL" '$1 == t { print $2; found = 1 } END { if (!found) print 0 }' "${BACKUP}.rows")
  if [ "$LIVE_N" = "SKIP" ]; then continue; fi
  if [ "${BK_N:-0}" != "$LIVE_N" ]; then
    log "  ❌ ${TBL}: live=${LIVE_N} backup=${BK_N:-0} 唔一致"
    VERIFY_FAIL=1
  fi
done <<< "$(echo $TABLES)"
[ "$VERIFY_FAIL" = 0 ] && log "✅ 全表 live vs backup row count 一致" || { log "❌ backup 驗證失敗"; exit 1; }

log "═══ STEP 3: drill DB schema（prisma migrate deploy — 項目自己嘅 115 migrations）═══"
createdb "$DRILL_DB"
t0=$(date +%s)
( cd apps/web && DATABASE_URL="${DRILL_URL}" npx prisma migrate deploy --schema prisma/schema.prisma ) >> "$OUT" 2>&1 || { log "❌ prisma migrate deploy 失敗"; dropdb "$DRILL_DB" || true; exit 1; }
log "✅ schema 部署完成（$(( $(date +%s) - t0 ))s）"

log "═══ STEP 3b: 欄位順序核對（src vs drill，防 COPY 錯位）═══"
ORDER_FAIL=0
for TBL in $TABLES; do
  SRC_COLS=$(psql -X -d "$SRC_DB" -tA -c "SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='${TBL}'")
  DRILL_COLS=$(psql -X -d "$DRILL_DB" -tA -c "SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='${TBL}'")
  if [ -z "$SRC_COLS" ]; then continue; fi
  if [ "$SRC_COLS" != "$DRILL_COLS" ]; then
    log "  ❌ ${TBL} 欄位順序/集唔一致：src=[$SRC_COLS] drill=[$DRILL_COLS]"
    ORDER_FAIL=1
  fi
done
[ "$ORDER_FAIL" = 0 ] && log "✅ 欄位順序全部一致" || { log "❌ 欄位核對失敗"; dropdb "$DRILL_DB" || true; exit 1; }

log "═══ STEP 3c: 預備 restore（TRUNCATE + DISABLE TRIGGER — migrations 帶 trigger/seed 機制，確保 restore 係唯一數據來源）═══"
TRUNCATE_LIST=""
for TBL in $TABLES; do
  E=$(psql -X -d "$DRILL_DB" -tAc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='${TBL}' AND c.relkind='r';")
  [ "$E" = "1" ] && TRUNCATE_LIST="${TRUNCATE_LIST}\"${TBL}\","
done
TRUNCATE_LIST="${TRUNCATE_LIST%,}"
[ -n "$TRUNCATE_LIST" ] && psql -X -q -d "$DRILL_DB" -c "TRUNCATE ${TRUNCATE_LIST} CASCADE"
for TBL in $TABLES; do
  psql -X -q -d "$DRILL_DB" -c "ALTER TABLE \"${TBL}\" DISABLE TRIGGER ALL;" 2>/dev/null || true
done
log "✅ drill DB 已 TRUNCATE + 全部 trigger 停用"

log "═══ STEP 4: restore（gunzip | psql -v ON_ERROR_STOP=1，同 restore-drill.sh 口徑）═══"
t0=$(date +%s)
if ! gunzip -c "$BACKUP" | psql -X -d "$DRILL_DB" -v ON_ERROR_STOP=1 --quiet 2> "${DRILL_DIR}/restore_err_${TS}.log"; then
  log "❌ 還原失敗"; tail -20 "${DRILL_DIR}/restore_err_${TS}.log"
  dropdb "$DRILL_DB" || true
  exit 1
fi
log "✅ 還原完成（$(( $(date +%s) - t0 ))s）"
for TBL in $TABLES; do
  psql -X -q -d "$DRILL_DB" -c "ALTER TABLE \"${TBL}\" ENABLE TRIGGER ALL;" 2>/dev/null || true
done
log "✅ trigger 已重新啟用"

log "═══ STEP 5: 還原後對數（.rows vs drill，同 restore.sh 口徑）═══"
MISMATCH=0; CHECKED=0
while IFS='=' read -r TBL EXPECTED; do
  [ -z "$TBL" ] && continue
  case "${EXPECTED}" in ''|*[!0-9]*) continue ;; esac
  ACTUAL=$(psql -X -d "$DRILL_DB" -tAc "SELECT count(*) FROM \"${TBL}\";" 2>/dev/null || echo "ERR")
  CHECKED=$((CHECKED + 1))
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    log "  ❌ ${TBL}: backup=${EXPECTED} → drill=${ACTUAL}"
    MISMATCH=1
  fi
done < "${BACKUP}.rows"
[ "$MISMATCH" = 0 ] && log "✅ ${CHECKED} 張表 row count 全部一致" || { log "❌ 還原不完整"; exit 1; }

log "═══ STEP 6: 核心表摘要（同 restore.sh 核心表口徑）═══"
psql -X -d "$DRILL_DB" -tA -c 'SELECT
 (SELECT count(*) FROM "User"),
 (SELECT count(*) FROM "Employee"),
 (SELECT count(*) FROM "Shift"),
 (SELECT count(*) FROM "PunchRecord");' | tr '\n' ' ' | tee -a "$OUT"; echo "" >> "$OUT"
psql -X -d "$DRILL_DB" -tA -c 'SELECT max("punchTime")::text FROM "PunchRecord";' | tee -a "$OUT"

log "═══ STEP 7: cleanup（DROP drill DB + 零殘留核）═══"
dropdb "$DRILL_DB"
LEFT=$(psql -X -d "$SRC_DB" -tAc "SELECT count(*) FROM pg_database WHERE datname LIKE 'clinic_drill_%';")
[ "$LEFT" = "0" ] && log "✅ drill DB 已清（clinic_drill_% 殘留 = 0）" || { log "❌ 殘留 ${LEFT}"; exit 1; }

log "🎉 DRILL PASS — backup artifact → schema → restore → 對數 → cleanup 全綠"
log "artifacts: ${BACKUP} / ${BACKUP}.sha256 / ${BACKUP}.rows / ${OUT}"
```
