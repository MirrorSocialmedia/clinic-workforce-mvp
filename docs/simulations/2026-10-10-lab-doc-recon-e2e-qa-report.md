# Lab 單據對數（LAB_DOC_RECON_SPEC v1.2）端到端模擬報告

- 日期：2026-10-10
- 範圍：workforce `cwm-labdoc/p1`–`p4`（測 `p4` HEAD `aaae430`，已包 p1–p3）＋ wa-inbox `main` `2e9d137`（已合併 `cwi-labdoc-extract`、`cwi-labdoc-followup`）
- 方法：本機起真 stack（Postgres 16 + workforce `next dev` + wa-inbox `next dev` + 假 LLM upstream），用真 API、真加密 envelope、真檔案儲存，逐步做「到貨→影 invoice→讀單→確認→對成本→收月結單→對數→處理差異→確認」，每步查 DB。
- 病人資料：全部用縮寫／假編號；冇真銀行資料。

---

## 1. 結論

**後端大致做得到，但而家未用得。**

- 讀單、識別 Lab／診所／醫生、對成本、月結單三種格式配對嘅核心邏輯，喺模擬入面大部分正確。例子：
  - Sodental 全鋯 3 隻對 2 隻 → `QTY_DIFF`；
  - Excel 欠款單 `statedCurrent` 差 $85 計得啱；
  - 下個月 → `PREVIOUSLY_MATCHED`。
- **最大問題係冇畫面。** 確認頭部、配對成本、處理月結單差異嘅頁（§12.2／§12.3／§12.4／§12.7）一頁都未有。員工只可以上傳同睇相，接住嗰步做唔落去。
- 另外有 **6 個要先修嘅 bug**：
  - 有啲會靜靜令數唔啱：
    - 「月結單為準」改咗 invoice total，但係冇改行同成本；
    - 重複月結單可以確認兩次；
    - 揀錯候選會蓋咗另一筆成本。
  - 有啲會令流程卡死：
    - 讀單失敗之後冇得人手輸入；
    - 超過 10 個病人嘅 invoice 對唔到；
    - 合併功能永遠失敗。

| 嚴重度 | 數量 |
|---|---|
| 🔴 阻塞／錢會錯 | 7 |
| 🟠 要修（流程卡／資料唔一致） | 8 |
| 🟡 改善 | 9 |

---

## 2. 測試資料

| 項目 | 內容 |
|---|---|
| Lab | Goodwill、KEA、Modern、Sodental、Excel（P1–P4 seed） |
| 診所 | 大圍（TW）、土瓜灣（TKW） |
| Invoice | 8 月 4 張（G1–G4 實物相）、9 月土瓜灣 Sodental×4、Excel×2、Goodwill×1，另加 12 組、讀單失敗、截斷、垃圾回應等邊界單 |
| 月結單 | Sodental 9 月 PDF（明細型，3 醫生 3 段，TEXT 模式）、Excel 9 月 PDF（欠款型，12 行分齡）、Goodwill 9 月相（單號型，VISION 模式）、Excel 10 月（欠款型） |
| 角色 | OWNER、MANAGER、EMPLOYEE（有 `lab_invoice` grant）、ACCOUNTANT |

---

## 3. 問題清單

### 🔴 R1 冇處理畫面（§12.2／§12.3／§12.4／§12.7）

**而家有嘅：**
- `/lab-docs`（上傳＋列表）
- `/lab-docs/archive`
- `/lab-docs/settings`
- `LabDocViewer`（睇相）

**未有嘅：**
- `/lab-docs/invoices/[id]`：確認頭部、分組配對、新增成本、確認到貨；
- `/lab-docs/statements/[id]`、`/sections/[sid]`：指派、對數、處理差異、確認；
- 成本錄入頁嘅「單」icon，同「已連 invoice，唔套月度折扣」提示（§12.7）。全 repo UI 冇用到 `labInvoiceLinked`。

**後果：**
- 待處理入面「去處理」只會跳返 `/lab-docs`；
- 撳單據只係開相；
- 本報告所有流程都要直接打 API 先做到。

---

### 🔴 R2 「月結單為準」（STATEMENT_WINS）喺單號型／欠款型月結單：改咗 invoice total，冇改行，亦冇改成本

