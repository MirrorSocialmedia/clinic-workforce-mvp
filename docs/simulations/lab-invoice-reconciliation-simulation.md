# 模擬任務：Lab Invoice／月結單拍照對數（CWM 成本錄入）

> 用途：交畀模擬 agent，用真實 invoice／月結單「紙上行一次」成個設計，搵出要改善嘅地方。
> **呢份唔係實作規格**。模擬結果會用嚟修訂設計，之後先寫實作 MD。
> 系統：clinic-workforce-mvp（CWM），repo `MirrorSocialmedia/clinic-workforce-mvp`，基準 commit `58872f9`。

---

## 0. 你（模擬 agent）要做乜

你要一人分飾四個角色，逐份文件行晒成個流程，最後交一份改善報告：

| 角色 | 你要做嘅嘢 | 規則來源 |
|---|---|---|
| **A. AI 讀取器** | 按 §5 嘅 prompt 同 JSON schema，將每頁相片讀成 JSON | §5 |
| **B. 系統** | 按 §6–§9 嘅規則**機械式**執行：驗證、揀 Lab／診所、分組、搵候選成本、核對、寫入 | §6–§9 |
| **C. 員工／經理** | 喺系統要人決定嘅位置做決定，並記低「撳咗幾多下、要諗幾耐、有冇猶豫」 | §10 |
| **D. 審查員** | 每一步都問：「呢度會唔會出錯？規則有冇漏？員工會唔會唔識？」 | §12 |

**最重要嘅規則：**

1. **角色 B 唔准自己估**。規則冇講嘅情況，唔好靜靜替系統揀一個做法，要記成一條 finding（§12），寫明「規則缺口」，然後用你認為最合理嘅做法繼續，並註明係假設。
2. **角色 A 同角色 B 要分開**。讀取結果錯咗（例如將 7159 讀成 7169），角色 B 要照錯誤資料行落去，睇系統嘅防線（加總檢查、候選搵唔到、員工確認）捉唔捉到。唔好因為你「睇得出」就自動改正。
3. **唔好連真系統、唔好寫 production DB**。全部喺你自己嘅模擬狀態（§11 fixture）入面做。
4. 你讀得明圖唔代表 Qwen 3.8 讀得明。如果你有辦法用 Qwen 3.8 27B（關閉 thinking）行 §5 嘅 prompt，就用佢嘅輸出做角色 A，並同你自己讀嘅結果比較；冇嘅話，喺報告註明「角色 A 由非 Qwen 模型擔任，讀取準確度唔代表 production」。

---

## 1. 背景同已拍板嘅決定

### 1.1 業務背景

- 集團有多間牙科診所（已知：元朗、土瓜環、大圍、油麻地、美孚、青衣；英文簡稱例如 TW＝大圍、YMT＝油麻地、MF＝美孚）。品牌名「臻善牙科／Artisan Dental」**每間店都一樣**，唔可以靠品牌名分店。
- 醫生落單去外面嘅 Lab 整器材（牙冠、假牙、保持器、種植上部等）。Lab 交貨時附 invoice。
- 員工喺 CWM「成本錄入」為每件器材開一筆**成本記錄**（CostCase），用嚟計醫生月結拆帳。
- 每間 Lab 每月會寄一張**月結單**，列出嗰個月所有 invoice。
- 員工會調鋪，經常幫唔係自己主屬店嘅店上傳 invoice。

### 1.2 已拍板（模擬時當係事實，唔使再質疑，但發現有矛盾要報）

| # | 決定 |
|---|---|
| D1 | 員工錄入成本時，`baseCost` 已經係 **invoice 上嘅實收金額（已折扣後）** |
| D2 | invoice 金額同錄入唔同 → 員工撳一下就改成 invoice 金額 |
| D3 | 上傳 invoice **唔會**自動填到貨日（`receivedAt`），因為唔能夠肯定器材屬邊筆成本 |
| D4 | 開一個**新權限**（暫名 `lab_invoice`：上傳及核對 Lab invoice／月結單） |
| D5 | invoice 相片 **24 個月後自動刪除** |
| D6 | AI 用 wa-inbox proxy 後面嘅 **Qwen 3.8 27B**（vision） |
| D7 | 系統冇成本要新增時，**醫生由員工喺下拉揀** |
| D8 | **一筆成本只可以對應一張 invoice**；一張 invoice 可以對應多筆成本 |
| D9 | 多頁 invoice 唔常見 → 上傳 invoice 時**一頁＝一張**，員工可以手動合併頁 |
| D10 | 冇 invoice 號嘅單，重複檢查用「Lab＋日期＋病人＋金額」，**只提示唔擋** |
| D11 | $0 嘅行預設剔埋，唔影響金額 |
| D12 | 重做：員工照舊將舊成本**作廢**，再開一筆新嘅 |
| D13 | 每間 Lab 每月有月結單；**月結單對數同 invoice 對數一次過做**，唔分期 |
| D14 | **月結單員工都可以上傳**（同 invoice 一樣用 `lab_invoice` 權限） |
| D15 | 上傳後由員工揀病人（有編號就自動揀好）、invoice 行**預設全剔**，再逐行對應成本 |
| D16 | 一張 invoice 可以有多個病人 |
| D17 | 上傳後**自動揀診所**（根據 invoice 內容），唔默認上傳者嘅主屬店 |

### 1.3 未解決、要你喺模擬中搵證據嘅問題

