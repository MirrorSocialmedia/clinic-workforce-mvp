# 施工單：Lab 單據對數（cwm-labdoc）

> 版本：v1（2026-10-04）· 基準 commit：`58872f9`（branch `claude/qa-agent-workflow-simulation-fee31s`）
> 前置文件：
> - 模擬規格 `docs/simulations/lab-invoice-reconciliation-simulation.md`
> - QA 模擬報告 `docs/simulations/2026-09-28-lab-invoice-reconciliation-qa-report.md`（下稱「QA 報告」，F-xx 指嗰度嘅 finding）
> - 設計稿（流程圖＋畫面）：https://claude.ai/artifact/VQteYotkyQbWpKoQ3h8ZKT
>
> 呢份係**施工單**：寫明要建乜、點樣算啱。所有「拍板」已由老細確認（§0.2），施工時唔使再問；遇到本單冇講嘅情況，照 §0.4 處理。

---

## 0. 總覽

### 0.1 目標

1. **每次到貨**：診所員工用手機影 invoice（或者上傳 Lab email 嘅 PDF）→ 系統讀單 → 員工逐個病人將 invoice 行對去「成本錄入」嘅成本記錄（一致／改價／填價／新增），順手確認到貨日。
2. **每月月結單**：上傳月結單 → 系統按「Lab × 診所 × 醫生 × 月」切段 → 逐段同系統已對嘅 invoice 比較**數量、單價、金額同總數** → 經理逐段確認 → 差異入待處理。
3. **存底**：每一張 invoice 同月結單嘅原檔都保存 **7 年**，喺「檔案庫」搵得返、睇得到，亦可以由成本記錄、月結單、待處理直接打開。

### 0.2 已拍板（照做）

| # | 決定 | 來源 |
|---|---|---|
| B1 | 月結單對數單位 = **Lab × 診所 × 醫生 × 月** | 老細 |
| B2 | **每張 invoice 都要有醫生**；單上有醫生名就自動揀，第一次人手揀之後記住 | 設計稿決定 2 |
| B3 | 對數深度跟 Lab 月結單格式：**明細型逐行**（數量、單價、金額）；**單號型逐張**（金額）；**欠款型只對本月**，舊欠只查之前有冇對過 | 決定 3 |
| B4 | **已連 invoice 嘅成本唔再套 `LabMonthlyDiscount`**（`finalCost = baseCost`），包括成本錄入頁、POST、recompute 三條舊路 | 決定 4、F-01 |
| B5 | 對 invoice 時問「器材收到未」，預設單上日期，**要員工撳先算**；冇確認入待處理 | 決定 5、F-12 |
| B6 | 月結單同 invoice 唔同 → **預設以 invoice 為準**，差額入待處理跟進；經理可揀「以月結單為準」改系統，**一定要寫原因** | 決定 6 |
| B7 | 一筆成本**可以連多張 invoice**，第二張起要標「補收費」或「重做」；**一條 invoice 行只可以連一筆成本** | 決定 7、F-14（取代舊 D8） |
| B8 | 原檔保留 **7 年**；到期刪檔，同時清走讀單結果入面嘅病人姓名；金額、單號、配對紀錄保留 | 老細、F-15 |
| B9 | 上傳頁提示「唔好影到支票」；系統偵測到支票要求裁走 | 決定 9、F-02 |
| B10 | 新權限：`lab_invoice`（員工可 grant）、`lab_statement`（經理）。月結單確認、「以月結單為準」、取代舊版、Lab 設定要 `lab_statement` | 決定 10 |
| B11 | **每張 invoice 同月結單原檔都要存底，並有地方睇** | 老細 2026-10-04 |
| B12 | 新增 Lab：**Excel**（Excel Dental Lab Limited） | 老細 |
| B13 | 病人編號正規化 = **診所前綴＋6 位數字**（例 `TW007159`），唔准淨係比數字 | F-07 |
| B14 | 單號、Lab 編號、病人編號欄**唔做**「似銀行號碼」刪除；改用銀行格式規則（§5.6） | F-03 |
| B15 | 儲存全部單一 transaction＋條件寫入＋冪等鍵；撳兩下唔會多一筆 | F-04 |
| B16 | 範圍：`lab_invoice`／`lab_statement` 用 `resolveClinicScope(..., { companyWide })` → **全部診所**（員工跨公司上班，同排班一樣，老細 2026-09-17 原則） | F-17 |
| B17 | 舊拍板 D3（唔自動填到貨日）由 B5 取代；D5（24 個月）由 B8 取代；D8 由 B7 取代；D12（作廢再開新）由 B7 取代：重做用現有 `REDO` 狀態＋連「重做」invoice，跟 schema 拍板① | 整合 |

### 0.3 範圍外

- 付款（開支票、FPS）、Lab 帳齡管理。只**顯示**欠款型 Lab 嘅「之前已對・未付」，唔記付款。
- 醫生月結（PayoutRun）計算本身、「下期調整」嘅開單流程（用現有 payout-adjustments；本單只列入待處理並提供連結）。
- Apricot 帳單連結（`BILL_LINKED`）。

### 0.4 本單冇講到嘅情況

唔好靜靜揀一個做法：揀**最保守**（唔寫錢、唔自動配對、交人決定），喺 PR 描述列出「本單未覆蓋：…」。

---

## 1. 名詞

| 名詞 | 意思 |
|---|---|
| 原檔 | 上傳嘅檔案本身（相片轉成嘅 JPEG，或者 PDF 原 bytes）。存底用，唔改 |
| 頁 | 原檔嘅一頁（相片＝1 頁；PDF 有 N 頁） |
| 單據（LabDocument） | 一張 invoice 或一份月結單。invoice 可以由 1 頁或幾頁組成；月結單通常多頁 |
| 分組 | invoice 入面同一個病人嘅行 |
| 分段（Section） | 月結單入面同一個「診所＋醫生」嘅部分 |
| 帳戶 | Lab 對我哋嘅客戶身份；實際 = 診所＋醫生（Modern 會有客戶編號，例 N1008） |
| 明細型／單號型／欠款型 | 月結單格式（§2.3） |
| 已對 invoice | 狀態 CONFIRMED 之後嘅 invoice（有 Lab、診所、醫生、日期、行） |

---

## 2. 流程

### 2.1 循環一：每次到貨（`lab_invoice`，手機為主）

```
Lab 送貨＋invoice
  → 員工：影相（可連影幾張）或上傳 PDF
  → 系統：存原檔（加密）→ 建 LabDocument(UPLOADED) → 背景讀單（EXTRACTING）
      PDF 有文字層 → 抽文字 → LLM（文字模式）
      相片／冇文字層 PDF → LLM（圖片模式）
  → 系統：驗證（§5.5）→ 自動識別 Lab、診所、醫生（§6）→ NEEDS_REVIEW
  → 員工：確認頭部（可改）→ CONFIRMED
  → 員工：逐個病人分組：揀病人（編號自動）→ 揀成本 → 一致／改價／填價／新增／忽略 → 確認到貨日
  → 系統：每組儲存（單一 transaction）→ 全部行 MATCHED/IGNORED = RECONCILED，否則 PARTIAL
```

### 2.2 循環二：每月月結單（上傳 `lab_invoice`；確認 `lab_statement`）

```
Lab 寄月結單（PDF／紙）
  → 上傳（多個檔＝一份）
  → 系統：存原檔 → 讀單 → 切分段（每段一個 診所＋醫生）→ 自動識別每段診所、醫生
  → 系統：每段配對系統已對 invoice（§8），出逐行結果
  → 經理：逐段睇差異 → 補上傳缺嘅 invoice／人手配對／揀處理方法（B6）→ 確認分段
  → 系統：全部分段確認 → 月結單 RECONCILED；未解決差異入待處理
```

### 2.3 五間 Lab 嘅已知格式（Seed 入 `LabProfile`）

| Lab | invoice 單號 | 月結單類型 `statementKind` | 月結單單號＝invoice 單號？ | 病人資料點寫 | 已知收款人 |
|---|---|---|---|---|---|
| Goodwill（佳譽牙科器材有限公司） | `IN194756`（INVOICE_NO） | `INVOICE_LIST`：DocNo、Date、Invoice Amount、Amount Paid、Outstanding；每張一醫生 | 係 | 「姓名 7159」：名後 4–5 位 | Goodwill Dental Laboratory Limited |
| KEA（KEA Dental Solutions） | 冇；`Case No. 0254131`（CASE_NO） | 未見 → `INVOICE_LIST` | 未知 | `#7595`；有 List Price＋D/C%（收 xx%）＋U'Price | 未見 |
| Modern（現代牙科器材） | `I260120289` | `INVOICE_LIST`：有 DEBIT／CREDIT／BALANCE（累計）欄；每客戶編號一張 | **未核實**（月結單用 `IN-MDL2001313043`）→ 預設 `false` | `#2494(DT9003874)`；DT 號＝Lab 編號 | Modern Dental Laboratory Company Limited |
| Sodental（禾呈牙科器材） | `INV-260925010`／`INV-26081802`（長度唔固定） | `DETAIL`：產品結算表，每頁一醫生，逐項：病人、項目、牙位、單位、單價、數量、總額；INVOICE# 係合併儲存格 | 係 | 名後數字（`1443`、`TY9845`），有時冇 | HONESTY GIFTS INT'L LIMITED（大圍）、SODENTAL COMPANY LIMITED（土瓜灣） |
| **Excel**（Excel Dental Lab Limited）新 | `202609-0811` | `OUTSTANDING`：Sep-26 Outstanding Statement，列晒未付單＋分齡（Current Mth／31–90／91–365／over 1-year）；每醫生一張 | 係 | 「姓名 1486 0172649」：4 位＝病人編號，最後 7 位＝Lab 編號；有時冇病人編號 | Excel Dental Lab Limited |

> 診所：大圍 = 臻善 Artisan（新界大圍車公廟路18號圍方418號舖）；土瓜灣 = 滙樂 Aegis（九龍土瓜灣馬頭角道37號地下3號舖）。**品牌唔可以用嚟分店**。

---

## 3. 資料模型（`apps/web/prisma/schema.prisma`）

> migration 名：`20261005000000_labdoc_core`（P1）、`20261012000000_labdoc_statement`（P3）。partial unique index 用 raw SQL（先例：`20260926000000_w5f3_writelog_hash_clinic_shortname`），並喺 schema 註釋寫明「index 由 migration 管」。

### 3.1 新表

