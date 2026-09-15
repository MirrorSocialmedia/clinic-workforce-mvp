# 電話正規化驗證 report — cwi-followup-p0-20260915（S4）

- 日期：2026-09-15（Asia/Hong_Kong）
- 數據源：內置 stub corpus（dev 無 APRICOT credential — 格式分布照 MD §0.4 實測）
- 函數：src/lib/phone.ts normalizeHkPhones（MD §1.2 逐字）

## 結果：93.0% 可正規化（門檻 ≥ 90%）→ **PASS ✅**

| 類別 | 數目 | 比例 |
|---|---|---|
| 可正規化（含多號） | 186 | 93.0% |
| 其中多號（>1 hash） | 15 | 7.5% |
| 唔合法（0 hash） | 14 | 7.0% |

## 按 raw 長度分桶（MD §0.4 實測 8 / 19 字）

| 長度 | 病人 | 可正規化 |
|---|---|---|
| 5 | 1 | 0 |
| 6 | 1 | 0 |
| 8 | 109 | 108 |
| 9 | 3 | 0 |
| 11 | 60 | 60 |
| 14 | 1 | 0 |
| 20 | 18 | 18 |
| 21 | 1 | 0 |

## 唔合法 sample（raw 已 mask — 原始號碼唔離 workforce）

- stub-p-187: []
- stub-p-188: []
- stub-p-189: []
- stub-p-190: []
- stub-p-191: []
- stub-p-192: []
- stub-p-193: [123***]
- stub-p-194: [111***]
- stub-p-195: [852***]
- stub-p-196: [234***]
- stub-p-197: [912***]
- stub-p-198: [612***]
- stub-p-199: [912***]
- stub-p-200: [+85***]

## 多號 sample（前 10）

- stub-p-161: 2 個 hash
- stub-p-162: 2 個 hash
- stub-p-163: 2 個 hash
- stub-p-164: 2 個 hash
- stub-p-165: 2 個 hash
- stub-p-167: 2 個 hash
- stub-p-168: 2 個 hash
- stub-p-169: 2 個 hash
- stub-p-170: 2 個 hash
- stub-p-171: 2 個 hash

## 備註

- dev 環境無 APRICOT credential — 呢份 report 係 stub corpus 結果（格式分布照 MD §0.4 實測）。
- **上線前必喺有 credential 嘅環境用真 200 病人重跑**（--input 模式），rate < 90% 要停手檢討。
- spec 已知行為：號內空位會被當分隔符（fragment 4 位 → 丟）。MD §0.4 實測 8/19 字格式均無號內空位。