| # | 問題 | 你要做嘅嘢 |
|---|---|---|
| **Q1** | **折扣會唔會計兩次？** 現有系統：`finalCost = baseCost × (1 − LabMonthlyDiscount%)`。D1 話 `baseCost` 已經係折後價。如果月結單冇再額外打折，而系統又設咗 `LabMonthlyDiscount`，就會折兩次。 | 睇用戶上傳嘅月結單：月結單總數係咪等於 invoice 合計？有冇再額外寫「Less discount x%」之類？按證據判斷 `LabMonthlyDiscount` 應該點用，寫成 finding |
| Q2 | 病人編號格式：invoice 上係 `#7159`、`7159`、`2886` 等，系統 `CostCase.patientCode` 嘅真實格式未確認 | 列出每張 invoice 讀到嘅編號格式；指出需要點樣正規化 |
| Q3 | 冇 invoice 號嘅單（例如 KEA 只有 Case No.）用咩做「單號」？ | 睇實際文件，建議規則 |
| Q4 | 已出月結（鎖定）嘅成本，可唔可以「只連 invoice、唔改價」？ | 行 S8 情境時判斷，寫 finding |
| Q5 | 月結單冇出現嘅 invoice（可能入咗下月），幾耐之後入待處理？（預設：連續兩張月結單都冇） | 睇實際月結單嘅截數日，建議規則 |
| Q6 | invoice 上嘅收款人／公司名同 Lab 名唔同（例如 Sodental 張單叫你開支票畀 HONESTY GIFTS INT'L LIMITED） | 記錄邊啲 Lab 有呢情況，建議 Lab 識別用邊個名 |

---

## 2. 現有系統（已核實，模擬時要跟）

### 2.1 相關資料表（`apps/web/prisma/schema.prisma`）

```
Clinic        id, name, shortName?, address?, companyId?
Lab           id, name(unique), isActive, sortOrder
LabMonthlyDiscount  labId, periodMonth('YYYY-MM'), discountPct   @@unique([labId, periodMonth])
Provider      id, name, shortName?, companyId?, isActive        ← 醫生
CostCase
  id, providerId, clinicId, category('LAB'|'IMPLANT'|'INVISALIGN'),
  patientCode, patientName?, orderedAt,
  itemType?, itemTypeOther?, labId?, labOther?, labOrderNo?,
  baseCost?(Decimal)        ← 員工錄入（已折扣後，D1）；null＝未有價
  discountPct?              ← 快照：LabMonthlyDiscount
  finalCost?                ← 醫生月結實際用呢個
  receivedAt?               ← 到貨日；決定 periodMonth
  periodMonth?              ← 由 receivedAt 推導；null＝未到貨，唔入月結
  status: PENDING | PRICED | DONE | VOID | REDO
  redoAt?, redoReason?, note?(≤200字)
  lockedByRunId?            ← 已出醫生月結（PayoutRun LOCKED）；有值＝唔准改
  source: MANUAL | BILL_LINKED
```

### 2.2 現有規則（模擬必須遵守）

- `lockedByRunId != null` 嘅成本，**任何修改都會被拒**（`已出月結，請用下期調整`，HTTP 409）。
- 改 `baseCost` 時，系統用 `LabMonthlyDiscount(labId, periodMonth)` 重新計 `discountPct` 同 `finalCost`；`periodMonth` 係 null 就冇折扣（`finalCost = baseCost`）。
- 成本錄入現有權限係 `cost_entry`（經理預設有）。
- 系統已有「病人姓名定期清除」機制（`PATIENT_NAME_PURGE`），同 PII 守門腳本（`check-pii.sh`）。
- 所有 audit action 一定要喺 `apps/web/src/lib/sensitive-audit.ts` 分類（SPEC 或 EXEMPT），否則部署守門 `check-sensitive-coverage.sh` 會擋。
- AI 只可以經 wa-inbox proxy 叫（加密信封 `llm-envelope`），CWM 唔直接接 LLM。現有 proxy 只收文字，要加一個收圖嘅接口。

---

## 3. 設計總覽

```
逐張 invoice（員工，手機）
  上傳 → AI 讀取 → 確認 Lab／診所／單號（自動揀＋依據）→ 逐個病人核對（預設全剔）→ 儲存（可部分）
                                                              │
                                                              ▼
                                               成本錄入：連 invoice・改價・新增
                                                              │（已上傳 invoice）
每月月結單（員工或經理）                                        ▼
  上傳（多頁＝一份）→ AI 讀取 → 逐行對系統 invoice → 月結差異（總數＋折扣）
                                                              │
                                                              ▼
                                                        待處理清單
```

---

## 4. 草擬資料模型（模擬時用嚟記錄「寫入咗乜」）

> 呢個係草稿，你可以喺報告建議改。