```prisma
/// ★ cwm-labdoc：Lab 單據原檔（存底）。內容加密存喺 LAB_DOC_DIR；DB 只存 metadata。
model LabFile {
  id            String    @id @default(cuid())
  sha256        String                       // 原檔（加密前）hash；同一檔重複上傳偵測
  mime          String                       // image/jpeg | application/pdf
  sizeBytes     Int
  pageCount     Int
  hasTextLayer  Boolean   @default(false)    // PDF 每頁都有文字 → true
  storageKey    String    @unique            // 相對 LAB_DOC_DIR：'2026/10/<id>.bin'
  encKeyId      String                       // 'k1'（換 key 用）
  pagesJson     Json                         // [{ page:1, displayKey, thumbKey, width, height, textChars }]
  originalName  String?                      // 已清理：只留副檔名前 80 字，去路徑
  uploadedBy    String
  uploadedAt    DateTime  @default(now())
  purgeAt       DateTime                     // uploadedAt + 7 年（B8）
  purgedAt      DateTime?
  pages         LabDocumentPage[]

  @@index([sha256])
  @@index([purgeAt, purgedAt])
}

/// 單據由邊幾頁組成（一個 PDF 可以拆成幾張 invoice；幾張相可以合併做一張）
model LabDocumentPage {
  id          String      @id @default(cuid())
  documentId  String
  document    LabDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)
  fileId      String
  file        LabFile     @relation(fields: [fileId], references: [id])
  pageNo      Int                          // 1-based，原檔入面第幾頁
  sortOrder   Int

  @@unique([documentId, fileId, pageNo])
  @@index([fileId])
}

model LabDocument {
  id               String    @id @default(cuid())
  kind             String                    // INVOICE | STATEMENT
  status           String    @default("UPLOADED")
  // UPLOADED | EXTRACTING | EXTRACT_FAILED | NEEDS_REVIEW | CONFIRMED | PARTIAL | RECONCILED | DUPLICATE | VOID
  // STATEMENT 用：UPLOADED | EXTRACTING | EXTRACT_FAILED | NEEDS_REVIEW | IN_PROGRESS | RECONCILED | SUPERSEDED | VOID

  // —— 頭部（AI 值寫入後可被員工改；AI 原值留喺 extractedJson）——
  labId            String?
  lab              Lab?      @relation(fields: [labId], references: [id])
  labNameRaw       String?
  labBasis         String?                   // ALIAS | NAME | MANUAL
  clinicId         String?
  clinicBasis      String?                   // CUSTOMER_NO | CLINIC_ALIAS | ADDRESS | SHORT_CODE | NAME | MANUAL
  clinicEvidence   String?                   // 原文片段（≤120 字）
  providerId       String?                   // INVOICE 用；STATEMENT 每段自己有
  providerBasis    String?                   // CUSTOMER_NO | DOCTOR_ALIAS | NAME | MANUAL
  providerEvidence String?
  customerNoRaw    String?
  docNo            String?                   // 正規化（§6.4）
  docNoKind        String?                   // INVOICE_NO | CASE_NO
  docDate          DateTime? @db.Date
  deliveryDate     DateTime? @db.Date
  orderReceivedDate DateTime? @db.Date
  statementMonth   String?                   // 'YYYY-MM'（STATEMENT）
  statementKind    String?                   // DETAIL | INVOICE_LIST | OUTSTANDING（STATEMENT，抄 LabProfile）
  subtotal         Decimal?  @db.Decimal(12,2)
  total            Decimal?  @db.Decimal(12,2)
  payeeRaw         String?
  payeeIsNew       Boolean   @default(false) // 同 LabAlias(PAYEE) 對唔到

  // —— 讀單 ——
  extractSource    String?                   // TEXT | VISION | MANUAL
  extractedJson    Json?                     // AI 原始輸出（寫一次，唔改；B8 到期清姓名）
  readIssues       String[]  @default([])
  extractAttempts  Int       @default(0)
  extractError     String?
  heartbeatAt      DateTime?
  manualAmountEdit Boolean   @default(false) // 員工改過任何金額／總數（F-05）→ 入待處理「人手改數待覆核」
  amountReviewedBy String?
  amountReviewedAt DateTime?

  // —— 生命週期 ——
  version          Int       @default(0)     // 樂觀鎖：每次寫 +1；請求要帶
  duplicateOfId    String?                   // DUPLICATE 時指去原本嗰張
  supersededById   String?                   // STATEMENT 取代舊版
  voidReason       String?
  voidedBy         String?
  voidedAt         DateTime?
  uploadedBy       String
  confirmedBy      String?
  confirmedAt      DateTime?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  pages            LabDocumentPage[]
  lines            LabDocumentLine[]
  sections         LabStatementSection[]

  @@index([kind, status])
  @@index([labId, clinicId, providerId, docDate])
  @@index([labId, statementMonth])
  // raw SQL（migration）：
  // CREATE UNIQUE INDEX "LabDocument_invoice_docNo_active" ON "LabDocument"("labId","docNo")
  //   WHERE "kind"='INVOICE' AND "docNoKind"='INVOICE_NO' AND "docNo" IS NOT NULL
  //     AND "labId" IS NOT NULL AND "status" NOT IN ('VOID','DUPLICATE');
}

/// INVOICE 嘅行
model LabDocumentLine {
  id             String      @id @default(cuid())
  documentId     String
  document       LabDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)
  groupIndex     Int                        // 病人分組
  lineIndex      Int
  patientNameRaw String?                    // B8 到期清走
  patientCodeRaw String?                    // 原文（含字母前綴）
  patientCode    String?                    // 正規化（§6.5），例 TW007159
  labCaseRef     String?
  description    String
  toothRaw       String?
  qty            Decimal?    @db.Decimal(10,2)
  unitPrice      Decimal?    @db.Decimal(12,2)
  listPrice      Decimal?    @db.Decimal(12,2)
  discountRaw    String?
  amount         Decimal     @db.Decimal(12,2) // 可以負數（貸項）
  isZero         Boolean     @default(false)
  status         String      @default("UNMATCHED") // UNMATCHED | MATCHED | IGNORED
  ignoreReason   String?                    // ZERO | NOT_OURS | OTHER:<text>
  costCaseId     String?
  costCase       CostCase?   @relation(fields: [costCaseId], references: [id])
  linkType       String?                    // MAIN | SUPPLEMENT | REDO（B7）
  matchedBy      String?
  matchedAt      DateTime?

  @@unique([documentId, groupIndex, lineIndex])
  @@index([costCaseId])
  @@index([patientCode])
}

/// 月結單分段（診所＋醫生）
model LabStatementSection {
  id               String      @id @default(cuid())
  documentId       String
  document         LabDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)
  sectionIndex     Int
  pageFrom         Int?
  pageTo           Int?
  clinicRaw        String?
  doctorRaw        String?
  customerNoRaw    String?
  clinicId         String?
  providerId       String?
  clinicBasis      String?
  providerBasis    String?
  statedTotal      Decimal?    @db.Decimal(12,2) // 呢段喺月結單上嘅總數
  statedCurrent    Decimal?    @db.Decimal(12,2) // OUTSTANDING：本月（Current Mth）
  systemTotal      Decimal?    @db.Decimal(12,2) // 最近一次配對計出嚟
  status           String      @default("PENDING") // PENDING | NEEDS_ASSIGN | DIFF | OK | CONFIRMED
  confirmedBy      String?
  confirmedAt      DateTime?
  note             String?     // ≤200
  lines            LabStatementLine[]

  @@unique([documentId, sectionIndex])
  @@index([clinicId, providerId])
}

model LabStatementLine {
  id                String              @id @default(cuid())
  sectionId         String
  section           LabStatementSection @relation(fields: [sectionId], references: [id], onDelete: Cascade)
  lineIndex         Int
  lineType          String              @default("INVOICE") // INVOICE | CREDIT | PAYMENT | CHARGE | BF
  docNoRaw          String?
  docNo             String?
  date              DateTime?           @db.Date
  patientRaw        String?             // B8 到期清走
  patientCode       String?
  labCaseRef        String?
  description       String?
  toothRaw          String?
  qty               Decimal?            @db.Decimal(10,2)
  unitPrice         Decimal?            @db.Decimal(12,2)
  amount            Decimal             @db.Decimal(12,2)
  agingBucket       String?             // CURRENT | D31_90 | D91_365 | OVER_1Y（OUTSTANDING）
  matchedDocumentId String?
  matchedLineId     String?             // DETAIL：對到嘅 LabDocumentLine
  matchBasis        String?             // DOC_NO | FALLBACK | MANUAL
  result            String              @default("PENDING")
  // PENDING | MATCHED | QTY_DIFF | PRICE_DIFF | AMOUNT_DIFF | MISSING_IN_SYSTEM | PREVIOUSLY_MATCHED | NEEDS_MANUAL | NOT_APPLICABLE
  resolution        String?             // INVOICE_WINS | STATEMENT_WINS | MANUAL_PAIRED | NOT_OURS
  resolutionNote    String?
  resolvedBy        String?
  resolvedAt        DateTime?
  followUpClosedAt  DateTime?           // INVOICE_WINS 跟進完成
  followUpClosedBy  String?

  @@unique([sectionId, lineIndex])
  @@index([matchedDocumentId])
}

/// 每間 Lab 嘅單據設定（§2.3 seed）
model LabProfile {
  labId                      String   @id
  lab                        Lab      @relation(fields: [labId], references: [id], onDelete: Cascade)
  statementKind              String   @default("INVOICE_LIST")
  statementDocNoSameAsInvoice Boolean @default(true)
  defaultDocNoKind           String   @default("INVOICE_NO")
  extractionHint             String?  // ≤500 字，加入 prompt（例：「名後 4 位係病人編號，最後 7 位係 Lab 編號」）
  updatedBy                  String
  updatedAt                  DateTime @updatedAt
}

/// Lab 名／收款人別名（確認一次就記住）
model LabAlias {
  id        String   @id @default(cuid())
  labId     String
  lab       Lab      @relation(fields: [labId], references: [id], onDelete: Cascade)
  kind      String   // NAME_EN | NAME_CN | PAYEE（PAYEE 唔用嚟認 Lab，只用嚟判斷「新收款人」）
  rawNorm   String
  createdBy String
  createdAt DateTime @default(now())

  @@unique([kind, rawNorm])
  @@index([labId])
}

/// Lab 客戶編號 → 診所（＋醫生）。Modern 嘅客戶編號跟醫生。
model LabCustomerNo {
  id         String   @id @default(cuid())
  labId      String
  customerNo String
  clinicId   String
  providerId String?
  createdBy  String
  createdAt  DateTime @default(now())

  @@unique([labId, customerNo])
}

/// 單上診所文字 → 診所（例：「臻善牙科（大圍2）」、「滙樂牙科（AEGIS DENTAL)（土瓜湾）」）
model ClinicNameAlias {
  id        String   @id @default(cuid())
  rawNorm   String   @unique
  clinicId  String
  createdBy String
  createdAt DateTime @default(now())
}

/// 單上醫生文字 → 醫生（例：「dr.esmond tong」、「姚子晴 yiu tsz ching」）
model ProviderNameAlias {
  id         String   @id @default(cuid())
  rawNorm    String   @unique
  providerId String
  createdBy  String
  createdAt  DateTime @default(now())
}

/// 冪等鍵（B15）。同 BookingWriteLog 做法一樣：key + requestHash。
model LabDocWriteLog {
  idempotencyKey String   @id
  requestHash    String
  route          String
  status         String   // IN_PROGRESS | DONE
  responseJson   Json?
  createdBy      String
  createdAt      DateTime @default(now())

  @@index([createdAt])
}
```

### 3.2 改舊表

```prisma
model CostCase {
  // …原有欄位…
  /// ★ cwm-labdoc：大階、去空格、前綴＋6 位（§6.5）。有 index，配對用呢欄。
  patientCodeNorm  String?
  /// ★ cwm-labdoc B4：有任何 MATCHED invoice 行 → true → 唔套 LabMonthlyDiscount
  labInvoiceLinked Boolean  @default(false)
  labLines         LabDocumentLine[]
  @@index([patientCodeNorm])
}
model Lab {
  // …原有欄位…
  profile   LabProfile?
  aliases   LabAlias[]
  documents LabDocument[]
}
```

- Backfill（migration SQL）：`patientCodeNorm` = 用 §6.5 規則由 `patientCode` 計（SQL 版：`upper(trim)`，`^([A-Z]+)0*([0-9]+)$` → 前綴 ＋ `lpad(數字, 6, '0')`；唔符合就 `upper(trim)`）。
- **唔要** `CostCase.labDocumentId`（QA 報告草稿有，B7 改咗做行連成本）。

