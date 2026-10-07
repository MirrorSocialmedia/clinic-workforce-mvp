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

## hotfix1（2026-10-07 22:0x 開工 — trace pvcheck-20261007-hotfix1）

### 背景
- Reviewer（`logs/pvcheck-review.md`，22:1x）APPROVE 整單，唯一 major = **F1**：409「其他人已核對」notice 實際 invisible
- 症狀：`DailyReviewRow.submitCheck` 409 else 分支 `setNotice('其他人已核對')` + `setCheckDate(null)` + `onRecompute()` 同一 React batch（React 18 auto batching）→ `onRecompute=handlePreview` 第一行 `setPreviewLoading(true)`（busy=true）同 commit → 舊 `useEffect(if (busy) { setJustChecked(new Set()); setNotice('') })` 同幀清走 notice → 提示只渲染 ~1 幀，用戶睇唔到（MD D5 要求提示「其他人已核對」）。數據流正確（recompute 攞返真實狀態、DB 只 1 active，reviewer ⑤ 實測）
- F2（canCheck 初值 null）skip：Reviewer 註實戰 KIOSK 入唔到 /payout（nav gate OWNER+provider_payout），純 defense-in-depth

### 修法（Reviewer 建議 falling edge，CEO 同意）
- `DailyReviewRow.tsx` busy effect 由「busy=true 即清」改 **busy falling edge（true→false 先清）**：`const prevBusy = useRef(busy)` + `if (prevBusy.current && !busy) { setJustChecked(new Set()); setNotice('') }`
- 副作用核對：
  ① notice 而家留低經過 recompute，直到 recompute 完成（busy→false）先清 — 可接受，用戶先睇到提示
  ② justChecked 清嘅時序由「recompute 開始」變「recompute 完成（data 已變）」— 啱返 MD A5 口徑「review data 變先清」（recompute 期間舊 data 仲顯示，highlight 仲準確；新 data 到先清）
- 初值路徑核對：`useRef(busy)` 用首 render 值 → 首 effect run `prev===busy` 必無 edge；就算首載 busy=true 起始都唔會誤清（實際上 `previewLoading` 初值 false，且 DailyReviewRow 要 `previewData.preview` 先 mount，mount 時 busy 已 false）；`setCheckDate(null)` 嗰行（409 分支）唔受影響
- 順手 F3（minor）：護士名單 GET 失敗只「載入中…/錯誤」無 retry → 加「重試」小掣（`setNurseKey(k+1)` 同一 400 重 GET 機制；GET 失敗態 = `nurses===null && canCheck===null && checkError`，而 GET 失敗會令 loading 文案誤顯示「載入中…」→ 失敗態改顯示錯誤+重試；standalone checkError 行加 `nurses !== null` 條件防雙重顯示）。<20 行，trivial，做

### 改動（DailyReviewRow.tsx 單檔，+19/−4；另 progress log）
- **F1（major）**：line 81 `const prevBusy = useRef(busy)` + line 82-85 effect 改 falling edge：`if (prevBusy.current && !busy) { setJustChecked(new Set()); setNotice('') }`（舊 line 78 `if (busy) {...}` 删）。副作用①②已喺上段核對；`setCheckDate(null)`（line 118 成功路徑 / line 129 409 路徑）未改
- **F3（minor，順手做，+8 行）**：護士名單 GET 失敗態（`nurses===null && canCheck===null && checkError`）由誤顯「載入中…」改為錯誤＋【重試】小掣（line 178-181，`setNurseKey(k=>k+1)` 同 400 重 GET 機制）；standalone checkError 行（line 213）加 `nurses !== null` 條件防雙重顯示。400/409 舊路徑行為不變（400 仍由 effect reset checkError）
- 未改：F2 skip（Reviewer 註：KIOSK 實戰入唔到 /payout，純 defense-in-depth）；其他任何嘢