**重現（Excel 欠款單）：**
1. 系統 invoice 202609-0509 = $80，已 SUPPLEMENT 連去成本（976 → 該成本）。
2. 月結單寫 $85 → `AMOUNT_DIFF`。
3. `resolve STATEMENT_WINS`。

**結果：**
- API 一次過回 200，冇 `needsCostConfirm`；
- 分段顯示 `MATCHED`、`systemTotal 1061 = statedCurrent`，**睇落已經對好**。

**DB 實況：**

| | 改之前 | 改之後 |
|---|---|---|
| invoice `total` | 80 | **85** |
| Σ invoice 行 | 80 | **80**（冇改） |
| 成本 `baseCost` | 976 | **976**（冇改，應該係 1061） |

audit `LAB_STATEMENT_ADJUST`：`{"line":{"qty":null,"unitPrice":null,"amount":null},"docTotal":85,"cost":null}`

**原因：**
- 單號型同欠款型（A／C 型）配對只寫 `matchedDocumentId`，`matchedLineId = null`。
- `resolve/route.ts` 嘅成本鏈同改行都喺 `if (targetLine)` 入面，所以全部跳過。
- 但係改 doc total 嗰段照做。

**影響：**
- Goodwill、Excel、KEA、Modern 呢類「一行 = 一張單」嘅月結單，揀「月結單為準」都唔會改到成本；
- invoice 變成 total ≠ Σ 行，之後再改頭部會俾 §5.5 擋住。

**建議：**
- 單號型行冇 `matchedLineId` 時：
  - 如果 invoice 只有一行 → 當嗰行處理；
  - 多行 → 要求先揀邊行（`systemLineId`），或者 400「單號型請用 MANUAL_PAIRED 揀行」。
- 唔好淨係改 doc total。

---

### 🔴 R3 同一段月結單可以確認兩次（§8.1 重複擋唔到）

**重現：**
1. Goodwill 9 月 Dr Ho 月結單已經 `RECONCILED`。
2. 再影一次上傳。GET 會見到 `section.duplicate = {docId, uploadedAt}`。
3. 照樣 resolve 再 confirm → **200**。

**DB：** 兩份 9 月 Goodwill／土瓜灣／Dr Ho 月結單都係 `RECONCILED`。

**另一個重現：** 喺重複嗰份做 STATEMENT_WINS，一樣會改系統 invoice 同成本（第 22 步實測 5110 → 5670）。

**原因：** `confirm`、`resolve` 兩個 route 都冇查 `duplicate`。

**建議：**
- 分段有 duplicate 而未 supersede → confirm／resolve／reconcile 回 409；
- 409 嘅訊息照 §8.1 寫：「{月} {診所} {醫生} 嘅月結單已經喺 {日期} 上傳」。

---

### 🔴 R4 讀單失敗之後冇得人手輸入（§11 `PUT /api/lab-docs/:id/manual` 未做）

**重現：** LLM 3 次失敗 → `EXTRACT_FAILED`。

- `PUT /manual` → 404；
- `PUT /header` → 400「單據狀態 EXTRACT_FAILED 未可以確認（要先讀單）」（`CONFIRMABLE` 唔包 `EXTRACT_FAILED`）。

**影響：** 相影得太差，或者 LLM 停機時，張單只可以「再讀」或者作廢，永遠入唔到系統。retry route 喺讀單服務未設定時回 503，訊息叫人「請人手輸入」，但係根本冇路人手輸入。

**建議：**
- 做 `/manual`；
- 或者讓 header PUT 接受 `EXTRACT_FAILED`，連新行（冇 `lineId`）一齊寫，寫完轉 `CONFIRMED`。

---

### 🔴 R5 「新增成本」唔係原子操作，換 key 再撳會開第二筆（§7.8）

**重現：** G4 Sodental（TW002886 $560）：
- `new-case` 同 key 撳兩次 → 正確 replay；
- **新 key 再撳** → 第二筆 $560 PRICED 成本。

兩筆都係 `labInvoiceLinked=true`，但係冇任何 invoice 行連住。