### 3.3 Seed（migration 或 `prisma/seed-cwm-labdoc-20261005.mjs`，idempotent）

1. Lab：如果冇 `name ILIKE '%excel%'` → 建 `Excel`（sortOrder 排最後）。
2. LabProfile：§2.3 五間（按 name ILIKE 搵 lab id；搵唔到就跳過並 console 警告）。
   - Excel `extractionHint`：「病人欄格式：姓名 [4 位病人編號] [7 位 Lab 編號]；7 位數字係 labCaseRef，唔係病人編號。」
   - Sodental `extractionHint`：「產品結算表：每頁一個醫生；INVOICE# 係合併儲存格，空白行沿用上一個單號；每行要抄牙位、單位、單價、數量、總額。」
   - Modern `extractionHint`：「amount 用 DEBIT 欄，唔好用 BALANCE（累計）欄；CREDIT 欄係貸項（負數）。」
   - KEA `extractionHint`：「D/C % 係收費百分比（80 = 收 80%）；amount 用 U'Price／Amount 欄。」
3. LabAlias：NAME_EN／NAME_CN／PAYEE 用 §2.3 嘅名（正規化見 §6.1）。

### 3.4 狀態機

**INVOICE**

| 由 | 到 | 觸發 |
|---|---|---|
| UPLOADED | EXTRACTING | 背景開始讀 |
| EXTRACTING | NEEDS_REVIEW | 讀完並通過 JSON 驗證 |
| EXTRACTING | EXTRACT_FAILED | 3 次失敗；或 heartbeat 超過 5 分鐘（sweep） |
| EXTRACTING | DUPLICATE | 讀完撞 unique index（§6.4）→ `duplicateOfId` |
| EXTRACT_FAILED | EXTRACTING | 「再讀一次」 |
| EXTRACT_FAILED | NEEDS_REVIEW | 「人手輸入」儲存 |
| NEEDS_REVIEW | CONFIRMED | 確認頭部（§7.1） |
| CONFIRMED／PARTIAL／RECONCILED | 由行狀態重算 | 每次分組儲存、成本作廢、解除配對：全部 MATCHED/IGNORED → RECONCILED；有 MATCHED/IGNORED 但未齊 → PARTIAL；冇 → CONFIRMED |
| 任何（VOID 除外） | VOID | 作廢：冇 MATCHED 行先得，要原因 |

非法：VOID → 任何；DUPLICATE → 任何（只可以「睇原本嗰張」）；RECONCILED → NEEDS_REVIEW。

**STATEMENT**：UPLOADED → EXTRACTING → NEEDS_REVIEW（分段未識別齊）→ IN_PROGRESS（分段齊，配對中）→ RECONCILED（全部分段 CONFIRMED）。任何 → SUPERSEDED（取代舊版；只可以由新版觸發）／VOID。

**分段**：PENDING → NEEDS_ASSIGN（診所或醫生未識別）→ DIFF／OK（配對後）→ CONFIRMED。CONFIRMED 之後如果有人補上傳 invoice 或作廢 invoice → **唔自動改**，分段顯示「確認後有變動」藍色提示，經理可以「重新配對」（狀態返 DIFF／OK）。

---

## 4. 存底（B8、B11）

### 4.1 儲存位置同加密

- 新 docker volume `lab_docs` → app container `/data/lab-docs`（env `LAB_DOC_DIR=/data/lab-docs`）。`docker-compose.yml` app service 加 `volumes: - lab_docs:/data/lab-docs`，`volumes:` 段加 `lab_docs:`。
- 每個檔用 **AES-256-GCM** 加密後先寫碟：`LAB_DOC_ENC_KEY`（32 bytes base64，env）＋ `LAB_DOC_ENC_KID`（預設 `k1`）。檔頭：`magic 'LDOC1' | kid(2) | iv(12) | tag(16) | ciphertext`。換 key：新檔用新 kid；舊 kid 保留喺 `LAB_DOC_ENC_KEYS_OLD`（`kid:base64,…`）。
- 路徑：`{yyyy}/{mm}/{fileId}.bin`（原檔）、`{yyyy}/{mm}/{fileId}.p{n}.jpg.bin`（顯示圖）、`{yyyy}/{mm}/{fileId}.p{n}.thumb.jpg.bin`（縮圖）。顯示圖同縮圖都加密。
- **唔准**用檔名或者 query string 拼路徑（防 path traversal）；只可以由 `LabFile.storageKey`／`pagesJson` 讀。
- 寫檔：先寫 `*.tmp` → fsync → rename；DB transaction 失敗就刪 tmp。每晚 sweep 刪孤兒（碟有、DB 冇，超過 24 小時）。

### 4.2 上傳處理（`src/lib/labdoc/storage.ts`）

| 類型 | 前端 | 後端 |
|---|---|---|
| 相片 | `<input type="file" accept="image/jpeg,image/png" capture="environment" multiple>`（iOS 揀「最兼容」會自動轉 JPEG）。前端用 canvas 轉 JPEG：長邊 ≤ 2400px、quality 0.85、**去 EXIF**（canvas 重畫自然冇 EXIF）。轉完先上傳 | magic bytes 驗證；`sharp` 出顯示圖（長邊 1600）＋縮圖（長邊 320），按 EXIF orientation 轉正 |
| PDF | 原檔上傳，唔改 | magic `%PDF-`；拒絕加密 PDF；頁數 ≤ 30；用 `pdfjs-dist` 逐頁抽文字（`hasTextLayer` = 每頁文字 ≥ 20 字）＋渲染顯示圖（`@napi-rs/canvas`）＋縮圖 |

- 單檔上限 15 MB；一次最多 20 個檔；總數 ≤ 60 MB。超過回 413 + 中文訊息。
- 新依賴：`sharp`、`pdfjs-dist`、`@napi-rs/canvas`（全部有 musl prebuilt）。**P1 第一步**：喺 `node:22-alpine` image 入面試裝並渲染 `test/fixtures/labdoc/*.pdf`；唔得就 Dockerfile 改 `node:22-slim`，喺 PR 寫明。授權記入 `THIRD_PARTY_LICENSES.md`。
- `sha256` 用原檔（相片＝前端轉完嘅 JPEG）計。同一個 sha256 已經有未作廢單據 → 回 409 `{ duplicateOf: docId }`，畫面「呢個檔已經喺 {日期} 由 {人} 上傳過」＋「去睇」；`force=true`（只限 `lab_statement`）先准再上傳。

### 4.3 睇檔（檔案庫）

**API**（全部 `lab_invoice` 或 `lab_statement`；回應 `Cache-Control: private, no-store`；`Content-Disposition: inline`；`X-Content-Type-Options: nosniff`）：

| Route | 回 |
|---|---|
| `GET /api/lab-docs/files/:fileId/pages/:n?v=thumb\|display` | 解密後 JPEG |
| `GET /api/lab-docs/files/:fileId/original` | 解密後原檔（PDF 或 JPEG）；寫 audit `LAB_DOC_FILE_DOWNLOAD` |

- 已到期（`purgedAt != null`）→ 410，body `{ error: '原檔已按保留政策（7 年）於 {日期} 刪除' }`；前端顯示灰色佔位＋呢句。
- 用 `<img src>` 載入（同源 cookie），**唔准**用 public URL、signed URL 或者 base64 塞入 JSON。

**畫面**：
1. **檔案庫** `/lab-docs/archive`（新分頁「檔案庫」）
   - 篩選：類型（invoice／月結單）、Lab、診所、醫生、月份（docDate 或 statementMonth）、狀態、上傳人；搜尋：單號、病人編號（正規化後比）、Lab 編號。
   - 結果：電腦用表（縮圖 48px、類型、Lab、診所、醫生、單號、日期、總數、狀態、上傳人、上傳時間）；手機用卡片。每頁 30，按日期新到舊。
   - 已作廢、DUPLICATE、SUPERSEDED **都顯示**（灰色＋原因），因為係存底。
2. **檔案檢視器**（共用 component `LabDocViewer`，全屏 modal）
   - 左／上：頁面圖（縮放 1×–4×、拖動、旋轉 90°（只係顯示，唔改檔）、上一頁／下一頁、頁碼）。
   - 右／下：單據資料（Lab、診所、醫生、單號、日期、總數、狀態、上傳人、確認人）＋「下載原檔」掣＋「去對數頁」。
   - 手機：上下分；左右掃轉頁；雙指縮放。
3. **入口**（全部開同一個檢視器）
   - 成本錄入表：有 MATCHED 行嘅成本，項目欄後面加「單」icon（可以有幾張：主單＋補收費／重做）→ 撳開檢視器（多張就先揀）。`GET /api/cost-cases` 回應加 `labDocs: [{ id, docNo, linkType }]`。
   - invoice 對數頁：右上「睇相」。
   - 月結單總覽／分段：「睇原檔」＋每行單號「睇 invoice」。
   - 待處理：每行「睇單」。

### 4.4 保留同刪除（B8）

- `purgeAt = uploadedAt + 7 年`（`LabFile`）。
- 每晚 03:30 `POST /api/internal/labdoc-purge`（x-cron-key／`APRICOT_CRON_KEY`，同 `clinical-index-nightly` 守門）：
  1. 搵 `purgeAt <= now AND purgedAt IS NULL`，逐個：刪碟上全部 key → `purgedAt = now`。
  2. 只有當一張單據**所有頁**嘅檔都 purged，先清嗰張單據嘅 PII：`extractedJson` 入面所有 `patientNameRaw`、`patientRaw` 設 null；`LabDocumentLine.patientNameRaw`、`LabStatementLine.patientRaw` 設 null。
  3. 逐個檔 commit；中途停咗下次可以接住做。
  4. audit `LAB_DOC_IMAGE_PURGE`：notes 記檔數、單據數、清咗幾多個姓名欄（唔記姓名）。
- 金額、單號、病人編號、配對紀錄**保留**。
- 「作廢」唔會刪檔（存底）。
- `docs/PDPO.md` §3 加一行：`Lab invoice／月結單原檔 | 7 年 | 會計紀錄（稅務條例）；到期刪檔並清病人姓名`。

### 4.5 備份

- `scripts/backup.sh` 加一步：`rclone copy "$LAB_DOC_VOLUME_PATH" remote:clinic-backups/lab-docs/`（檔已加密，唔使再 age；**copy 唔用 sync**，防誤刪傳播）。每月 1 號額外跑 `rclone sync --max-delete 500`，令已到期刪咗嘅檔喺 offsite 都刪。
- `scripts/restore-drill.sh` 加：隨機抽 5 個 `LabFile`，由 offsite 拉返、解密、比 sha256。
- `LAB_DOC_ENC_KEY` 要同 `APRICOT_ENC_KEY` 一樣**另外抄一份離線保管**；冇 key 備份檔冇用。`docs/DEPLOYMENT.md` 加一段。
- 容量估算：每日約 30 張 × 0.6 MB（原檔＋顯示圖＋縮圖）≈ 18 MB → 每年約 6.5 GB → 7 年約 45 GB。`README-CRONTAB.md` 嘅 disk-alert 照用；`/api/lab-docs/stats` 回總容量，Lab 設定頁顯示。

---

## 5. 讀單

### 5.1 背景工作