```
LabDocument                       ← invoice 同月結單共用
  id
  kind: INVOICE | STATEMENT
  status: UPLOADED | EXTRACTING | EXTRACT_FAILED | NEEDS_REVIEW | CONFIRMED | PARTIAL | RECONCILED | VOID
  labId?            labNameRaw         labBasis('ALIAS'|'NAME'|'MANUAL')
  clinicId?         clinicBasis('CUSTOMER_NO'|'ADDRESS'|'SHORT_CODE'|'MANUAL')  clinicEvidence(原文)
  customerNoRaw?
  docNo?            docNoKind('INVOICE_NO'|'CASE_NO'|null)     ← Q3
  docDate?          deliveryDate?   orderReceivedDate?
  statementMonth?   ('YYYY-MM'，STATEMENT 先有)
  grossTotal        discountPct?     netTotal?                 ← STATEMENT 先有折扣
  pageCount         imageKeys[]      imagePurgeAt (= createdAt + 24 個月)
  extractedJson     (AI 原始輸出，唔改)
  uploadedBy        confirmedBy?     voidReason?
  @@unique([labId, docNo, kind]) WHERE docNo IS NOT NULL AND status <> 'VOID'

LabDocumentLine                   ← INVOICE 嘅行
  id, documentId, groupIndex(病人分組), patientNameRaw?, patientCodeRaw?, patientCode?(正規化),
  labCaseRef?, description, qty?, unitPrice?, amount, isZero,
  lineStatus: UNMATCHED | MATCHED | IGNORED
  costCaseId?

StatementLine                     ← STATEMENT 嘅行
  id, documentId, docNoRaw?, docNo?(正規化), date?, patientRaw?, amount,
  matchedDocumentId?, status: MATCHED | MISSING_IN_SYSTEM | AMOUNT_DIFF

CostCase 加：labDocumentId?     ← D8：一筆成本只對一張 invoice

LabNameAlias      rawName(正規化) → labId          ← 確認一次就記住
LabCustomerAlias  (labId, customerNo) → clinicId   ← 確認一次就記住
```

**新 audit action**（全部要入 `sensitive-audit.ts`）：
`LAB_DOC_UPLOAD`、`LAB_DOC_CONFIRM`、`LAB_DOC_VOID`、`LAB_DOC_LINE_MATCH`、`LAB_DOC_LINE_UNMATCH`、`LAB_DOC_PRICE_UPDATE`（改 baseCost，SPEC）、`LAB_DOC_CASE_CREATE`（SPEC）、`LAB_STATEMENT_RECONCILE`、`LAB_DOC_IMAGE_PURGE`、`LAB_ALIAS_LEARN`。
模擬時每個寫入都要列出會寫邊條 audit、`before`／`after` 係乜。

---

## 5. 角色 A：AI 讀取

### 5.1 輸入

- 每次**一頁**相片（INVOICE）；STATEMENT 就係成份（多頁）。
- 相片可能：打橫（旋轉 90°）、有摺痕、有手寫記號（例如圈住嘅「①」）、有印章、頁頂被切。

### 5.2 Prompt（production 會用呢段；你做角色 A 時照跟）

```
你係牙科 Lab 單據讀取器。只輸出一個 JSON 物件，唔好輸出任何其他文字。
規則：
1. 先判斷文件類型：INVOICE（單張發票／送貨單）或 STATEMENT（月結單，列出多張發票）。
2. 只抄文件上印出嘅內容；手寫字、圈號、簽名唔好讀。讀唔到嘅欄位填 null，唔好估。
3. 金額一律輸出數字（唔要 $、HK$、逗號）。日期一律 YYYY-MM-DD；原文係 D/M/YYYY 就轉換，並喺 dateRaw 保留原文。
4. 病人：抄原文姓名到 patientNameRaw；姓名後面或 # 後面嘅數字抄到 patientCodeRaw（只抄數字）；
   Lab 自己嘅參考編號（例如 DT9003874、Case No.）抄到 labCaseRef。
5. 同一個病人嘅多行放喺同一個 group。
6. 絕對唔好抄銀行帳號、戶口號碼、信用卡號、Swift code。
7. 如果有「List Price」同「D/C %」同「U'Price」，amount 用實際收費嗰欄。
8. 如果文件打橫或倒轉，照樣讀。
```

### 5.3 輸出 JSON schema

```json
{
  "kind": "INVOICE | STATEMENT",
  "lab": { "nameRaw": "string|null", "nameCnRaw": "string|null", "payeeRaw": "string|null" },
  "billTo": { "nameRaw": "string|null", "addressRaw": "string|null", "customerNoRaw": "string|null",
              "shortCodeRaw": "string|null", "doctorRaw": "string|null" },
  "docNoRaw": "string|null",
  "docNoLabel": "Invoice No. | Case No. | INVOICE# | 其他原文 | null",
  "dateRaw": "string|null", "date": "YYYY-MM-DD|null",
  "deliveryDate": "YYYY-MM-DD|null", "orderReceivedDate": "YYYY-MM-DD|null",
  "statementMonth": "YYYY-MM|null",
  "groups": [
    { "patientNameRaw": "string|null", "patientCodeRaw": "string|null", "labCaseRef": "string|null",
      "lines": [ { "description": "string", "qty": "number|null", "unitPrice": "number|null",
                   "listPrice": "number|null", "discountRaw": "string|null", "amount": "number" } ] }
  ],
  "statementLines": [
    { "docNoRaw": "string|null", "date": "YYYY-MM-DD|null", "patientRaw": "string|null", "amount": "number" }
  ],
  "subtotal": "number|null", "discountRaw": "string|null", "discountAmount": "number|null",
  "total": "number|null",
  "readIssues": ["string"]
}
```

- `readIssues`：你覺得唔清楚嘅地方（例如「頁頂被切，Lab 名睇唔晒」）。
- INVOICE 嘅 `statementLines` 係空陣列；STATEMENT 嘅 `groups` 係空陣列。

### 5.4 讀取後系統自動檢查（角色 B 做）

