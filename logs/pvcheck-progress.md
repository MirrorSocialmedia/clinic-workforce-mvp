# cwm-pvcheck-20261007 progress

trace_id: pvcheck-20261007-2 ｜ Kairo: muxv9d37wgbqc（s1–s4 CTO，s5/s6 reviewer）
分支：`cwm-pvcheck/20261007` @ base `b7f92c99`（dailyv2 tip，chain mode）
工單：`/home/kenneth/.openclaw/workspace/logs/pvcheck-workorder.md`

## gen2（2026-10-07 21:1x 開工）

### 環境核實
- worktree `/home/kenneth/.openclaw/workspace/cwm-pvcheck` 淨（git status 空）@ `b7f92c99`
- DB `cwm_pvcheck`@127.0.0.1:15532 可达；104 models；**空庫**（Clinic/Provider/Employee/PayoutRun/User 全部 count=0）
- dev server 3010 活著（/login 200）；log /tmp/openclaw-cwm3010.log
- `.env.local` DATABASE_URL = `postgresql://cw_dev:***@127.0.0.1:15532/cwm_pvcheck?schema=public`（有雙引號，prisma 命令前要 `grep -oP 'DATABASE_URL="\K[^"]*'` 攞出）
- seed 參照：`prisma/seed-dailyv2-dev-20261007.mjs`（2 店 TW/TW2、2 provider 謝德輝/何嘉俊、PaymentAllocation DIRECT、bcrypt 帳號）

### 錨點重校（base b7f92c99 vs MD 嘅 b672663）✅ 全部核完
| 錨點 | 現況 @ b7f92c99 |
|---|---|
| `daily/page.tsx` deep-link block | 行 ~88-95（MD 說 63-66）：`useEffect` 讀 `?from=&to=&clinicId=`，`deepLinked.current = true` 只喺 `if (c)` 分支內；**未讀 providerId**（B 要加） |
| `daily/page.tsx` 其他 | KIOSK 收窄（kioskLockedClinicId/activeClinicId/isKiosk）、② sync、④ cellChecks 全部喺；providerId state 已存在（line ~75） |
| `payout/page.tsx` DailyReviewRow render | **行 559**（MD 說 ~559 ✅ 吻合）：props = `review, clinicId, month, clinicLabel, onRecompute, busy`；**未傳 providerId/providerLabel/onChecked** |
| `payout/page.tsx` state | `providers: {id,name,apricotId?}[]`（line 62）；`previewData` any（line 86）；`handlePreview` line 271（POST /api/payout-runs/preview → setPreviewData(res)）；`dailyAck` line 94；底部剔格 = `previewData.dailyReview?.needsAck`（行 ~631） |
| `daily-review.ts` exports | `DailyReviewDay`、`DailyReview`（days/doctorTotal/counts{checked,changed,unchecked}/needsAck）、`monthDays`、`mergeDailyReview`（純函數）、`dailyReview`（async，import loadDailyReport+loadCheckStates → **server only**）。client 只准 `import type` |
| `DailyReviewRow.tsx` 現行 props | `{ review, clinicId, clinicLabel, month, onRecompute, busy }`；`onlyOpen` filter = `status ∈ {CHANGED,UNCHECKED}`；`href` 已有 clinicId+from+to（**無 providerId**）；行 = grid 4 欄（日期/醫生收款/全店收款/護士核對狀態文字）；**無核對掣、無行內表** |
| `hk-date.ts` | **零 prisma import**（grep 確認）；`todayHK()` line 16 ✅ 可直接 import |
| check API（`/api/payout-runs/daily/check`） | GET `?clinicId=&from=&to=` → `{ days: DayCheckState[], nurses: from===to?[{employeeId,name,onShift}]:null, canCheck }`；POST `{clinicId,date,nurseEmployeeId,expectedAmount}` → `{ok,id}`（**無 nurseName/checkedAt** → 本地更新用 client 現在時）；409 文案：「數字啱啱變咗（而家 $X，畫面 $Y），請重新整理再核對」／「呢日已經核對咗，唔使再核對」／「呢日啱啱已經有人核對咗，請重新整理」（P2002/P2025 併入同一句）；400：「呢位員工唔屬於呢間店，請重新揀」 |
| `DailyCheckPanel.tsx` | 單日 form 字眼：「核對護士」select（optgroup 當日返工/其他員工）、剔格「已核對：系統收款 **$total** 同 Apricot 日結／收銀一致」、button「確認核對/重新核對」、disabled = `busy || !nurseId || !ticked || !canCheck` — A2 行內表照呢套字眼 |
| `nurseOptions`（daily-check.ts） | 依 Employee（homeClinic/clinics + joinDate ≤ 當日）；Shift 只影響排序 → **seed 有 Employee 就有 nurse 名單**（唔使 seed Shift） |
| 測試 | `pnpm test` = `tsx --test 'src/**/*.test.ts'`（本地全收，新檔自動入）；ci.yml 用明確清單 — **要手動加** `src/lib/payout/daily-review-local.test.ts`（daily-review.test.ts 喺清單行 ~166 之後） |