- 上傳 API 建完單據即回應；同一 request 尾 `void runLabDocExtract(docId)`（同 `apricot/sync/route.ts:254` 做法）。
- `runLabDocExtract`：
  1. 條件更新 `status: UPLOADED|EXTRACT_FAILED → EXTRACTING`（`updateMany where status in …`，影響 0 行就退出，防兩個 worker 同時做）。
  2. 每 20 秒刷 `heartbeatAt`。
  3. 揀模式：全部頁 `hasTextLayer` → TEXT；否則 VISION。
  4. 叫 proxy（§5.2）；失敗按 `NullReason` 記 `extractError`，`extractAttempts++`；`< 3` 就 30 秒後再試，`= 3` → EXTRACT_FAILED。
  5. 成功 → JSON schema 驗證（zod）→ 敏感數字過濾（§5.6）→ 寫 `extractedJson`（過濾後）→ 正規化寫欄位同行 → 驗證（§5.5）→ 識別（§6）→ `NEEDS_REVIEW`。
  6. 寫 docNo 撞 unique index（Prisma P2002）→ `DUPLICATE` + `duplicateOfId`。
- Sweep：`POST /api/internal/labdoc-sweep`，cron 每 5 分鐘：`EXTRACTING AND heartbeatAt < now-5min` → 當失敗處理；`UPLOADED AND createdAt < now-2min` → 再觸發。
- 前端：列表每 5 秒 poll `GET /api/lab-docs?ids=…`（只回狀態），全部唔係 UPLOADED/EXTRACTING 就停。

### 5.2 wa-inbox proxy 新接口（**另一個 repo，要同步施工**）

- 新 route：wa-inbox `POST /api/internal/labdoc-extract`，信封同 `llm-envelope` 一樣（AES-256-GCM，`REQ_CONTEXT` 改 `'labdoc-extract.v1'`，回應 `respContext(nonce)`）。
- 請求（密文內）：
  ```json
  { "mode": "TEXT|VISION", "kindHint": "INVOICE|STATEMENT",
    "labHint": "string|null",            // LabProfile.extractionHint（已識別 Lab 時；第一次讀未知 Lab 就 null）
    "text": "string|null",               // TEXT：逐頁文字，頁之間用 '\n<<<PAGE n>>>\n'，≤ 60,000 字
    "images": ["base64 jpeg", "..."]     // VISION：顯示圖（長邊 1600），≤ 8 張
  }
  ```
- 回應：`{ "result": <§5.4 JSON>|null, "reason": "string|null" }`。
- wa-inbox 唔寫 DB、唔寫檔、唔 log 原文（同 2026-09-17 決定一樣）；body 上限 12 MB。
- workforce 側 `src/lib/labdoc/llm-client.ts`：複製 `extractViaWaInbox` 結構（429 重試、`NullReason`），**timeout 120 秒**（vision 慢）；env `WA_INBOX_LABDOC_URL`（未設 → 全部 EXTRACT_FAILED，`extractError='not_configured'`，畫面提示「讀單服務未設定，請人手輸入」）。
- 測試用 `__setLabDocExtractFn(fn)` stub（同 `__setExtractFn`）。

### 5.3 Prompt（`src/lib/labdoc/prompt.ts`，wa-inbox 側用同一份文字；兩邊 fixture 對比防漂移）

```
你係牙科 Lab 單據讀取器。只輸出一個 JSON 物件，唔好輸出任何其他文字。
規則：
1. 判斷文件類型：INVOICE（單張發票／送貨單）或 STATEMENT（月結單、產品結算表、Outstanding Statement，列出多張發票）。
2. 只抄印出嘅內容；手寫字、圈號、簽名、剔號唔好讀。讀唔到填 null，唔好估。
   例外：Lab 名被切，但頁面其他地方（底部條款、印章、email 網域）印咗全名，可以用，並喺 readIssues 寫明出處。
3. 金額輸出數字（唔要 $、HK$、逗號）；貸項／CREDIT 用負數。日期一律 YYYY-MM-DD，原文放 dateRaw。
4. 病人：姓名抄到 patientNameRaw；病人編號抄到 patientCodeRaw，連字母前綴一齊抄（例「TY9845」）；
   Lab 自己嘅編號（例 DT9003874、Case No.、7 位 Lab 編號）抄到 labCaseRef，唔好當病人編號。
5. 同一病人嘅行放同一個 group。
6. 絕對唔好抄：銀行名之後嘅帳號、Account No.、Swift、FPS ID、支票號碼、支票底部 MICR 數字、簽名。
   如果頁面有支票，readIssues 加 "CHEQUE_PRESENT"。
7. 有「List Price」「D/C %」「U'Price」→ amount 用實際收費欄；D/C % 原文抄 discountRaw。
8. 文件打橫或倒轉都照讀。
9. STATEMENT：
   a. 每個「診所＋醫生」係一個 section（例如每頁一個醫生）；抄 clinicRaw、doctorRaw、customerNoRaw、section 總數。
   b. INVOICE# 空白嘅行沿用上一個單號。
   c. 每行抄晒有嘅欄：單號、日期、病人、項目、牙位、數量、單價、金額。
   d. 用「本行金額」欄，唔好用累計結餘（BALANCE）欄。
   e. 有分齡欄（Current Mth／31-90 days 等）就喺 agingBucket 填 CURRENT／D31_90／D91_365／OVER_1Y。
   f. 付款、承上結餘、服務費行要標 lineType（PAYMENT／BF／CHARGE）。
{labHint}
```

### 5.4 輸出 JSON（zod schema：`src/lib/labdoc/schema.ts`）

```json
{
  "kind": "INVOICE | STATEMENT",
  "lab": { "nameRaw": "string|null", "nameCnRaw": "string|null", "payeeRaw": "string|null" },
  "billTo": { "nameRaw": "string|null", "addressRaw": "string|null", "customerNoRaw": "string|null",
              "shortCodeRaw": "string|null", "doctorRaw": "string|null" },
  "docNoRaw": "string|null", "docNoLabel": "string|null",
  "dateRaw": "string|null", "date": "YYYY-MM-DD|null",
  "deliveryDate": "YYYY-MM-DD|null", "orderReceivedDate": "YYYY-MM-DD|null",
  "statementMonth": "YYYY-MM|null",
  "groups": [ { "patientNameRaw": "string|null", "patientCodeRaw": "string|null", "labCaseRef": "string|null",
      "lines": [ { "description": "string", "toothRaw": "string|null", "qty": "number|null", "unitPrice": "number|null",
                   "listPrice": "number|null", "discountRaw": "string|null", "amount": "number" } ] } ],
  "sections": [ { "clinicRaw": "string|null", "doctorRaw": "string|null", "customerNoRaw": "string|null",
      "addressRaw": "string|null", "pageFrom": "number|null", "pageTo": "number|null",
      "total": "number|null", "currentTotal": "number|null",
      "lines": [ { "lineType": "INVOICE|CREDIT|PAYMENT|CHARGE|BF", "docNoRaw": "string|null", "date": "YYYY-MM-DD|null",
                   "patientRaw": "string|null", "patientCodeRaw": "string|null", "labCaseRef": "string|null",
                   "description": "string|null", "toothRaw": "string|null", "qty": "number|null",
                   "unitPrice": "number|null", "amount": "number", "agingBucket": "string|null" } ] } ],
  "subtotal": "number|null", "total": "number|null",
  "readIssues": ["string"]
}
```

- INVOICE 嘅 `sections` = `[]`；STATEMENT 嘅 `groups` = `[]`。
- 多餘欄位：丟棄；必填欄缺 → 當 `bad_response`（重試計一次）。
- 數字：`amount` 絕對值 > 1,000,000 → readIssue `AMOUNT_TOO_LARGE`，該行標紅要人手確認。

### 5.5 讀單後系統檢查

| 檢查 | 適用 | 唔過 |
|---|---|---|
| 每行 `qty × unitPrice = amount`（齊先查，±0.01） | 兩種 | 行黃色 |
| Σ 行 amount = total（或 subtotal） | INVOICE | **擋確認**；顯示「差 $X」並將最可疑嘅行（qty×unitPrice 唔等嘅）排頭 |
| total、subtotal 都係 null | INVOICE | **擋確認**；要員工填總數（F-16） |
| 每段 Σ 行 amount（INVOICE＋CREDIT＋CHARGE）= section total；OUTSTANDING：Σ CURRENT = currentTotal | STATEMENT | 分段紅色「月結單讀數唔齊（差 $X），可能有行影唔到」＋「加頁」「重新讀」掣；**唔准確認分段** |
| `date` 喺上傳日前 400 日內、唔喺未來 > 7 日 | 兩種 | 黃色 |
| `kind` ≠ 上傳時揀嘅分頁 | 兩種 | 提示「似係月結單，轉去月結單？」（一撳轉，重新讀） |
| readIssues 有 `CHEQUE_PRESENT` | 兩種 | 紅色：「相入面有支票。請裁走支票再上傳（存底唔應該有已簽名支票）。」；`lab_statement` 可以「已確認冇支票資料」放行 |

### 5.6 敏感數字過濾（取代 QA 報告 §5.4 嘅「≥8 位＋dash」規則）

- **只**檢查以下欄位：`lab.*`、`billTo.*`、`description`、`readIssues`、`patientNameRaw`、`patientRaw`、`clinicRaw`、`doctorRaw`。**唔檢查** `docNoRaw`、`labCaseRef`、`patientCodeRaw`、`customerNoRaw`（F-03）。
- 命中以下任何一個 → 該欄設 null、readIssue 加 `SENSITIVE_REMOVED:<欄名>`、`console.warn('[labdoc] sensitive removed', { docId, field })`（**唔 log 原文**）：
  - 香港銀行帳號：`\b\d{3}-\d{6}-\d{3}\b`、`\b\d{3}-\d{3}-\d{6}\b`、`\b0\d{2}-\d{3}\b.*\d{9}`（Bank & Branch＋帳號）、`\b\d{9,12}\b` 而且同一欄出現 `account|a/c|戶口|帳號`
  - Swift：`\b[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?\b` 而且同欄有 `swift`
  - MICR：`⑈|⑆|⑇` 或 `\b\d{6}\s+\d{3}\s+\d{3}\s+\d{6}\s+\d{3}\b`
  - FPS：同欄有 `FPS` 而且有 `\d{7,9}`
- 單元測試要用真單（遮咗）嘅字串：`040-543613-838`、`809-644065-838`、`000661528`、`016-478`、`3118xx 004 691 524xxx xxx` → 全部要刪；`INV-260805010`、`IN-MDL2001313043`、`202609-0811`、`0172649`、`DT9003874` → 全部**唔可以**刪。

---

## 6. 識別規則

### 6.1 Lab

正規化 `normLabName(s)`：轉細階 → 全形轉半形 → 去標點同空格 → 去 `limited|ltd|co|company|laboratory|lab|dental|solutions|有限公司|牙科器材|牙科`。

1. `LabAlias(NAME_EN, norm(nameRaw))` 或 `LabAlias(NAME_CN, norm(nameCnRaw))` 中 → 依據 ALIAS。
2. `Lab.name` 正規化後同 `nameRaw`／`nameCnRaw` 互相包含，而且**較短嗰邊長度 ≥ 4**，只有一間中 → 依據 NAME。
3. 唔中 → 員工揀（下拉＋「Others」）；確認後寫 `LabAlias`（nameRaw、nameCnRaw 各一條，有值先寫），audit `LAB_ALIAS_LEARN`。
4. **payeeRaw 唔用嚟認 Lab**。認到 Lab 之後：`norm(payeeRaw)` 唔喺該 Lab 嘅 `LabAlias(PAYEE)` → `payeeIsNew = true` → 頭部黃色「收款人 {X} 同之前見過嘅 {Y} 唔同」＋「記住呢個收款人」（`lab_statement`；寫 PAYEE alias）。唔擋。

### 6.2 診所（依次，搵到就停；**唔准**用上傳者主屬店）

