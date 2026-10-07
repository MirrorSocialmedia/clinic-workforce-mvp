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
3. A：DailyReviewRow 核對掣 + 行內表 + 409 + justChecked filter
4. A4：`src/lib/payout/daily-review-local.ts` applyLocalCheck（純函數）+ onChecked 局部更新
5. B：providerId/providerLabel props + href + daily/page.tsx 讀 providerId
6. C：`daily-review-local.test.ts` + ci.yml 清單
7. gates（tsc / lint:hooks / run-guards @ repo root / pnpm test 新檔）
8. D 區 7 項 curl 實測（3010，OWNER 帳號）

### 進度日誌
- 21:1x gen2 收工單；環境核活（DB 空庫、3010 活、worktree 淨 @ b7f92c99）
- 21:1x 錨點重校完成（上表）；progress 檔 commit
- 21:3x seed 綠：TW 09-02~08 $7,000/日、09-09 $1,000、09-10 NONE；10-01~06 有數、10-08/09 未來；ProviderCommission 40%（preview 必需）；OWNER/KIOSK/EMPLOYEE 帳號 login 通；check API 200/409/400/revoke 實測 OK（09-08 smoke 後已 revoke，8 日全返 UNCHECKED）