| 檢查 | 唔過嘅處理 |
|---|---|
| 每行 `qty × unitPrice = amount`（有齊先檢查，容許 ±0.01） | 標黃該行，員工確認 |
| Σ 行 `amount` = `total`（或 `subtotal`） | **擋住唔准確認**，員工要改到一致 |
| `date` 喺上傳日前 180 日內、唔喺未來 | 標黃 |
| `kind` 同上傳時揀嘅分頁唔同 | 提示「似係月結單，要唔要轉？」 |
| 讀到任何似銀行帳號嘅長數字（≥8 位數字＋dash）出現喺任何欄位 | 丟棄該欄位，記 finding（prompt 失效） |

### 5.5 Golden 範例（用嚟校準你自己嘅讀取；用戶提供過嘅 4 張單）

> 你讀用戶新上傳嘅文件前，先用呢 4 張嘅預期輸出理解格式。

**G1 Goodwill（直版、有手寫「①」）**
```json
{ "kind":"INVOICE",
  "lab":{"nameRaw":"Goodwill Dental Laboratory Limited","nameCnRaw":null,"payeeRaw":null},
  "billTo":{"nameRaw":"Dr Lau Ho Yin (大圍臻善)","addressRaw":"新界大圍車公廟路18號圍方418號舖(港鐵大圍站上蓋商場)",
            "customerNoRaw":null,"shortCodeRaw":null,"doctorRaw":"Dr Lau Ho Yin"},
  "docNoRaw":"IN194756","docNoLabel":"Invoice No.","dateRaw":"28/8/2026","date":"2026-08-28",
  "groups":[{"patientNameRaw":"L.S.C.","patientCodeRaw":"7159","labCaseRef":null,"lines":[
     {"description":"Add. tooth or clasp (First unit) Upper & Lower","qty":2,"unitPrice":250,"listPrice":null,"discountRaw":null,"amount":500},
     {"description":"Add SS Wire Clasp","qty":1,"unitPrice":50,"listPrice":null,"discountRaw":null,"amount":50}]}],
  "statementLines":[],"subtotal":null,"discountRaw":null,"discountAmount":null,"total":550,
  "readIssues":["Lab 名第一個字被切（…odwill）"] }
```

**G2 KEA（打橫 90°、冇 invoice 號、有 D/C%）**
```json
{ "kind":"INVOICE",
  "lab":{"nameRaw":"KEA DENTAL SOLUTIONS LTD","nameCnRaw":null,"payeeRaw":null},
  "billTo":{"nameRaw":"Artisan Dental Limited (TW)","addressRaw":"Shop 418, Wai Fong, 18 Che Kung Miu Road, Tai Wai, New Territories, Hong Kong",
            "customerNoRaw":null,"shortCodeRaw":"TW","doctorRaw":"HO KA CHUN"},
  "docNoRaw":"0254131","docNoLabel":"Case No.","dateRaw":"2026-08-05","date":"2026-08-05",
  "deliveryDate":"2026-08-05","orderReceivedDate":"2026-07-31",
  "groups":[{"patientNameRaw":"L.W.K.","patientCodeRaw":"7595","labCaseRef":"0254131","lines":[
     {"description":"Zirconia Crown(Monolithic)","qty":1,"unitPrice":440,"listPrice":550,"discountRaw":"80.00","amount":440}]}],
  "statementLines":[],"subtotal":null,"discountRaw":null,"discountAmount":null,"total":440,"readIssues":["文件打橫"] }
```
注意：`D/C % 80` 係「收 80%」（550 × 0.8 = 440），唔係「減 80%」。

**G3 Modern（有客戶編號）**
```json
{ "kind":"INVOICE",
  "lab":{"nameRaw":"Modern Dental Laboratory Co.,Ltd.","nameCnRaw":"現代牙科器材有限公司","payeeRaw":"Modern Dental Laboratory Company Limited"},
  "billTo":{"nameRaw":"Artisan Dental Clinic 臻善牙科","addressRaw":"大圍車公廟路18號圍方418號鋪","customerNoRaw":"N1017",
            "shortCodeRaw":null,"doctorRaw":"Dr. Wang Wing Nga"},
  "docNoRaw":"I260120289","docNoLabel":"Invoice No.","dateRaw":"03/09/2026","date":"2026-09-03",
  "groups":[{"patientNameRaw":"H.S.Y.","patientCodeRaw":"2494","labCaseRef":"DT9003874","lines":[
     {"description":"7251 Thermoformed Retainer with features/ Stablising splint","qty":1,"unitPrice":290,"listPrice":null,"discountRaw":null,"amount":290}]}],
  "statementLines":[],"subtotal":290,"discountRaw":null,"discountAmount":null,"total":290,
  "readIssues":["病人行開頭有另一個編號 0321231O（最後一個字似 O 或 0）"] }
```

**G4 Sodental（頁頂切咗、有 $0 行、有銀行資料、收款人唔同名）**
```json
{ "kind":"INVOICE",
  "lab":{"nameRaw":"SODENTAL COMPANY LIMITED","nameCnRaw":null,"payeeRaw":"HONESTY GIFTS INT'L LIMITED"},
  "billTo":{"nameRaw":"ARTISAN DENTAL臻善牙科","addressRaw":"新界大圍車公廟路18號圍方418號鋪（港鐵大圍站上蓋商場）",
            "customerNoRaw":null,"shortCodeRaw":null,"doctorRaw":"Dr. Lau Ho Yin 劉浩賢醫生"},
  "docNoRaw":"INV-260805010","docNoLabel":"INVOICE#","dateRaw":"2026-08-05","date":"2026-08-05",
  "groups":[{"patientNameRaw":"H.C.L.","patientCodeRaw":"2886","labCaseRef":null,"lines":[
     {"description":"3D列印模型（種植）","qty":2,"unitPrice":0,"listPrice":null,"discountRaw":null,"amount":0},
     {"description":"純鈦基牙+種植上部愛爾創全鋯","qty":1,"unitPrice":560,"listPrice":null,"discountRaw":null,"amount":560},
     {"description":"替代體","qty":1,"unitPrice":0,"listPrice":null,"discountRaw":null,"amount":0}]}],
  "statementLines":[],"subtotal":null,"discountRaw":null,"discountAmount":null,"total":560,
  "readIssues":["頁頂公司名被切，由底部文字同印章得知係 SODENTAL","銀行資料已略過"] }
```