1. `customerNoRaw` ＋ `LabCustomerNo(labId, customerNo)` → 依據 CUSTOMER_NO（同時帶出 providerId，如有）。
2. `ClinicNameAlias(norm(billTo.nameRaw 或 section.clinicRaw))` → CLINIC_ALIAS。
3. 地址：`addressRaw` 抽「街道名＋門牌號」（中：`(.+?[路道街])(\d+)號`；英：`(\d+)\s+([A-Za-z ]+(Road|Street|Avenue))`），同每間 `Clinic.address`、`Clinic.addressEn` 比較，**只有一間中**先揀 → ADDRESS。
4. `shortCodeRaw` 同 `Clinic.shortName`（大階）完全一樣 → SHORT_CODE。
5. `billTo.nameRaw`／`clinicRaw` 包含某間 `Clinic.name` 嘅地區名（例「大圍」「土瓜灣／土瓜湾」，比較前做簡繁轉換：`湾→灣`）而且只中一間 → NAME。
6. 都唔中 → MANUAL（下拉；畫面寫「冇自動依據，請揀」）。
7. 員工確認或改咗：有 customerNoRaw → upsert `LabCustomerNo`；依據係 NAME／MANUAL 而有 clinicRaw → upsert `ClinicNameAlias`。覆蓋已存在 alias → 先彈「以後 {原文} 都當係 {新診所}？」。audit `LAB_ALIAS_LEARN`。
- 新欄 `Clinic.addressEn String?`（P1 migration）；診所管理頁加呢欄（`clinic_manage`）。Seed：大圍 `Shop 418, Wai Fong, 18 Che Kung Miu Road, Tai Wai`。

### 6.3 醫生（B2）

正規化 `normDoctor(s)`：細階、去 `dr|dr.|doctor|醫生`、去標點同空格。

1. `LabCustomerNo.providerId`（有）→ CUSTOMER_NO。
2. `ProviderNameAlias(normDoctor(doctorRaw))` → DOCTOR_ALIAS。
3. `Provider.name`／`shortName` 正規化後同 doctorRaw 相等，或者 doctorRaw 包含 provider 嘅英文名全部字（「Ho Ka Chun」⊂「Dr.Ho Ka Chun 何嘉俊醫生」），只中一個 active provider → NAME。
4. 唔中 → 員工揀（`GET /api/providers`）；確認後寫 `ProviderNameAlias`，audit `LAB_ALIAS_LEARN`。
- INVOICE 冇醫生名（例 Goodwill 某啲單）→ 必填，員工揀；對成本時成本嘅 `providerId` 同 invoice 唔同 → 黃色提示（唔擋）。

### 6.4 單號同重複

- 正規化：去空格、轉大階、全形轉半形。**唔去前置 0**（`0254131`）。**唔將 O 轉 0**（Modern `0321231O` 係 labCaseRef，唔係單號）。
- `docNoKind`：`LabProfile.defaultDocNoKind`；AI 嘅 `docNoLabel` 含 `case` → CASE_NO。
- INVOICE_NO：partial unique index 擋；撞 → DUPLICATE（讀單時）或 409（人手改單號時）`{ error: '呢張 invoice 已經喺 {日期} 由 {人} 上傳', duplicateOf }`。
- CASE_NO：同 Lab＋同單號＋同總數 → **軟提示**「可能重複」（可以照確認）；同單號唔同總數 → 提示「同一個 Case 嘅另一張單（補收費／重做？）」。
- 冇單號：同 Lab＋同 docDate＋同病人編號＋同總數 → 軟提示。
- labId 係 null（Others）→ 用 `labNameRaw` 正規化做 key 做軟提示。

### 6.5 病人編號（B13）

`normPatientCode(raw, invoiceClinicShortName)`：
1. `raw` 轉大階、去空格同 `#`。
2. `^([A-Z]{1,4})0*(\d{1,6})$` → `前綴 + 數字補零到 6 位`（`TY9845` → `TY009845`）。
3. `^\d{1,6}$` → `invoice 診所 shortName + 補零 6 位`（`7159` @大圍 → `TW007159`）。shortName 唔係英文字母（例「青」）→ 回 null（唔自動配對）。
4. 其他 → null。
- CostCase 用同一個 function 計 `patientCodeNorm`（POST、PUT 寫入時；backfill 一次）。
- 配對（§7.2）：
  - 精確 `patientCodeNorm = X` → 一個病人 → 自動揀「編號吻合」。
  - 冇結果，而 raw 冇前綴 → 搵其他前綴同數字（`patientCodeNorm LIKE '%' || lpad(n,6,'0')` 而且前綴係已知 shortName）→ 列出俾員工揀（顯示前綴同店名），**唔自動揀**。
  - 同時查 `PatientIndex.patientCode`（Apricot 病人索引）攞系統姓名，畫面顯示「系統：{姓名}／單上：{patientNameRaw}」俾員工核對。

---

## 7. Invoice 對成本

### 7.1 確認頭部（`PUT /api/lab-docs/:id/header`）

- 可改：Lab、診所、醫生、單號、單號類型、日期、出貨日、總數、每行（描述、牙位、數量、單價、金額）、增刪行、行搬去另一個分組、增刪分組、病人編號原文。
- 任何金額或總數同 AI 原值唔同 → `manualAmountEdit = true`（入待處理「人手改數待覆核」，`lab_statement` 覆核）。
- §5.5 擋確認嘅條件未解決 → 400。
- 寫：欄位、行；`status → CONFIRMED`；alias 學習（§6）；audit `LAB_DOC_CONFIRM`（before = AI 值，after = 確認值，只記有改嘅欄位；**唔記 patientNameRaw**）。
- 請求帶 `version`；唔等 → 409「呢張單啱啱被 {人} 改咗，請重新載入」。

### 7.2 揀病人（每個分組）

見 §6.5。員工可以「搵其他病人」（`/api/cost-cases/patient-search`）或者「呢組暫時唔處理」。

### 7.3 候選成本

```sql
CostCase WHERE patientCodeNorm = :code
  AND (labId = :labId OR (labId IS NULL AND :labId IS NULL))
  AND status <> 'VOID'
ORDER BY
  (baseCost = :groupSum) DESC,          -- 金額一樣排第一（F-06）
  (receivedAt IS NULL) ASC,             -- 已到貨排先
  orderedAt DESC
```
- **唔限月份**；唔限診所（診所唔同 → 黃色「成本喺 {店}，invoice 係 {店}」）。
- 每個候選顯示：項目、落單日、醫生、錄入金額（或「未有價」）、狀態（含「重做中」）、到貨日、「已出月結」、**已連咗邊幾張單**（主單／補收費／重做）。
- 已有 MAIN 連結嘅成本仍然係候選，揀佢就要揀連結類型：「補收費」或「重做」（B7）。

### 7.4 預設

- 分組所有行預設剔。
- 候選 1 筆而且未有 MAIN 連結 → 全部已剔行預設對佢（MAIN）。
- 候選 >1 → 預設揀「金額 = 分組合計」嗰筆（如果剛好一筆）；否則冇預設。
- 候選 0 → 顯示「新增成本」（§7.6）同「搵其他病人」。
- $0 行：預設剔、跟同組其他行連同一筆成本（D11）；唔影響金額。

### 7.5 每筆成本嘅核對同動作

`linkedSum(cc)` = 該成本**所有** MATCHED 行（包括其他 invoice 嘅補收費／重做）＋今次要連嘅行嘅 amount 總和。

| 情況 | 顯示 | 動作 |
|---|---|---|
| `lockedByRunId != null` | 「已出月結」灰 | 只連單，唔改價；`linkedSum ≠ baseCost` → 待處理「下期調整」（差額 = linkedSum − baseCost） |
| `baseCost = linkedSum` | 一致 ✓ | — |
| `baseCost = null` | 未有價 | 「填入 $Y」 |
| `baseCost ≠ linkedSum` | 金額唔同（錄入 $X · invoice $Y） | 「改做 $Y」；**另一筆候選嘅 baseCost 剛好 = 分組合計** → 紅色「金額同 {另一筆} 一致，係咪揀錯？」，「改做」要再撳一次確認 |
| `status = REDO` | 重做中 | 可以連（揀「重做」類型）；`linkedSum` 照計 |
| 成本醫生 ≠ invoice 醫生 | 黃色提示 | 唔擋 |

「填入／改做」：`baseCost = linkedSum`、`discountPct = null`、`finalCost = baseCost`（B4）、`PENDING → PRICED`；audit `LAB_DOC_PRICE_UPDATE`（before／after baseCost、finalCost、discountPct；notes：docId、lineIds）。

### 7.6 新增成本

- 預填：`clinicId` = invoice 診所、`providerId` = invoice 醫生（可改）、`labId`、`category = 'LAB'`（**鎖死**，F-25）、`patientCode`／`patientCodeNorm`、`patientName` = PatientIndex 姓名（冇就 null；**唔用** invoice 拼音）、`labOrderNo = labCaseRef`、`baseCost = 分組合計`、`finalCost = baseCost`、`orderedAt = orderReceivedDate ?? docDate`（畫面標「估計」）、`source = 'MANUAL'`、`labInvoiceLinked = true`。
- 員工必揀：項目類型（itemType，同成本錄入同一個清單）。
- audit `LAB_DOC_CASE_CREATE`（after = 新成本主要欄位）。

### 7.7 確認到貨（B5）

- 每筆對咗嘅成本，如果 `receivedAt` 係 null：卡片「器材收到未？到貨日 [deliveryDate ?? docDate]」＋「確認到貨」。
- 撳咗 → 同 `PUT /api/cost-cases/:id` 一樣嘅規則：`deriveCostPeriod`、目標月份（醫生×診所×月）已 LOCKED → 409「{月} 已出月結，唔可以填呢個到貨日」，員工改日期或者留空。
- 唔撳 → 成本保持冇到貨日 → 待處理「已對單未確認到貨」。
- audit：用現有 `COST_CASE_UPDATE`（before／after receivedAt、periodMonth；notes「經 Lab 單據 {docNo}」）。

### 7.8 儲存分組（`POST /api/lab-docs/:id/groups/:g/save`）

請求：
```json
{ "idempotencyKey": "uuid", "version": 3, "patientCodeNorm": "TW007159",
  "lines": [ { "lineId": "…", "action": "MATCH|IGNORE|UNMATCH", "costCaseId": "…|null", "newCaseTempId": "t1|null",
               "linkType": "MAIN|SUPPLEMENT|REDO", "ignoreReason": "ZERO|NOT_OURS|OTHER:…" } ],
  "newCases": [ { "tempId": "t1", "providerId": "…", "itemType": "…", "orderedAt": "YYYY-MM-DD" } ],
  "priceUpdates": [ "costCaseId" ],
  "receivedConfirms": [ { "costCaseId": "…", "receivedAt": "YYYY-MM-DD" } ] }
```