### gates（全綠，改動後實跑）
- `npx tsc --noEmit`（apps/web）= 0
- `pnpm lint:hooks`（apps/web）= 0
- `bash scripts/run-guards.sh`（repo root）= exit 0 全部守門通過
- `npx tsx --test src/lib/payout/daily-review-local.test.ts` = 5/5 pass

### F1 live 驗證（3010，22:2x HKT）
**口徑**：UI notice 係 client-side（React state），curl 睇唔到 → 驗證 = ① 409 並發 API 重跑（數據流）＋ ② 代碼層 falling edge 邏輯；**UI 可見性由老細驗收時兩 tab 實測**

**① 409 並發重跑（5 輪，每輪先 DELETE 09-07 check 還 fresh → 兩 curl 同時 POST）**：
5/5 輪全部 = 一邊 `200 {"ok":true,"id":...}` ＋ 另一邊 `409 「呢日啱啱已經有人核對咗，請重新整理」（P2002 分支 = 正正觸發 line 128 setNotice('其他人已核對') 嗰支）`；每輪 DB `DailyRevenueCheck` 09-07 **active = 1**（id 逐輪換：cmuy7ao510…/7ao7c…/7ao9i…/7aobn…/7aodt…）。⚠ 期間另觀察到預存在嘅 intermittent 401（見下）
**驗證後 DB 已還原 fresh seed**（DELETE 剩低 check → `count(*)=0`；preview 復核：8 UNCHECKED + 1 NONE、needsAck=true、doctorTotal=29800 — 同 reviewer 開場狀態一致，老細可直接兩 tab 實測）

**② 代碼層（改動後行號）**：409 分支 line 128-130 = `setNotice('其他人已核對')` → `setCheckDate(null)` → `onRecompute()`（= `handlePreview`，payout/page.tsx:276 第一行 `setPreviewLoading(true)` → busy=true，同 React batch）。新 effect line 82-85：`if (prevBusy.current && !busy)` — busy false→true（recompute 開始）時 `prev=false` → **唔會清**（舊版 `if (busy)` 正正係呢個時機清走 notice）；notice 保留至 busy true→false（recompute 完成、`setPreviewData` 同 batch 落新 data）先清 — 用戶喺成個 recompute 期間都睇到「其他人已核對」。初值路徑：`useRef(busy)` 首 render 值 → 首 effect run `prev===busy` 必無 edge（首載 busy=true 起始都唔會誤清；實際上 `previewLoading` 初值 false 且 DailyReviewRow 要 `previewData.preview` 先 mount）
**bundle 核**：3010  served chunk（`app/(protected)/payout/page.js`，1.06MB）含 `prevBusy.current && !busy` ×1 ＋ 「重試」；舊 pattern `if (busy) { setJustChecked` = 0 → dev server 已 hot reload 呢單新 build

### ⚠ 附加觀察（預存在、本單唔修、建議開另單）
**dev server 並發請求 intermittent 401**：同一有效 session cookie 兩並發請求，偶爾一邊 `401 Unauthorized`（require-auth.ts line 92/155 口徑；JWT verify 係純函數 deterministic，疑向 Prisma 並發/路徑）。重現：兩並發 `GET /api/me` → 1×200+1×401；本次 POST 測試 4/13 並發對出現（reviewer 早段 22:0x 並發測試冇撞到，屬 intermittent）。本 hotfix 只改 client 組件（diff 零 server 代碼），與之無關。影響：兩 tab 實測時若輸家撞 401，UI 會行通用 `setCheckError(msg)` 顯示「Unauthorized」而非「其他人已核對」notice（數據流唔受影響，DB 仍 1 active）— 老細實測撞到低頻 401 時重撳一次即可

### 完成
- commit：`fix(pvcheck): F1 409「其他人已核對」notice 改 busy falling edge 先清` ＋ `fix(pvcheck): F3 護士名單 GET 失敗加重試掣`（2 小 commit）＋ push