### 計劃（按序，每綠 commit+push）
1. ✅ progress 檔（呢段）+ commit
2. ✅ seed：`prisma/seed-pvcheck-dev-20261007.mjs` — 跑通 + live 驗證（preview API：8 UNCHECKED + 1 NONE；check API GET/POST/409/revoke 全通）
3. ✅ A：DailyReviewRow 核對掣 + 行內表 + 409 + justChecked filter（tsc=0 / lint:hooks=0）
4. ✅ A4：`src/lib/payout/daily-review-local.ts` applyLocalCheck（純函數、import type only、tsc=0）
5. ✅ B：providerId/providerLabel props + href + daily/page.tsx 讀 providerId（tsc=0 / lint:hooks=0）
6. ✅ C：`daily-review-local.test.ts`（5/5 pass）+ ci.yml 清單
7. ✅ gates 全綠（見下）
8. ✅ D 區 7 項 curl 實測全過（見下）；DB 已還原 fresh seed 狀態

### 進度日誌
- 21:1x gen2 收工單；環境核活（DB 空庫、3010 活、worktree 淨 @ b7f92c99）
- 21:1x 錨點重校完成（上表）；progress 檔 commit
- 21:3x seed 綠：TW 09-02~08 $7,000/日、09-09 $1,000、09-10 NONE；10-01~06 有數、10-08/09 未來；ProviderCommission 40%（preview 必需）；OWNER/KIOSK/EMPLOYEE 帳號 login 通；check API 200/409/400/revoke 實測 OK（09-08 smoke 後已 revoke，8 日全返 UNCHECKED）
- 21:5x A4 綠：applyLocalCheck 純函數（CHECKED 套用 + counts/needsAck 重計 + immutability + 缺日期原樣返回）；tsc --noEmit=0
- 22:1x A 綠：DailyReviewRow 就地核對（UN/CHANGED 掣、未來日無掣、單行展開、逐日 GET nurses、409 雙分支、400 重取名單、applyLocalCheck+onChecked 局部更新、justChecked 篩選保留行）；payout/page.tsx 接 onChecked；tsc=0、lint:hooks=0
- 22:3x B 綠：DailyReviewRow href 加 providerId、掣文字「去每日大數核對 → 謝德輝 · TW · 9 月（新分頁）→」；payout/page.tsx 傳 selectedProvider+name；daily/page.tsx deep-link 加讀 providerId（deepLinked 現有行為保留）；tsc=0、lint:hooks=0
- 22:5x C 綠：daily-review-local.test.ts 5 項（UNCHECKED→CHECKED / CHANGED→CHECKED / 最後一日 needsAck=false / 缺日期原樣 / immutability）；ci.yml 測試清單已加；payout 五個 sibling test 檔 17/17 綠