伺服器（**一個 `$transaction`，isolation `Serializable`，撞 serialization error 重試 2 次**）：
1. 冪等：`LabDocWriteLog` 有同 key → requestHash 一樣回舊 response；唔一樣 409。冇 → 寫 IN_PROGRESS。
2. 驗證：文件 `status ∈ {CONFIRMED, PARTIAL, RECONCILED}`、`version` 相等；每個 lineId 屬呢張單、呢個分組；每個 costCaseId：同 Lab、`patientCodeNorm` 等於請求嘅、`status ≠ VOID`、喺用戶 scope。
3. 新增成本（§7.6）。
4. 行：`UPDATE LabDocumentLine SET status='MATCHED', costCaseId=… WHERE id=… AND (status='UNMATCHED' OR (status='MATCHED' AND costCaseId=…))` → 影響 0 行 → rollback，409「呢行啱啱被 {人} 對咗去另一筆成本」。
5. B7 規則：同一筆成本嘅 MAIN 行只可以嚟自一張單 → 違反 → 400「呢筆成本已經有主單 {docNo}，請揀『補收費』或『重做』」。
6. 改價（§7.5）：條件寫 `UPDATE CostCase … WHERE id=… AND lockedByRunId IS NULL`，0 行 → rollback，409「呢筆成本啱啱出咗月結」。
7. 到貨（§7.7）。
8. `CostCase.labInvoiceLinked` 重算（有任何 MATCHED 行）。
9. 文件狀態重算（§3.4）、`version + 1`。
10. Audit：每行配對變動 `LAB_DOC_LINE_MATCH`／`LAB_DOC_LINE_UNMATCH`／`LAB_DOC_LINE_IGNORE`；改價、新增、到貨各自一條。**全部喺同一個 transaction 入面寫**。
11. `LabDocWriteLog` → DONE＋response。

前端：「儲存」撳咗即刻 disable，直到回應；idempotencyKey 喺打開畫面時產生，成功後換新。

### 7.9 成本作廢／解除配對

- `DELETE /api/cost-cases/:id`（現有）改：同一 transaction 將該成本嘅 MATCHED 行轉 UNMATCHED（`costCaseId = null`），重算相關文件狀態，audit `LAB_DOC_LINE_UNMATCH`（notes「成本作廢」）。前端作廢前提示「呢筆成本已對應 {docNo…}，作廢之後嗰幾行會變返未對」。
- invoice 頁「解除配對」：未鎖成本先得；行轉 UNMATCHED；`baseCost` 唔自動改返（畫面提示「錄入金額保持 $X」）。

### 7.10 作廢 invoice

- 冇 MATCHED 行先得（有就先解除）；要原因；`status = VOID`；**原檔保留**；docNo 可以再用；audit `LAB_DOC_VOID`。

### 7.11 合併／拆頁

- 合併：揀 2+ 張同時上傳、未 CONFIRMED 嘅 invoice → 新文件（頁按揀嘅次序）→ 舊文件 VOID（原因「合併到 {新 id}」）→ 新文件重新讀單。
- 拆頁：一份 PDF 上傳做 invoice → 預設每頁一張（D9）；`lab_invoice` 可以喺讀完之前改做「全部一張」。

---

## 8. 月結單對數

### 8.1 上傳同分段

- 分頁「月結單」→ 上傳（多個檔＝一份）。可以先揀 Lab 同月份（可留空，讀單後自動填）。
- 讀單後：每個 section 建 `LabStatementSection`；識別診所（§6.2）同醫生（§6.3）；任何一個未識別 → 分段 `NEEDS_ASSIGN`，文件 `NEEDS_REVIEW`，畫面要經理揀（`POST /sections/:sid/assign`，可剔「記住」→ 寫 alias）。
- `statementMonth`：AI 值；冇就用 section 行最遲日期嘅月份並標黃。
- 重複：同 Lab＋同診所＋同醫生＋同月，有另一份未作廢、未取代嘅月結單分段 → 擋該分段：「{月} {診所} {醫生} 嘅月結單已經喺 {日期} 上傳」＋「取代舊版」（`lab_statement`，要原因；舊文件 SUPERSEDED，舊分段結果保留做紀錄）。

### 8.2 配對（`src/lib/labdoc/statement-match.ts`，純函數＋單元測試）

系統 invoice 範圍（每段）：`kind=INVOICE`、`status ∈ {CONFIRMED, PARTIAL, RECONCILED}`、同 labId、clinicId、providerId、`docDate` 喺 `[月初 − 45 日, 月尾 + 10 日]`。

**A. 單號型（INVOICE_LIST）**
1. `LabProfile.statementDocNoSameAsInvoice` → `docNo` 相等 → 比金額：一樣 MATCHED；唔同 AMOUNT_DIFF。
2. 未中 → fallback：`|docDate − line.date| ≤ 3 日` 而且金額一樣，唯一 → MATCHED（basis FALLBACK）。
3. 未中 → `|日期差| ≤ 3` 而且（有病人編號就同病人）唯一 → AMOUNT_DIFF（basis FALLBACK）。
4. 未中 → MISSING_IN_SYSTEM。多過一個候選 → NEEDS_MANUAL。

**B. 明細型（DETAIL）**
1. 按 `docNo` 將行分組（AI 已沿用合併儲存格單號；仍然冇單號嘅行 → NEEDS_MANUAL）。
2. 每組對系統 invoice（單號）；冇 → 全組 MISSING_IN_SYSTEM。
3. 組內逐行配對系統 invoice 行：`norm(description)` 相等（去空格、全半形、括號統一）＋`toothRaw` 正規化相等（去空格後比字元集合）優先；然後 description 相等；然後按次序。
4. 每對：qty 唔同 → QTY_DIFF；unitPrice 唔同 → PRICE_DIFF；只係 amount 唔同 → AMOUNT_DIFF；全同 → MATCHED。
5. 系統 invoice 有、月結單組冇嘅行 → 加一條虛擬結果「月結單冇呢行」（存喺 section 結果 JSON，唔建 StatementLine）。

**C. 欠款型（OUTSTANDING）**
1. `agingBucket = CURRENT`（或者 date 喺 statementMonth）→ 照 A 配對。
2. 其他 → 搵之前已確認分段有冇 MATCHED 過同一單號 → PREVIOUSLY_MATCHED（灰「之前已對・未付」）；冇 → 照 A 配對，配到 → MATCHED；配唔到 → MISSING_IN_SYSTEM。
3. 分段總數比較用 `statedCurrent` vs Σ CURRENT 已配對系統金額。

**共通**
- `lineType ∈ {PAYMENT, BF}` → NOT_APPLICABLE（唔配對、唔計總數）；CHARGE（服務費等）→ NEEDS_MANUAL；CREDIT → 照配對（負數）。
- `systemTotal` = 呢段所有 MATCHED／*_DIFF 行對到嘅系統金額；分段 OK = 冇 *_DIFF、MISSING、NEEDS_MANUAL 而且 `statedTotal = systemTotal`。
- **反向（月結單冇）**：範圍內系統 invoice 嘅 docDate 喺 statementMonth，但冇被任何月結單行配對 → 喺分段顯示「系統有、月結單冇」。只有當同一段（Lab＋診所＋醫生）嘅 **M 同 M+1** 兩份月結單都 CONFIRMED 而佢仍然唔喺度，先入待處理（Q5）。
- 配對結果寫入 `LabStatementLine.result/matched*`；可以重跑（`POST …/reconcile`），**已有 resolution 嘅行保留 resolution**。

### 8.3 處理差異（`POST /api/lab-docs/:id/sections/:sid/lines/:lid/resolve`）

| resolution | 權限 | 效果 |
|---|---|---|
| `INVOICE_WINS`（預設建議） | `lab_statement` | 唔改系統；入待處理「同 Lab 跟進」，直到「跟進完成」（`followUpClosedAt`） |
| `STATEMENT_WINS` | `lab_statement`，**要原因** | 改系統 invoice 行（qty／unitPrice／amount）同文件 total；如果嗰行已連成本：未鎖 → 顯示「成本 {項目} 會由 $X 改做 $Y」再確認，然後同 §7.5「改做」一樣；已鎖 → 待處理「下期調整」。audit `LAB_STATEMENT_ADJUST`（before／after 行同成本） |
| `MANUAL_PAIRED` | `lab_statement` | 人手揀系統 invoice（同段範圍內）→ 再行比較 |
| `NOT_OURS` | `lab_statement`，要原因 | 唔屬本集團（例 Lab 打錯醫生） |
| 「補上傳 invoice」 | `lab_invoice` | 開上傳（預填 Lab、診所、醫生）；新 invoice 確認後，分段頂部提示「有新 invoice，可以重新配對」 |

### 8.4 確認分段（`POST /api/lab-docs/:id/sections/:sid/confirm`）

- 條件：每行 result ∈ {MATCHED, PREVIOUSLY_MATCHED, NOT_APPLICABLE} 或者有 resolution；§5.5 分段讀數檢查通過。
- 寫：`CONFIRMED`、`confirmedBy/At`；audit `LAB_STATEMENT_RECONCILE`（notes：各結果數量、statedTotal、systemTotal、差額）。
- 全部分段 CONFIRMED → 文件 RECONCILED。

### 8.5 折扣證據（B4 監察）

分段總覽額外顯示「Σ 相關成本 finalCost」；同 statedTotal 唔等而原因係 `discountPct` 有值 → 紅色「有成本仲套緊月度折扣」，連結去嗰幾筆成本。

---

## 9. 待處理（`GET /api/lab-docs/pending?category=&labId=&clinicId=&providerId=&month=`）

| category | 條件 | 誰處理 | 動作 |
|---|---|---|---|
| `UNMATCHED_LINE` | invoice 行 UNMATCHED，文件 CONFIRMED/PARTIAL，超過 3 日 | `lab_invoice` | 去對數頁 |
| `NOT_RECEIVED` | 成本 `labInvoiceLinked = true` 而 `receivedAt IS NULL`、`status ≠ VOID` | `lab_invoice` | 確認到貨（同 §7.7） |
| `RECEIVED_NO_INVOICE` | 成本 `category='LAB'`、`receivedAt` 有值超過 14 日、`labInvoiceLinked = false`、`status ≠ VOID` | `lab_invoice` | 上傳 invoice |
| `STATEMENT_DIFF` | 月結單行 *_DIFF／NEEDS_MANUAL 未有 resolution；或 INVOICE_WINS 未跟進完成 | `lab_statement` | 去分段 |
| `MISSING_IN_SYSTEM` | 月結單行 MISSING_IN_SYSTEM 未有 resolution | `lab_invoice` | 補上傳 |
| `NOT_ON_STATEMENT` | §8.2 反向，M 同 M+1 都確認咗仍然冇 | `lab_statement` | 睇單、同 Lab 跟進 |
| `LOCKED_ADJUST` | 已鎖成本 `linkedSum ≠ baseCost` | `provider_payout` 處理；`lab_invoice` 睇到 | 去下期調整 |
| `AMOUNT_REVIEW` | `manualAmountEdit = true` 而未覆核 | `lab_statement` | 對相覆核 → 「已覆核」 |
| `NEW_PAYEE` | `payeeIsNew = true` 而未處理 | `lab_statement` | 記住／標記可疑 |
| `EXTRACT_FAILED` | 讀單失敗 | `lab_invoice` | 再讀／人手輸入 |

- 全部係查詢（唔建表），每類有數字 badge；手機首頁 badge = 用戶有權處理嘅總數。
- 匯出 CSV（`lab_statement`）：所有文字欄位開頭係 `= + - @` → 前面加 `'`（防 CSV 公式注入）。

---

## 10. 權限同範圍

### 10.1 `src/lib/permissions.ts`

```ts
lab_invoice: 'Lab 單據（上傳、對 invoice、檔案庫）',
lab_statement: 'Lab 月結單對數（確認、改系統、Lab 設定）',
// ROLE_DEFAULTS.MANAGER 加 'lab_invoice', 'lab_statement'
// EMPLOYEE 唔預設；經理喺帳號管理 grant
```

### 10.2 能做乜