---

## 6. 角色 B：確認 invoice 頭（Lab、診所、單號）

### 6.1 Lab 識別（依次，搵到就停）

1. `LabNameAlias`：正規化 `lab.nameRaw`（轉細階、去標點同 `limited|ltd|co|company|laboratory|lab|dental` 等字）後完全吻合 → 揀嗰間，依據＝ALIAS。
2. 同 `Lab.name` 正規化後互相包含 → 揀嗰間，依據＝NAME。多過一間吻合 → 當搵唔到。
3. 搵唔到 → 員工喺下拉揀（或揀「Others」＝`labOther`）；員工確認後寫入 `LabNameAlias`，依據＝MANUAL。

### 6.2 診所識別（依次，搵到就停）

1. `billTo.customerNoRaw` 有值，而且 `LabCustomerAlias(labId, customerNo)` 有記錄 → 揀嗰間，依據＝CUSTOMER_NO。
2. 地址：`billTo.addressRaw` 同每間 `Clinic.address` 比對（中英文都要試；比較街道名＋門牌號，例如「車公廟路18號」、「Che Kung Miu Road」＋「18」）。**只有一間**吻合先揀，依據＝ADDRESS。
3. 簡稱：`billTo.shortCodeRaw`（例如 TW）同 `Clinic.shortName` 或已知英文簡稱吻合 → 依據＝SHORT_CODE。
4. 都唔得 → 員工揀，依據＝MANUAL。
5. 員工確認診所時，如果有 `customerNoRaw`，寫入 `LabCustomerAlias`。
6. **唔准默認上傳者主屬店**。畫面要寫明依據（例如「依據：地址『車公廟路18號』」）。
7. 員工改咗系統揀嘅診所 → 記 audit；如果係覆蓋一個已學識嘅 `LabCustomerAlias`，要確認「以後都用新診所？」。

> 模擬注意：真實 `Clinic.address` 你冇。大圍嘅地址用 invoice 上嘅「新界大圍車公廟路18號圍方418號舖」；其他店用 fixture（§11）嘅假地址，並喺報告註明「其他店地址未驗證」。

### 6.3 單號同重複檢查

1. `docNoLabel` 係 invoice 號類（`Invoice No.`、`INVOICE#`）→ `docNoKind = INVOICE_NO`。
2. 冇 invoice 號但有 `Case No.` → `docNoKind = CASE_NO`（Q3，你要評估呢個做法）。
3. 正規化：去空格、轉大階。
4. 有 `docNo` → 同一 Lab 同一 `docNo`（未作廢）已存在 → **擋**：「呢張 invoice 已經喺 {日期} 由 {人} 上傳過」，可以撳去睇嗰張。
5. 冇 `docNo` → 搵同一 Lab、同一日期、同一病人編號、同一總數嘅 invoice → 有就**提示唔擋**（D10）。

### 6.4 確認頭部嘅員工操作

- 可以改：Lab、診所、單號、日期、每一行（描述、數量、單價、金額）、增刪行、將一行搬去另一個病人分組、增刪病人分組。
- §5.4 加總檢查唔過 → 「確認」掣唔可以撳。
- 確認後狀態 `NEEDS_REVIEW → CONFIRMED`，寫 `LAB_DOC_CONFIRM`（before＝AI 原始值，after＝確認值，只記有改嘅欄位）。

---

## 7. 角色 B：逐個病人核對（invoice）

### 7.1 病人編號正規化

- `patientCodeRaw` 只留數字，去前置 0（**Q2**：你要喺報告講呢個假設啱唔啱）。
- 同 `CostCase.patientCode` 用同一個方法正規化後比較。

### 7.2 揀病人（每個分組）

1. 有編號 → 搵 `CostCase.patientCode` 吻合嘅病人。
   - 吻合一個病人 → 自動揀好，顯示「編號吻合」。
   - 吻合多過一個（唔同病人同編號，理論上唔應該）→ 唔自動揀，要員工揀，記 finding。
2. 冇編號，或者搵唔到 → 員工搜尋（編號或姓名，同現有成本錄入搜尋一樣）。
   - **唔好自動用姓名配對**：invoice 係英文拼音（L.S.C.），系統可能係中文姓名。
3. 員工可以揀「呢個病人暫時唔處理」→ 分組保持 UNMATCHED。

### 7.3 候選成本（揀咗病人之後）

```
CostCase WHERE patientCode = 已揀病人
  AND labId = invoice.labId          ← 唔同 Lab 嘅唔列
  AND status <> 'VOID'
  AND labDocumentId IS NULL          ← D8：已經對咗其他 invoice 嘅唔列
ORDER BY orderedAt DESC
（唔限月份；唔限診所，但診所唔同要顯示警告「成本喺 {店}，invoice 係 {店}」）
```

每個候選顯示：落單月、項目（itemType）、醫生、錄入金額（或「未有價」）、狀態、是否已出月結。