**原因：** `new-case` 只係開成本，冇喺同一個 transaction 入面連埋分組行。

**影響：**
- 經理撳兩下，或者網絡 retry，就會重複計 Lab 成本；
- `labInvoiceLinked=true` 會令呢筆唔套月度折扣，亦唔會入 `RECEIVED_NO_INVOICE`，冇人會發現。

**建議：** 照 §7.8：新增成本 + MATCH 分組行喺同一個 transaction 做；分組已有 MATCHED 行就 409。

---

### 🔴 R6 揀錯候選＋改價，會靜靜蓋咗另一筆成本，解除配對都唔會還原

**重現：** Goodwill invoice「Acrylic partial denture $1200」。同一個病人有兩筆成本：denture $1200、night guard $400。系統預選 $1200 嗰筆（正確 ✓）。
1. 揀錯咗 night guard；
2. 同時「改做」（`priceUpdates`）→ 200，冇任何防呆；
3. night guard 成本由 $400 變咗 **$1200**；
4. 之後 UNMATCH → 仍然係 $1200（§7.9 設計上唔還原）。

**影響：**
- 醫生拆賬金額錯；
- 嗰筆成本而家喺 `NOT_RECEIVED` 出現（$1200）；
- denture 嗰筆就冇單連住。

**建議：**
- 改價前，如果候選嘅 `itemType`／原價同 invoice 行差好遠（例如 > 50%）→ 要二次確認；
- UNMATCH 時，如果最近一次改價係由呢張單觸發 → 提示「還原做 $X？」（audit 已經有 before 值）。

---

### 🔴 R7 P2 seed 唔可以喺正式環境跑

`prisma/seed-cwm-labdoc-p2-20261006.mjs` 有兩個問題：
1. `INSERT INTO "Lab" … ON CONFLICT (id)`：正式庫已經有同名 Lab（id 唔同）→ 撞 `Lab_name_key` unique → **seed 直接 crash**。
2. 會插入測試用診所「臻善牙科（大圍2）」「滙樂牙科（土瓜湾）」（shortName TW／TKW）、假醫生同 HUI LOK 診所 alias。

**建議：**
- Lab 用 `ON CONFLICT (name) DO UPDATE`；
- 測試診所、醫生、alias 搬去 e2e seed，唔好放喺 migration 級 seed。

---

### 🟠 O1 超過 10 個病人嘅 invoice 對唔到

**原因：** RBAC 只登記咗固定路徑：
- `groups/0..9/candidates`
- `groups/0..10/save`

而 save route 自己再限 `groupIndex ≤ 10`。但係 header、new-case 准 ≤ 99。

**重現：** 12 組 invoice 確認頭部 OK 之後：
- `GET groups/11/candidates` → **403**「route not registered」；
- `POST groups/11/save` → **400**「分組編號格式錯誤」。

**建議：**
- `normalizePath` 將 `/groups/\d+/` 正規化做 `/groups/:g/`，RBAC 只登記一條；
- 三個 route 統一用上限 99。

---

### 🟠 O2 合併 invoice（§7.11）永遠失敗

**原因：** 一次上傳兩個檔，兩張單嘅 `createdAt` 相差幾毫秒（實測 `05:13:52.621` 同 `.627`）。merge 用 `createdAt` 完全相等判斷「同一批」→ 永遠 400「只可以合併同一時間上傳嘅單據」。

**建議：**
- upload 加 `uploadBatchId`（或者 transaction 內共用一個 `now`）；
- merge 用 `uploadBatchId` 判斷。

---

### 🟠 O3 讀單途中作廢（或者合併），讀完會「翻生」

**重現：**
1. 上傳，令假 LLM 延遲 8 秒；
2. `EXTRACTING` 時 `DELETE`（作廢，原因「影錯相」）→ 200 `VOID`；
3. 8 秒後再睇。

**結果：** `status = NEEDS_REVIEW`，`voidReason` 仲係「影錯相」，有 1 行。

**原因：** `extract.ts` 嘅 `finishSuccess`，同埋失敗收尾嘅 `updateMany({ where: { id } })`，冇加 `status: 'EXTRACTING'` 條件。合併 VOID 掉嘅舊單一樣會中。