| 動作 | lab_invoice | lab_statement | cost_entry |
|---|---|---|---|
| 上傳 invoice／月結單、再讀、人手輸入 | ✅ | ✅ | ❌ |
| 確認 invoice 頭部、對成本、改價／填價、新增成本、確認到貨 | ✅ | ✅ | ❌ |
| 作廢 invoice（冇配對時） | ✅ | ✅ | ❌ |
| 月結單分段：識別、處理差異、確認、取代舊版 | ❌（只可以睇同補上傳） | ✅ | ❌ |
| 「以月結單為準」、覆核人手改數、記住收款人、Lab 設定、alias 管理 | ❌ | ✅ | ❌ |
| 檔案庫、睇檔、下載原檔、待處理 | ✅ | ✅ | ❌ |
| 成本錄入頁直接改成本（現有） | ❌ | ❌ | ✅ |

> 注意（寫入 rbac-matrix）：`lab_invoice` 經對數流程可以改成本價；所以人手改過金額嘅單一律入「人手改數待覆核」。

### 10.3 範圍

- 所有 labdoc route 用 `resolveClinicScope(session, perms, { companyWide: ['lab_invoice', 'lab_statement'] })` → 有權限 = 全部診所（B16）。
- 仍然要驗：resource 存在、文件未 VOID（寫入時）、costCaseId 同文件同 Lab、同病人（防 IDOR）。
- `[id]` route 要過 `check-ownership.sh`：加 `// ownership-ok: labdoc 全集團範圍（B16）；寫入驗證 costCase 同 doc 同 Lab 同病人` 註釋。

### 10.4 `src/lib/config.ts`

`RBAC_MATRIX`（role 表）同 perm route 表都要加 §11 每一條 route。`scripts/check-rbac-matrix.sh` 要過。`docs/specs/rbac-matrix.md` 加兩個權限嘅說明。

### 10.5 選單

- `(protected)/layout.tsx`：`{ path: '/lab-docs', label: 'Lab 單據', icon: Receipt, roles: ['OWNER','MANAGER','EMPLOYEE'], perm: 'lab_invoice' }`（`lab_statement` 都要見到：用 `perms: ['lab_invoice','lab_statement']` 如 layout 支援；唔支援就兩個都 check）。
- `mobile-more/page.tsx` 同樣加。

---

## 11. API 一覽

> 全部 GET 用 `jsonNoStore`（`check-get-no-store.sh`）；錯誤訊息中文；所有寫入 audit。

| Method · Route | 權限 | 說明 |
|---|---|---|
| POST `/api/lab-docs/upload` | lab_invoice | multipart：`files[]`、`kind`、`labId?`、`statementMonth?`、`splitPdfPages?`、`idempotencyKey`、`force?` → `{ documents: [{id,status}] }` |
| GET `/api/lab-docs` | lab_invoice | 列表／檔案庫：`kind,status,labId,clinicId,providerId,month,q,ids,page` |
| GET `/api/lab-docs/:id` | lab_invoice | 詳情：頭部、頁（fileId,pageNo）、分組＋行、分段＋行、readIssues |
| POST `/api/lab-docs/:id/retry` | lab_invoice | EXTRACT_FAILED → 再讀 |
| PUT `/api/lab-docs/:id/manual` | lab_invoice | 人手輸入（EXTRACT_FAILED） |
| PUT `/api/lab-docs/:id/header` | lab_invoice | 確認頭部（§7.1） |
| GET `/api/lab-docs/:id/groups/:g/candidates` | lab_invoice | 病人配對＋候選成本（§6.5、§7.3） |
| POST `/api/lab-docs/:id/groups/:g/save` | lab_invoice | 儲存分組（§7.8） |
| POST `/api/lab-docs/:id/lines/:lineId/unmatch` | lab_invoice | 解除配對（§7.9） |
| POST `/api/lab-docs/merge` | lab_invoice | 合併（§7.11） |
| POST `/api/lab-docs/:id/void` | lab_invoice（invoice）／lab_statement（月結單） | 作廢 |
| POST `/api/lab-docs/:id/review-amount` | lab_statement | 人手改數覆核 |
| POST `/api/lab-docs/:id/payee` | lab_statement | 記住收款人／標記可疑 |
| POST `/api/lab-docs/:id/sections/:sid/assign` | lab_statement | 揀分段診所／醫生（可記住） |
| POST `/api/lab-docs/:id/sections/:sid/reconcile` | lab_statement | 重新配對 |
| POST `/api/lab-docs/:id/sections/:sid/lines/:lid/resolve` | lab_statement | 處理差異（§8.3） |
| POST `/api/lab-docs/:id/sections/:sid/lines/:lid/close-followup` | lab_statement | 跟進完成 |
| POST `/api/lab-docs/:id/sections/:sid/confirm` | lab_statement | 確認分段 |
| POST `/api/lab-docs/:id/supersede` | lab_statement | `{ oldDocumentId, reason }` |
| GET `/api/lab-docs/pending` | lab_invoice | 待處理（§9）；`?format=csv` 要 lab_statement |
| GET `/api/lab-docs/files/:fileId/pages/:n` | lab_invoice | 頁圖（§4.3） |
| GET `/api/lab-docs/files/:fileId/original` | lab_invoice | 原檔下載（audit） |
| GET `/api/lab-docs/stats` | lab_statement | 容量、各狀態數量 |
| GET/PUT `/api/lab-profiles/:labId` | lab_statement | Lab 設定 |
| GET/DELETE `/api/lab-aliases` | lab_statement | 列出／刪除 alias（LabAlias、LabCustomerNo、ClinicNameAlias、ProviderNameAlias；`?type=`） |
| POST `/api/internal/labdoc-sweep` | x-cron-key | 每 5 分鐘 |
| POST `/api/internal/labdoc-purge` | x-cron-key | 每晚 03:30 |

**錯誤碼**：400 驗證唔過；403 冇權限；404 搵唔到；409 版本衝突／已被人改／重複／已鎖；410 原檔已刪；413 太大；415 類型唔啱；503 讀單服務未設定（只喺「再讀」時回）。

---

## 12. 畫面（設計稿已確認；以下係行為細節）

### 12.1 `/lab-docs`（手機優先）

- 分頁：到貨單｜月結單｜待處理（badge）｜檔案庫。記住上次分頁（localStorage，try/catch）。
- 到貨單：「影 invoice」（相機，多張）、「上傳 PDF」；提示「唔好影到支票」。列表卡片：Lab、單號、診所、醫生、病人數、總數、狀態 chip（讀取中／待確認／部分對咗／已對／讀取失敗／重複／已作廢）。

### 12.2 `/lab-docs/invoices/[id]`（手機優先）

- 頂：Lab／診所／醫生／單號／日期，每個寫依據（例「依據：地址『車公廟路18號』」），撳就改（下拉或輸入）。
- 合計條：綠「✓ 行合計 $X ＝ 單總數 $X」；紅「行合計 $X，單總數 $Y，差 $Z」＋擋確認。
- 未確認頭部：只顯示頭部＋行（可改）＋「確認」掣。確認後顯示分組卡。
- 分組卡：病人（編號、系統姓名、單上姓名）→ 行（剔選、$0 灰）→ 候選成本（radio；金額一樣 chip；已連單 chip）→ 核對結果（一致／改做／填入／已出月結）→ 到貨卡。
- 「搬去其他病人」：行嘅 ⋯ 選單。
- 底部固定「儲存」。儲存咗嘅分組摺埋顯示「✓ 已儲存」。
- 「睇相」：開 `LabDocViewer`。
- 目標：一個病人、編號吻合、金額一致 → 由打開到儲存 **≤ 3 下**（確認頭部、儲存；如需要確認到貨再加 1）。

### 12.3 `/lab-docs/statements/[id]`（電腦優先）

- 頭：Lab、月份、頁數、讀法（文字／相）、上傳人；「睇原檔」「取代舊版」；收款人警告。
- 統計：月結單總數、系統已對、差額、分段確認進度。
- 分段表：診所、醫生、單數、月結單、系統、差額、結果 chip、「對數 ›」。未識別分段排第一（「揀診所／醫生」）。

### 12.4 `/lab-docs/statements/[id]/sections/[sid]`

- 篩選 chip：全部／唔同／系統冇／月結單冇。
- 明細型：按 invoice 分組，每行「月結／系統」並排（數量、單價、金額），唔同嘅數字紅色粗體。
- 單號型：每張一行（單號、日期、病人、月結單金額、系統金額、結果）。
- 欠款型：「本月」同「舊欠」兩組；舊欠灰色。
- 差異行展開：處理選項（§8.3）＋原因輸入＋「睇 invoice」。
- 「確認呢段」：條件未齊時 disable，hover／撳顯示「仲有 N 行未處理」。

### 12.5 `/lab-docs/archive`、`LabDocViewer`

見 §4.3。

### 12.6 `/lab-docs/settings`（`lab_statement`）

- 每間 Lab：月結單類型、單號類型、月結單單號同 invoice 一樣？、讀單提示（≤500 字）、已知收款人、別名清單（可刪）、客戶編號表。
- 容量統計。

### 12.7 成本錄入頁改動

- 表格：有連單 → 「單」icon（§4.3）。
- 編輯 modal：`labInvoiceLinked = true` → 折扣欄顯示「已連 invoice，唔套月度折扣」。
- 作廢：§7.9 提示。

---

## 13. 改舊 code

| 檔 | 改乜 | 原因 |
|---|---|---|
| `api/cost-cases/[id]/route.ts` PUT | `existing.labInvoiceLinked` → `discountPctNum = null`、`dp = null`、`data.discountPct = null`；寫 `patientCodeNorm`；`lockedByRunId` 檢查改條件寫（`updateMany where { id, lockedByRunId: null }`，0 行 → 409）；audit 搬入 transaction | B4、F-13 |
| `api/cost-cases/[id]/route.ts` DELETE | §7.9（同 transaction 解除配對） | B7 |
| `api/cost-cases/route.ts` POST | 寫 `patientCodeNorm`；**新增**：目標 periodMonth（醫生×診所×月）已 LOCKED → 409（同 PUT 守衛③一樣） | F-26 |
| `api/cost-cases/route.ts` GET | 回應加 `labDocs`、`labInvoiceLinked` | §4.3 |
| `api/cost-cases/recompute/route.ts` | where 加 `labInvoiceLinked: false` | B4 |
| `api/lab-discounts/route.ts` POST | `affectedCount` 同提示加 `labInvoiceLinked: false` | B4 |
| `lib/cost-entry/` | 新 `patient-code.ts`（`normPatientCode`）＋test | B13 |
| `lib/sensitive-audit.ts` | §14 新 action | 守門 |
| `lib/permissions.ts`、`lib/config.ts`、`layout.tsx`、`mobile-more/page.tsx` | §10 | 權限 |
| `docker-compose.yml`、`Dockerfile`（如需）、`.env.example` | volume、env | §4 |
| `scripts/backup.sh`、`restore-drill.sh`、`README-CRONTAB.md`、`docs/DEPLOYMENT.md`、`docs/PDPO.md` | §4.4、§4.5、§16 | 存底 |

---

## 14. Audit（全部入 `src/lib/sensitive-audit.ts`）

