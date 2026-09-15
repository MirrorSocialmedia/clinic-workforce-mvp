# 臨床索引回填 — 限制說明（cwi-followup-p1-20260915）

> 來源：wa-clinic-inbox-followup-v2 §2.5。呢份文檔嘅內容要出現喺管理員 UI
> 嘅回填說明（P2/P4 做 UI 時引用）。

## 回填係咩

一次性 job：把過去 **365 日**嘅到訪記錄由 Apricot 同步入本系統索引
（`ClinicalRecordIndex`），分 **4 晚**完成（每晚約 90 日），每晚 03:00 跟
夜跑同一時間觸發，由 `cursorDate` 記住進度，中斷可續。

## 🔴 重要限制（必須讓使用者知道）

1. **只攞到「每個病人最後一次到訪」**
   回填用 Apricot `clinic-patients/search` 嘅 `lastVisitDate` 篩選，而呢個
   篩選**只回「最後一次到訪 = 嗰日」嘅病人**。所以回填唔會攞齊所有歷史
   到訪 — 例如一個病人 2026-01-05 同 2026-09-10 各有到訪，回填只會索引
   2026-09-10 嗰次（佢嘅「最後一次」），2026-01-05 嗰次唔會喺索引入面。

   - ✅ 啱用：D 類召回（「上次洗牙超過 6 個月」）— 啱啱好就要「最後一次」口徑。
   - ⚠️ 唔啱用：「某病人一年內**所有**到訪」— 唔完整。要睇齊歷史，
     用「病人記錄側欄」（`/patients/{id}/visits`）— 佢會即時打 Apricot
     拉齊該病人嘅預約＋記錄，唔靠回填。

2. **爽約（-3）記錄會入索引** — 爽約冇診症記錄、冇帳單，但 bookingStatus
   明確係 -3（可被 C 類觸發使用）。

3. **帳單口徑** — 索引行嘅 `billTtlAmt` / `billOsAmt` = 該次到訪當日非
   void 帳單合計（P1 口徑）；「病人層累計欠款」係 P4 F 類觸發時由
   consumer 直接讀 Apricot 病人主檔，唔係呢個數字。

## 護欄

| 護欄 | 值 | 行為 |
|---|---|---|
| maxCalls | 30,000 / 晚 | 到頂停當晚，第二晚由 cursor 續 |
| maxHours | 4 / 晚 | 到頂停當晚，第二晚由 cursor 續 |
| APRICOT_RATE_LIMITED | — | 即刻停當晚，第二晚由 cursor 續 |

中斷嗰日會喺第二晚**整日重跑**（upsert 冪等，重跑唔會產生重複行）。

## 進度查詢

`ClinicalIndexJob`（kind=`BACKFILL`）：`cursorDate` = 下一個未處理日，
`status`：RUNNING（進行中／暫停待續）→ DONE（365 日跑完）。