**建議：** 所有收尾寫入改用 `where: { id, status: 'EXTRACTING' }`；0 行就靜靜放棄。

---

### 🟠 O4 7 年 purge 清唔到病人姓名

**重現：**
1. 將一個檔 `purgeAt` 推到過期；
2. 跑 `labdoc-purge`。

**結果：**
```
errors: ["doc …: Raw query failed. Code: 42703. column \"documentId\" does not exist"]
```
- `docsPiiCleared: 0`；
- 原檔已刪（410 正確），但係 `LabDocumentLine.patientNameRaw` 仲喺度。

**原因：** `purge.ts:118` 寫 `UPDATE "LabStatementLine" … WHERE "documentId" = …`，但係 `LabStatementLine` 只有 `sectionId`。成個 transaction rollback，連 invoice 行嘅姓名都冇清。每月 cron 都會報錯，永遠清唔到。單元測試 fake 咗 `$executeRaw`，所以冇捉到。

**建議：**
- 改做 `WHERE "sectionId" IN (SELECT id FROM "LabStatementSection" WHERE "documentId" = …)`；
- 加一個真 DB 嘅 purge 測試。

---

### 🟠 O5 欠款型月結單：上線前嘅舊欠款每個月都要重新逐行處理

**情況：** Excel 9 月單有 10 行係上線前（2025-12 至 2026-06）嘅舊單，系統冇 → 10 行 `MISSING_IN_SYSTEM`。

1. 要逐行 resolve 先確認到（實測：「仲有 10 行未處理」）。
2. 10 月單同一批舊單再出現 → **又係 10 行 MISSING**。原因係 `PREVIOUSLY_MATCHED` 只認之前 `MATCHED` 過，唔認之前已經處理（INVOICE_WINS／NOT_OURS）嘅行。
3. 揀 INVOICE_WINS 嘅仲會入 `STATEMENT_DIFF`「跟進中」，待處理越積越多。

**影響：** Excel 每個醫生每個月都要重複撳十幾次，好快冇人肯用。

**建議（要改 spec C.2）：**
- 之前已確認分段入面同一單號「有 resolution」都當 `PREVIOUSLY_MATCHED`（或者新狀態 `PREVIOUSLY_RESOLVED`）；
- 另加「上線日」設定：早過上線日嘅欠款行預設 `NOT_APPLICABLE`。

---

### 🟠 O6 Supersede（取代舊版）之後，之前處理好嘅差異全部要重做

Excel 9 月單 Lab 重發：
1. supersede 成功；
2. 新文件 10 行舊欠款再次 `MISSING_IN_SYSTEM`，冇 resolution；
3. 舊文件嘅 INVOICE_WINS 跟進項目，因為 pending 排除 `SUPERSEDED`，**靜靜消失**。

**建議：** supersede 時按（docNo + amount）將舊分段 resolution 帶過去新分段，或者至少保留未完成嘅跟進。

---

### 🟠 O7 處理錯咗冇得改

已有 resolution 嘅行再 resolve → 409「行已經處理過（可改配 MANUAL_PAIRED）」。

**實測：** 本來想揀 STATEMENT_WINS，第一下 API 回 200 + `needsCostConfirm`（只係預覽）。如果之後揀咗 INVOICE_WINS，就再冇得改返 STATEMENT_WINS。

**建議：**
- 未確認分段之前准改 resolution（或者加「撤銷處理」）；
- 預覽回應唔好用同一個 200 + `ok:true`，可以改用 `409 + code: NEEDS_COST_CONFIRM`，避免前端當成功。

---

### 🟠 O8 冪等紀錄卡死：失敗過一次嘅 key 永遠用唔返

**原因：**
- `acquireWriteLog` 之後只要唔係成功返回（400／403／404／409 驗證失敗、500），`LabDocWriteLog` 就一直係 `IN_PROGRESS`；
- 同 key 重試永遠 409「正在處理中 — 請用新 key」。
- upload 有 `STALE_IN_PROGRESS_MS`，`write-log.ts` 冇。

**實測：**
- 模擬完 DB 有 12 行 `IN_PROGRESS` 殘留；
- merge 失敗之後同 key → 409。