| action | 分類 | before／after |
|---|---|---|
| `LAB_DOC_UPLOAD` | EXEMPT | after：fileIds、kind、頁數、sha256 前 12 位 |
| `LAB_DOC_CONFIRM` | SPEC | 有改嘅頭部欄、行欄（唔記姓名） |
| `LAB_DOC_VOID` | SPEC | status、reason |
| `LAB_DOC_MERGE` | EXEMPT | 舊 ids → 新 id |
| `LAB_DOC_LINE_MATCH` | SPEC | lineId、costCaseId、linkType |
| `LAB_DOC_LINE_UNMATCH` | SPEC | 同上＋原因 |
| `LAB_DOC_LINE_IGNORE` | EXEMPT | lineId、reason |
| `LAB_DOC_PRICE_UPDATE` | SPEC | baseCost、discountPct、finalCost |
| `LAB_DOC_CASE_CREATE` | SPEC | 新成本主要欄 |
| `LAB_DOC_AMOUNT_REVIEW` | SPEC | reviewedBy |
| `LAB_DOC_PAYEE` | SPEC | payeeRaw、動作 |
| `LAB_DOC_FILE_DOWNLOAD` | EXEMPT | fileId |
| `LAB_DOC_IMAGE_PURGE` | EXEMPT | 數量 |
| `LAB_ALIAS_LEARN` | SPEC | 類型、rawNorm、目標 id、舊目標 id |
| `LAB_ALIAS_DELETE` | SPEC | 同上 |
| `LAB_PROFILE_UPDATE` | SPEC | 改咗嘅欄 |
| `LAB_STATEMENT_SECTION_ASSIGN` | SPEC | clinicId、providerId |
| `LAB_STATEMENT_RESOLVE` | SPEC | lineId、resolution、note |
| `LAB_STATEMENT_ADJUST` | SPEC | 行同成本 before／after（B6 STATEMENT_WINS） |
| `LAB_STATEMENT_RECONCILE` | SPEC | 分段結果統計、差額 |
| `LAB_STATEMENT_SUPERSEDE` | SPEC | 舊 id、新 id、原因 |

- Audit 嘅 `clinicId` 填文件或成本嘅診所。
- **任何 audit、console log 都唔准有 patientNameRaw／patientRaw／原檔內容**。`scripts/check-pii.sh` 加一個 test：labdoc 寫 audit 嘅 helper（`labdocAudit()`）收到含姓名欄嘅 object 要 throw。

---

## 15. 測試

### 15.1 Fixtures（`apps/web/test/fixtures/labdoc/`，姓名全部遮咗）

| 檔 | 來源 |
|---|---|
| `goodwill-invoice-IN194756.json` | QA 報告 §2.1 AI 輸出 |
| `kea-case-0254131.json`、`modern-I260120289.json`、`sodental-INV-260805010.json` | QA 報告 §2.2–2.4 |
| `sodental-statement-2026-09-aegis.txt` | 禾呈 9 月 PDF 文字層（3 頁，3 醫生，姓名遮） |
| `excel-outstanding-2026-09.txt` | Excel 9 月 PDF 文字層（姓名遮） |
| `goodwill-statement-2026-09-aegis.json` | IN195193 30/9/2026 $1,830，Dr Ho Ka Chun，滙樂 |
| `modern-statement-2026-06.json`、`goodwill-statement-2026-06.json`、`sodental-statement-2026-08-tw.json` | QA 報告 §2.5–2.7（有支票：`CHEQUE_PRESENT`；D3 有行睇唔到） |
| `sample-text.pdf`、`sample-scan.pdf` | 自製 2 頁 PDF（一個有文字層、一個冇） |

### 15.2 單元（`tsx --test`）

- `normPatientCode`：`7159`@TW → `TW007159`；`TY9845` → `TY009845`；`#7595` → `TW007595`；`tw8899` → `TW008899`；`2886`@青（中文 shortName）→ null；`0172649`（7 位）→ null。
- `normLabName`、`normDoctor`、地址抽取（中英）、`湾→灣`。
- 敏感數字過濾（§5.6 清單）。
- §5.5 檢查：Σ 唔等擋；total null 擋；Sodental 8 月 D3 Σ 17,490 vs 21,330 → 分段紅。
- `statement-match.ts`：
  - 禾呈 9 月 Dr Tong：系統「全鋯」qty 2 → QTY_DIFF、差 560。
  - Excel：202609-0509、0811 CURRENT MATCHED；202512-0885 之前已確認 → PREVIOUSLY_MATCHED；202603-1202 → MISSING_IN_SYSTEM；statedCurrent 1,061。
  - Modern 6 月：docNoSame=false → fallback MATCHED 250；980 vs 1030 → AMOUNT_DIFF（唔再係 MISSING＋月結單冇）。
  - DETAIL 冇單號行 → NEEDS_MANUAL；PAYMENT／BF → NOT_APPLICABLE。
  - 反向：只有 M、M+1 都確認先入 NOT_ON_STATEMENT。
- 折扣：`labInvoiceLinked = true` 嘅成本，PUT（有傳 labId、冇傳 labId）、recompute、lab-discounts POST 都唔會套折扣（`finalCost = baseCost`）。
- 加密：encrypt → decrypt 一樣；改一 byte → throw；舊 kid 解得。

### 15.3 API（真 DB，跟現有 route test 做法）

| # | 情境 | 預期 |
|---|---|---|
| T1 | 上傳 → stub 讀單 → 確認 → 儲存（一致） | RECONCILED；成本 `labInvoiceLinked=true` |
| T2 | 改價 KEA 550→440，成本有 discountPct 8.5 快照 | finalCost 440、discountPct null |
| T3 | 填價 + 確認到貨，目標月已鎖 | 409，冇任何寫入 |
| T4 | 同 idempotencyKey 送兩次「新增成本」 | 只得 1 筆成本；第二次回同一個 response |
| T5 | 兩個請求同時將同一行對去兩筆成本（Promise.all） | 一個 200，一個 409；DB 行只連一筆 |
| T6 | 兩個請求同時將同一筆成本做兩張單嘅 MAIN | 一個 200，一個 400／409 |
| T7 | 儲存途中成本被鎖（stub：先鎖再儲存） | 409，行冇變 |
| T8 | 同一個 PDF（sha256）上傳兩次 | 第二次 409 duplicateOf |
| T9 | 兩張相讀到同一 INVOICE_NO（並發） | 一張 NEEDS_REVIEW、一張 DUPLICATE |
| T10 | 冇 lab_invoice 嘅 EMPLOYEE call 每條 route | 403 |
| T11 | lab_invoice 用戶 call resolve／confirm／supersede | 403 |
| T12 | IDOR：save 帶另一 Lab 或另一病人嘅 costCaseId | 400 |
| T13 | 作廢已連 invoice 嘅成本 | 行 UNMATCHED，文件 RECONCILED → CONFIRMED/PARTIAL |
| T14 | 補收費：已有 MAIN 嘅成本再連 SUPPLEMENT $80 → 改價 | baseCost = 主單＋80 |
| T15 | 檔案 route：未登入 401；冇權限 403；已 purge 410；`Cache-Control: private, no-store` | — |
| T16 | purge：到期檔刪碟、清姓名、保留金額；中途 throw 再跑可以接住 | — |
| T17 | 讀單 stub 回 timeout ×3 | EXTRACT_FAILED；sweep 唔會再自動試 |
| T18 | 讀單 stub 回含 `040-543613-838` 嘅 lab.nameRaw、`INV-260805010` 嘅 docNoRaw | 前者刪、後者保留 |
| T19 | 月結單分段重複上傳 | 擋；supersede 後舊 SUPERSEDED |
| T20 | CSV 匯出含 `=cmd` | 輸出 `'=cmd` |

### 15.4 E2E（Playwright，`/opt/pw-browsers/chromium`）

1. 手機 viewport：上傳 fixture 相 → 確認 → 儲存 → 成本錄入表見到「單」icon → 撳開檢視器見到頁圖。
2. 電腦：上傳禾呈 9 月 PDF（stub 讀單）→ 三段 → Dr Tong 段處理 QTY_DIFF（INVOICE_WINS）→ 確認 → 待處理見到「同 Lab 跟進」。
3. 檔案庫：篩選 Lab＝Excel、月份＝2026-09 → 見到單 → 打開 → 下載原檔（audit 有紀錄）。

### 15.5 守門

`bash scripts/run-guards.sh` 全過；`npm test` 全過；`prisma migrate diff` 冇 drift（partial index 註明）。

---

## 16. 部署

| 項目 | 內容 |
|---|---|
| env | `LAB_DOC_DIR=/data/lab-docs`、`LAB_DOC_ENC_KEY`（`openssl rand -base64 32`）、`LAB_DOC_ENC_KID=k1`、`WA_INBOX_LABDOC_URL` |
| volume | `lab_docs`（compose）；host 備份路徑寫入 `backup.sh` 變數 `LAB_DOC_VOLUME_PATH` |
| cron（host，`README-CRONTAB.md`） | `*/5 * * * * curl -fsS -X POST -H "x-cron-key: $APRICOT_CRON_KEY" http://127.0.0.1:<port>/api/internal/labdoc-sweep`；`30 3 * * * … /api/internal/labdoc-purge` |
| wa-inbox | 先部署 `/api/internal/labdoc-extract`（§5.2）；未部署前 workforce 照用得（全部人手輸入） |
| 次序 | migration → seed → app → wa-inbox → cron → 開權限俾試用員工 |
| 回滾 | 新表唔影響舊功能；`labInvoiceLinked` 預設 false；回滾 app 唔使回滾 DB |

---

## 17. 分階段（每階段一個 PR，可獨立上線）

| 階段 | 內容 | 驗收 |
|---|---|---|
| **P1 存底＋上傳** | §3（LabFile、LabDocument、LabDocumentPage、LabProfile、alias 表、CostCase 新欄＋backfill）、§4 全部、權限 §10、`/lab-docs` 到貨單分頁（只上傳＋列表）、檔案庫＋檢視器、purge、備份 | T8、T10、T15、T16；E2E 3；守門全過；alpine 渲染 PDF 證明 |
| **P2 讀單＋invoice 對成本** | §5、§6、§7、成本錄入改動（§13 頭 5 行）、待處理（UNMATCHED_LINE、NOT_RECEIVED、RECEIVED_NO_INVOICE、LOCKED_ADJUST、AMOUNT_REVIEW、NEW_PAYEE、EXTRACT_FAILED） | T1–T7、T9、T12–T14、T17、T18；單元全部；E2E 1 |
| **P3 月結單** | LabStatementSection／Line、§8、待處理其餘類別、CSV | T11、T19、T20；statement-match 單元；E2E 2 |
| **P4 Lab 設定＋收尾** | §12.6、alias 管理、容量統計、`docs/specs/rbac-matrix.md`、`PDPO.md` | 守門；人手走一次 §15.1 全部 fixture |

wa-inbox §5.2 喺 P2 之前完成。

---

## 18. 上線前要現場核實

1. **Modern**：搵一張 6 月 Modern invoice，睇佢嘅 Invoice No. 同月結單 `IN-MDL…` 係咪同一個號 → 設 `statementDocNoSameAsInvoice`。
2. **真 `Clinic.shortName`**：repo 測試寫 TY＝屯門、青衣＝「青」，同模擬規格唔同；`normPatientCode` 要用真值。中文 shortName 嘅店要補英文前綴對照（`Clinic.patientCodePrefix`？如需要喺 P2 加欄）。
3. **土瓜灣醫生名單**：Dr Esmond Tong、Dr Yiu Tsz Ching（姚子晴）喺 `Provider` 有冇；冇就先開。
4. **禾呈（大圍）收款人 HONESTY GIFTS**：向 Lab 確認係合法收款人，先 seed 入 PAYEE alias。
5. **Alpine 下 `@napi-rs/canvas`、`sharp`、`pdfjs-dist`** 可用（P1 第一步）。
6. **wa-inbox vision 模型**：Qwen 3.8 27B 用 §15.1 fixture 嘅相跑一次，比較 QA 報告 §2 嘅讀數，準確率記入 PR。