### 7.4 行對應（D15）

- 分組內所有行**預設剔選**。
- 候選只有 **1 筆** → 所有已剔行預設對應佢。
- 候選 **多過 1 筆** → 冇預設，員工逐行揀（下拉）。
- 候選 **0 筆** → 顯示「新增成本」（§7.6）同「搵其他病人」。
- 取消剔選嘅行 → 保持 UNMATCHED（例如另一件器材未到／唔屬呢個病人）。
- 一行只可以對一筆成本；一筆成本可以收多行，**但只可以嚟自同一張 invoice**（D8）。

### 7.5 核對每筆被對應嘅成本

`invoiceSum = Σ 對應去呢筆成本嘅行 amount`（$0 行計 0）

| 情況 | 顯示 | 員工可做 |
|---|---|---|
| `baseCost = invoiceSum` | 一致 | — |
| `baseCost ≠ invoiceSum`，未鎖 | 金額唔同（錄入 $X · invoice $Y） | 「改做 $Y」（D2） |
| `baseCost = null`，未鎖 | 未有價 | 「填入 $Y」 |
| `lockedByRunId ≠ null` | 已出月結 | 唔改價；差額入待處理「下期調整」（Q4：可唔可以照連 invoice？） |
| `status = REDO` | 重做中 | 你判斷應唔應該可以對應，寫 finding |

「改做／填入」會：
- `baseCost = invoiceSum`，按現有規則重算 `discountPct`、`finalCost`（**留意 Q1**）
- `status`：`PENDING → PRICED`（如原本係 PENDING）
- audit `LAB_DOC_PRICE_UPDATE`：before／after `baseCost`、`finalCost`，notes 記 documentId、行 id

### 7.6 新增成本（D7）

- 預填：`clinicId`＝invoice 診所、`labId`、`patientCode`、`patientName`（用系統病人資料，唔用 invoice 拼音）、`labOrderNo`＝`labCaseRef`、`baseCost`＝`invoiceSum`、`category`＝`LAB`。
- 員工一定要揀：**醫生**（下拉）、項目類型（itemType）。`orderedAt` 預設 invoice 日期，員工可改。
- **唔填 `receivedAt`**（D3）。
- audit `LAB_DOC_CASE_CREATE`。

### 7.7 儲存

- 每個分組可以獨立儲存。
- 儲存時：行 `MATCHED` 寫 `costCaseId`；成本寫 `labDocumentId`；audit `LAB_DOC_LINE_MATCH`。
- 狀態：全部行 `MATCHED` 或 `IGNORED` → `RECONCILED`；有部分 → `PARTIAL`。
- 員工可以將 $0 行或唔相關嘅行標 `IGNORED`（要揀原因：$0／唔屬本集團／其他）。

### 7.8 作廢同重做（D12）

- 員工作廢一筆已連 invoice 嘅成本 → 提示「呢筆成本已對應 {invoice}，作廢後嗰幾行會變返未對」→ 確認後：成本 `labDocumentId = null`、行 `UNMATCHED`、audit `LAB_DOC_LINE_UNMATCH`。
- 之後員工喺 invoice 重新將嗰幾行對去新開嘅成本。
- 作廢成本本身行現有流程（唔屬今次範圍）。

### 7.9 作廢 invoice

- 只可以喺冇任何行 `MATCHED` 時作廢（有就要先解除對應）。
- 要填原因，audit `LAB_DOC_VOID`。作廢後 `docNo` 可以再用（重新上傳正確版本）。

---

## 8. 角色 B：月結單

### 8.1 上傳

- 「月結單」分頁；**多頁＝一份**；員工或經理都可以（D14）。
- Lab、診所識別同 §6.1、§6.2。
- `statementMonth`：用月結單上嘅月份；冇就用最後一行日期嘅月份，並標黃。
- 重複：同一 Lab、同一診所、同一 `statementMonth`（未作廢）已有 → 擋，可以揀「取代舊版」（舊版變 VOID，要原因）。

### 8.2 逐行對系統 invoice

對每條 `statementLine`：
1. 有 `docNo` → 搵同 Lab、同診所、`docNo` 相同嘅 INVOICE（未作廢）。
2. 冇 `docNo`，或第 1 步搵唔到 → 搵同 Lab、同診所、同日期、同金額嘅 INVOICE；如果有病人資料再加病人編號過濾。唯一先算吻合。
3. 結果：
   - 吻合、金額一樣 → `MATCHED`
   - 吻合、金額唔同 → `AMOUNT_DIFF`（顯示兩個數，可以撳入去睇 invoice 相）
   - 搵唔到 → `MISSING_IN_SYSTEM`（可以即場補上傳 invoice）

反方向：同 Lab、同診所、`docDate` 喺 `statementMonth` 入面、但冇被任何月結單行吻合嘅 INVOICE → 「月結單冇（可能入下月）」。之後嘅月結單再吻合到就自動消失；**連續兩張月結單**都冇 → 入待處理（Q5）。

### 8.3 總數同折扣檢查

| 檢查 | 公式 | 唔一致時 |
|---|---|---|
| 總數 | 月結單 `subtotal`（或 `total`）vs Σ 已吻合 invoice 嘅 `grossTotal` | 顯示差額；列出令差額出現嘅行 |
| 折扣 | 月結單有折扣（`discountRaw` 或 `discountAmount`）→ 折扣% vs `LabMonthlyDiscount(lab, month)` | **只提示**，唔自動改設定；未設定就提示去設定 |
| 淨額 | 月結單 `total` vs Σ 相關成本嘅 `finalCost` | 顯示差額（**Q1 嘅關鍵證據**） |