**建議：**
- 失敗路徑刪除該 write log（或者標 `FAILED`，准同 key 重試）；
- 加 stale 時限。

---

### 🟡 改善

| # | 問題 | 證據 | 建議 |
|---|---|---|---|
| Y1 | 候選 `providerName` 永遠 null | `candidates.ts:173` 用 CostCase id 去查 Provider | 用 `rows.map(r => r.providerId)` |
| Y2 | 候選 `defaults.lineActions` 有 `UNMATCH` 但冇 `costCaseId`，原樣送 save 會 400 | G4 實測「UNMATCH 要帶 costCaseId」 | 預設唔好出 UNMATCH，或者帶埋 id |
| Y3 | seed 嘅 alias id 唔係 25 字，刪唔到 | 14 個 alias 有 12 個 → DELETE 400「id 格式錯誤」 | seed 用 cuid，或者 `ID_RE` 放寬 |
| Y4 | 並發輸咗嗰個回 500「儲存失敗」 | 同時兩張單 MAIN 連同一成本：一個 200、一個 500（資料冇錯，B7 守得住） | Prisma `P2034`／serialization → 409「啱啱有人改咗，請重新載入」 |
| Y5 | 冇獨立 `POST /lines/:lineId/unmatch` route（§11） | 404；但係 save 嘅 UNMATCH 做到同樣嘢 | 改 spec，或者補 route |
| Y6 | 補上傳 invoice 之後冇「有新 invoice，可以重新配對」提示（§8.3） | section 冇相關欄位，要人手撳 reconcile | 新 invoice 確認時標記受影響分段 |
| Y7 | 已鎖成本 STATEMENT_WINS 嘅預覽 `newLinkedSum: 0` | `resolve/route.ts:186` hard-code 0 | 照計 linkedSum |
| Y8 | `extractError` 只存「llm」，分唔到 truncated、parse_error、timeout；1 頁 truncated 照樣重試 3 次 | wa-inbox log 有 `reason:"truncated"`，workforce DB 只見 `llm` | 存 `llm:truncated` 等；最細粒度 truncated 直接 FAILED 唔重試（§5.2） |
| Y9 | 已到期（`purgeAt` 過咗）但月度 job 未跑之前仍然可以下載 | GET → 200 | `purgeAt <= now` 都回 410 |

---

## 4. 已通過（DB 有證據）

### 讀單、識別
- Lab 經 NAME／ALIAS 認到（包括名第一個字被切嘅「odwill」）。
- 診所經 ADDRESS 認到（中文、英文地址都得）。
- 醫生經 NAME 認到。
- `patientCodeNorm` = 前綴 + 6 位（TW007159）。
- Sodental 月結單第一次認唔到診所 → 指派＋「記住」→ 下一份自動 `CLINIC_ALIAS` ✓。
- PDF 月結單行 TEXT 模式；相片行 VISION。延遲約 1.6 秒（假 LLM）。

### Invoice 流程
- 確認頭部、sum 唔啱擋確認；改 total 標 `manualAmountEdit` → `AMOUNT_REVIEW` 待處理。
- 敏感資料過濾：去咗戶口號，保留單號。
- 收款人有支票字眼（`CHEQUE_PRESENT`）擋確認。
- B4：連 invoice 嘅成本 `discountPct = null`；成本錄入頁 PUT、recompute 都唔會打返折扣。
- 確認到貨日 → `periodMonth` 正確。
- 已鎖成本：改價 409，只連單 200。
- B7：第二張 MAIN → 400，SUPPLEMENT OK。並發兩張同時 MAIN → 最多一條 MAIN ✓。
- 作廢成本 → 行解除配對，單返 `CONFIRMED`。
- 作廢 invoice：有配對行 409；冇原因 400；作廢後同單號再上傳唔當重複。
- 重複上傳：同 sha → 409 `duplicateOf`；唔同 sha 同單號 → `DUPLICATE`。
- 讀單失敗 3 次 → `EXTRACT_FAILED`（約 66 秒）→ 入待處理 → 再讀成功。