### gates（repo root + apps/web）
- `npx tsc --noEmit` = 0
- `pnpm lint:hooks` = 0
- `bash scripts/run-guards.sh`（repo root）= ✅ 全部守門通過（exit 0；假期檢查連唔到 DB 自動 skip）
- `pnpm test`（全量 1067 tests）：新檔 daily-review-local 5/5 pass；37 fail 全部係已知環境依賴（apricot sync-availability×3 / backfill-appointments / payroll-snapshot-asof-write / payroll-run-snapshot-route / payroll-engine.hourly-eowage「HKPublicHoliday 空+冇 DATABASE_URL」/ external staff-id contract）— 同我 diff 零 import 交集，CI 走 curated subset 唔收呢啲檔
- ci.yml 測試清單已加 `src/lib/payout/daily-review-local.test.ts`

### D 區 7 項實測（3010 live，OWNER 95000000/owner-pv-2026，curl+cookie）
1. ✅ 09-07 核對：preview UNCHECKED（counts unchecked=8、needsAck=true）；GET /check 單日返 nurses=[TW 護士陳]（逐日）+ canCheck=true；細表/掣 disabled 邏輯喺碼（`!nurseId || !ticked || canCheck===false`）
2. ✅ 確認後：POST 200 → 再 preview：unchecked 8→7、09-07 CHECKED（TW 護士陳 · checkedAt · $7,000）= 頂部 pill（✓ 1 日已核對）+ 底部「N 日未核對」即時更新（onChecked → setPreviewData spread，needsAck 未變 true）
3. ✅ 每日大數 09-07：同一筆記錄 — check id 相同（cmuy5m1ov…9l0j9）、同護士、同金額 $7,000；daily report totals.storeTotal=$7,000
4. ✅ 人手加 09-07 Cash $500 → preview：09-07 CHANGED（核對時 $7,000／而家 $7,500）；stale POST（7000）→ 409「數字啱啱變咗（而家 $7500，畫面 $7000）」；recheck POST（7500）→ 200 新記錄；AuditLog：「每日大數核對：2026-09-07 · 護士 TW 護士陳 · $7500（重新核對，之前 $7000）」；舊記錄 revoked（reason：核對後數字有變，重新核對）
5. ✅ 兩 tab 同時 POST 09-09：tabA 200 / tabB 409「呢日啱啱已經有人核對咗，請重新整理」；DB 只 1 條 active（409 分支碼：提示「其他人已核對」+ onRecompute()）
6. ✅ 其餘 6 日全核對 → counts {checked:8, changed:0, unchecked:0}、**needsAck=false**（底部「我知道…」剔格消失、「確認並鎖定」解禁 — UI 靠 needsAck）
7. ✅ deep link：`/payout/daily?clinicId=TW&providerId=謝德輝&from=2026-09-01&to=2026-09-30` → page 200 + 底層 query mode=byDay（謝德輝 09 逐日表）；daily/page.tsx 已讀 providerId（deepLinked 行為保留）
- 附加 A1：2026-10 預視 — 10-01~06 UNCHECKED（有掣）、10-08/09 UNCHECKED（未來日無掣：`date > todayHK()`）；server 兜底 POST 10-08 → 400「未到嘅日子唔可以核對」
- 附加 A6：KIOSK login 通；KIOSK@TW canCheck=true、KIOSK@HC canCheck=false（→ 唔出【核對】掣）
- ⚠ 實測後 DB 已還原 fresh seed 狀態（delete 10 checks + D4 extra payment）：2026-09 = 8 UNCHECKED + 1 NONE，reviewer 可直接重跑 D 區

### 完成總結
- 5 commits：f0b533f4 progress / b64a5701 seed / 1068bcc2 A4 / b60a6bcd A / d1528b87 B / ed1ca416 C（共 6 個連 progress）
- 範圍守住：無 DB migration、無新 route、client 零 prisma（daily-review 只 import type、applyLocalCheck 新檔）
- 備註：MD B4「可選加強」（每日大數逐日表 date link tooltip）唔做 — MD 明寫可選、D 區唔驗