### 8.4 月結單確認

- 員工確認後 `RECONCILED`（即使有差異，差異入待處理），audit `LAB_STATEMENT_RECONCILE`（notes 記各類數量同差額）。

---

## 9. 待處理清單、權限、保留期

### 9.1 待處理清單（有 `lab_invoice` 權限都睇到；可以按 Lab、診所、月份篩）

1. invoice 有、未對成本嘅行（UNMATCHED，排除 IGNORED）
2. 成本已到貨（`receivedAt` 有值）、冇對 invoice（`labDocumentId` null）、`status <> VOID`
3. 月結單有、系統冇嘅 invoice（`MISSING_IN_SYSTEM`）
4. 金額唔同但已出月結、要下期調整
5. 連續兩張月結單都冇出現嘅 invoice

### 9.2 權限 `lab_invoice`

| 動作 | `lab_invoice` | `cost_entry` | 兩者都冇 |
|---|---|---|---|
| 上傳 invoice／月結單 | ✅ | ❌（除非另有 `lab_invoice`） | ❌ |
| 確認讀取內容、對應、儲存 | ✅ | ❌ | ❌ |
| 經對數流程改價、填價、新增成本 | ✅ | ❌ | ❌ |
| 喺成本錄入頁直接改任何成本欄位 | ❌ | ✅（現有） | ❌ |
| 睇待處理清單 | ✅ | ✅ | ❌ |

- 範圍：**同公司所有診所**（員工會調鋪）。你要評估有冇跨公司風險。
- 所有寫入都要喺伺服器檢查權限同 `lockedByRunId`，唔信前端。

### 9.3 保留期（D5）

- `imagePurgeAt = createdAt + 24 個月`；每晚批次刪相片，audit `LAB_DOC_IMAGE_PURGE`。
- 刪相後保留：`extractedJson`、已確認數字、行、對應關係。
- 行入面嘅 `patientNameRaw` 跟現有病人姓名清除規則（你評估要唔要一齊清）。

---

## 10. 角色 C：員工操作記錄方法

每份文件，記錄：

| 欄位 | 說明 |
|---|---|
| 撳掣次數 | 由開「對數」頁到儲存，包括揀相、揀下拉、剔選、確認 |
| 需要人手輸入嘅欄位 | 例如搜尋病人、改金額、揀醫生 |
| 猶豫點 | 員工可能唔知點做、要問人、要返去睇張單嘅地方 |
| 錯誤風險 | 員工容易揀錯嘅地方（例如兩筆候選成本好似） |
| 預計時間 | 熟手員工大約幾耐完成（秒） |

目標：**一張一個病人、編號吻合、金額一致嘅 invoice，應該 ≤ 5 下完成**。做唔到要寫 finding。

---

## 11. Fixture：模擬用系統資料

用戶會另外上傳真實 invoice 同月結單。你要按以下方法砌一套「系統原本已有嘅資料」，令每個情境（§13）都行得到。**全部用假資料，但病人編號同 Lab 用返 invoice 上嘅，先對得上。**

### 11.1 固定部分

```
Clinic:
  c_tw   大圍    shortName TW   address 新界大圍車公廟路18號圍方418號舖
  c_ymt  油麻地  shortName YMT  address（假）九龍油麻地彌敦道 XXX 號
  c_mf   美孚    shortName MF   address（假）九龍美孚新邨 XXX
  c_yl   元朗    shortName YL   address（假）
  c_tkw  土瓜環  shortName TKW  address（假）
  c_ty   青衣    shortName TY   address（假）
Provider:  p_lau Dr Lau Ho Yin · p_ho Dr Ho Ka Chun · p_wang Dr Wang Wing Nga · 另加 2 個假醫生
Lab:       l_goodwill Goodwill · l_kea KEA · l_modern Modern · l_sodental Sodental · ＋用戶新單出現嘅 Lab
LabMonthlyDiscount: 暫時全部唔設（Q1 由月結單證據決定）；另外砌一個情境有設 8.5%
LabNameAlias／LabCustomerAlias：開始時全部空（模擬「第一次用」）；第二輪再行一次，模擬「已學識」
PayoutRun：2026-07 LOCKED；2026-08 DRAFT；2026-09 DRAFT
```

### 11.2 CostCase：按每張 invoice 砌

對每張 invoice 嘅每個病人分組，**輪流**砌以下其中一種，確保每種都出現最少一次：

| 代號 | 砌法 | 觸發 |
|---|---|---|
| F-EXACT | 一筆成本，`baseCost` = invoice 分組合計 | 一致 |
| F-DIFF | 一筆成本，`baseCost` = invoice 合計 + 50（或用 list price） | 金額唔同 |
| F-NULL | 一筆成本，`baseCost` = null | 未有價 |
| F-NONE | 冇成本 | 新增 |
| F-TWO | 兩筆成本（同病人同 Lab），只有一筆係今張 invoice 嘅器材 | 部分到貨 |
| F-LOCKED | 一筆成本，`periodMonth = 2026-07`、`lockedByRunId` 有值 | 已出月結 |
| F-OTHERCLINIC | 一筆成本，`clinicId` 係第二間店 | 診所唔同警告 |
| F-LINKED | 一筆成本，已經 `labDocumentId` 對咗另一張 invoice | D8 衝突 |
| F-VOID | 一筆作廢嘅 + 一筆新開嘅（重做） | 候選只應該見到新嗰筆 |
| F-CODE | 成本 `patientCode` 格式唔同（例如 `P007159` 或 `07159`） | Q2 |