### 月結單流程
- 明細型（Sodental）：同單號分組、逐行比 qty／價；`QTY_DIFF`、`MISSING_IN_SYSTEM` 準確。
- 欠款型（Excel）：`statedCurrent` vs 系統比較啱（差 $85）；下個月 → `PREVIOUSLY_MATCHED`。
- 單號型（Goodwill）：`AMOUNT_DIFF`。
- 明細型 STATEMENT_WINS：先預覽，確認後 invoice 行、total、成本一齊改（5110 → 5670）；已鎖成本唔改價。
- 未處理就確認 → 400；全部分段確認 → 文件 `RECONCILED`。
- 跟進完成（close-followup）→ 待處理減 1。
- Supersede：要原因、EMPLOYEE 403、舊文件 `SUPERSEDED`。

### 權限、安全
- ACCOUNTANT 對所有 lab 路由 403；EMPLOYEE + `lab_invoice` grant 做到 invoice，但 `lab_statement` 動作（assign、confirm、supersede、CSV）全部 403。
- IDOR：
  - 連去其他診所／Lab 嘅成本 → 擋；
  - section 唔屬 doc、line 唔屬 section → 404；
  - MANUAL_PAIRED 跨 Lab → 400。
- 冪等：同 key 同內容 → replay；同 key 唔同內容 → 409；舊 version → 409。
- 檔案：
  - 碟上加密（`LDOC1` header、`.bin`）；
  - `private, no-store`；
  - 冇登入 401；
  - purge 後 410，碟檔已刪。
- CSV 防公式注入（`=HYPERLINK` 前面加 `'`）。
- cron sweep／purge 冇 key 或者錯 key 都係 403。

---

## 5. 流暢度觀察

1. **一張 Sodental invoice 由上傳到對好要 4 個 API**（上傳 → 頭部 → 候選 → 儲存），加埋新成本要 5 個。冇畫面串連，靠人記 version 同 key，一定出錯。做畫面時應該將「確認頭部 + 每組配對」放喺同一頁，逐組撳「下一個」。
2. **欠款型月結單係最大負擔**（O5）：第一個月每個醫生要處理十幾行舊單，之後每月重複。
3. **待處理清單**：`MISSING_IN_SYSTEM` 15 項入面，10 項係舊欠款，噪音比真問題多。
4. 讀單速度好（假 LLM 約 1.6 秒）；真 LLM 要再實測 85／95 秒 timeout。

---

## 6. 建議修正次序

1. **R2、R3、R5、R6**（錢會錯）＋ **O3**（作廢翻生）＋ **O4**（purge SQL）：都係細改，1–2 日。
2. **R4**（人手輸入）＋ **O1**（>10 組）＋ **O2**（合併）＋ **O8**（write log）。
3. **R7** seed 改好先上 production。
4. **R1** 畫面（§12.2 → §12.4 → §12.7），連 O5／O6／O7 嘅流程改動一齊設計。
5. 🟡 項目跟手做。

模擬腳本（01–23）同假 LLM 喺 session scratchpad，冇入 repo；要嘅話可以整理做 `scripts/e2e/labdoc-sim/`。

---

## 7. 修正狀態（同日，`cwm-labdoc/p4` commit `a6aebba`、`7523f9f`）

**全部項目已修好**，每項都喺本機真 stack 重跑模擬核實過（回歸腳本 30／40）：

- R1：畫面已做：
  - `/lab-docs/invoices/[id]`、`/lab-docs/statements/[id]`、`/sections/[sid]`；
  - 月結單分頁；
  - 待處理直接跳去單據／分段；
  - 成本錄入「單」icon。
  - Playwright 撳過完整流程：確認 → 新增成本 → RECONCILED；預選成本 → 填入＋到貨；分段處理 → 確認。
- R2～R7、O1～O8、Y1～Y9：逐項回歸通過。
- 另外修好兩個模擬途中先發現嘅問題：
  - 分組儲存中途 400 都會 commit 咗前面嘅動作；
  - truncated 分頁重讀永遠行唔到。
  - 兩個都已經有測試。
- 測試：
  - labdoc 單元測試 407 項（之前冇入 CI，而家已加入）；
  - tsc、lint、deploy guards 全過。
- 施工單升 v1.3，記低行為改動。