用一個表列出你砌咗乜，放喺報告最前面。

---

## 12. 角色 D：Finding 格式

每條 finding：

```
ID:          F-01
類別:        規則缺口 | UX 摩擦 | 資料模型 | AI 讀取風險 | 金額正確性 | 權限／私隱 | 併發 | 其他
嚴重度:      P0（會寫錯錢／洩漏資料）| P1（會令對數結果錯或者要人手補救）| P2（麻煩但唔會錯）| P3（改善）
情境:        S-xx / 文件名
發生咩事:    …
證據:        （JSON 片段、fixture、步驟）
點解係問題:  …
建議修改:    （具體到本文件第幾節要點改）
```

---

## 13. 必須行嘅情境

用用戶上傳嘅文件行；某情境冇合適文件就用 §5.5 嘅 golden 或者自己改一張（註明）。

| # | 情境 | 重點 |
|---|---|---|
| S1 | 一個病人、編號吻合、金額一致 | 撳掣次數（目標 ≤ 5） |
| S2 | 金額唔同 → 撳一下改價 | `finalCost` 點重算；Q1 |
| S3 | 未有價 → 填入 | 狀態轉換 |
| S4 | 冇成本 → 新增（揀醫生） | 預填欄位夠唔夠；orderedAt 用乜 |
| S5 | 一張 invoice 兩個病人 | 分組、部分儲存、加總 |
| S6 | 部分到貨（F-TWO） | 員工會唔會揀錯；未到嗰筆點處理 |
| S7 | 8 月 invoice 9 月先上傳，8 月未鎖 | 候選唔限月份 |
| S8 | 對應已出月結嘅成本 | Q4；待處理「下期調整」 |
| S9 | 同一張 invoice 上傳兩次 | 擋 |
| S10 | 冇 invoice 號（KEA）重複上傳 | Q3；軟提示 |
| S11 | 診所識別：客戶編號、地址、簡稱、全部失敗 | 依據顯示；學識 alias；第二輪 |
| S12 | Lab 名搵唔到 → 人手揀 → 學識 | 第二輪自動 |
| S13 | 重做：已連 invoice 嘅成本被作廢 → 重新對應新成本 | 行變返未對 |
| S14 | 成本已經對咗另一張 invoice（F-LINKED） | D8 會唔會令正常情況做唔到（例如 Lab 補收費） |
| S15 | AI 讀錯一行金額 → 加總唔啱 | 擋確認；員工點樣搵到錯邊行 |
| S16 | 一頁讀唔到 → 人手輸入 | 人手輸入畫面要乜欄位 |
| S17 | 一個 PDF 入面 4 張唔同 Lab 嘅 invoice | 一頁一張；Lab 各自識別 |
| S18 | 月結單：吻合、系統冇、金額唔同、月結單冇 | 四類都要出現 |
| S19 | 月結單總數、折扣、淨額檢查 | Q1 最終結論 |
| S20 | AI 將一行放錯病人分組 | 員工點搬 |
| S21 | 病人編號格式唔同（F-CODE） | Q2 |
| S22 | 兩個員工同時對應同一筆成本到兩張唔同 invoice | 伺服器點擋（D8 唯一性）；第二個人見到乜 |
| S23 | 兩個員工同時上傳同一張 invoice | 唯一性；第二個人見到乜 |
| S24 | 24 個月後刪相 | 刪咗之後邊啲畫面會壞（例如「睇返張 invoice 相」） |
| S25 | 私隱：invoice 上嘅銀行資料、病人全名 | 有冇被存；log 有冇印出 |
| S26 | 冇 `lab_invoice` 權限嘅員工直接 call API | 應該 403 |
| S27 | 員工幫唔係自己主屬店嘅診所上傳 | 診所識別正確；權限範圍 |
| S28 | Sodental 收款人同 Lab 名唔同 | Q6 |

---

## 14. 報告格式（你最後要交嘅嘢）

1. **Fixture 表**（§11 你砌咗乜）
2. **逐份文件記錄**：每份一節
   - 角色 A：JSON（完整）＋ `readIssues`
   - 角色 B：自動檢查結果、Lab／診所識別（依據）、單號／重複檢查、分組、候選、預設對應、核對結果
   - 角色 C：員工決定、撳掣次數、猶豫點、預計時間
   - 寫入結果：每個資料表嘅變更（before → after）＋ audit
3. **月結單記錄**：逐行對應表＋總數／折扣／淨額檢查
4. **待處理清單最終狀態**
5. **Q1–Q6 結論**：每條附證據同建議
6. **Findings**（§12 格式），按嚴重度排
7. **指標**：
   - 每張 invoice 平均撳掣次數、平均時間
   - AI 讀取：欄位總數、讀錯數、讀漏數（有 Qwen 就分開列）
   - 自動揀中率：Lab、診所、病人、候選成本
   - 需要人手改嘅欄位 Top 5
8. **設計修改建議總表**：「本文件第幾節 → 改成點」，方便之後寫實作 MD

---

## 15. 唔屬今次模擬範圍

- 實際寫代碼、改 DB、改 wa-inbox proxy
- 醫生月結（PayoutRun）計算本身
- 「下期調整」點樣開（現有 payout-adjustments 功能），只需要指出邊啲情況會產生
- Apricot 帳單連結（`BILL_LINKED`）
