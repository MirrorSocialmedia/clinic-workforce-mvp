# 醫生時間表：Apricot → clinic-workforce 完整鏈（v2 — 已對實 JSON）

日期：2026-08-19
UI 來源：`wa-clinic-inbox-mobile-and-schedule.md` §5
資料來源：`GET /services/aepsmsappt/api/appointments/getOverviewAppointments`
拍板：①除青衣外五間有 `apricotClinicId` ②08-21 每 10 分鐘／其餘每 60 分鐘 ③**滾動 7 日**
④第一版**直接用預約 JSON**（含預約數）

---

## 零、實際 JSON 結構（v1 假設有五處錯）

```jsonc
{
  "2026-08-19": {                          // ★ 頂層 key = 日期，一次 call 返多日
    "appointments": {
      "696604810fb31f000937a8c4": {        // ★ key = practitioner.id
        "practitioner": { "id", "code", "fullName", "nickname", … },
        "practitionerOpenSchs": {          // ★ 係 object 唔係 array
          "day": "WED",
          "timeSlots": [{ "startTime": 900, "endTime": 1800 }]   // ★ HHMM 整數
        },
        "bookingDetail": [ … ]             // ★ 預約陣列，length = 預約數
      }
    },
    "blocks": [],
    "groupClasses": []
  }
}
```

| # | 我原本以為 | 實際 |
|---|---|---|
| 1 | 要逐日 call | **一次 call 返晒範圍內每一日**（頂層 key = 日期）→ 7 日 = 1 個 request |
| 2 | `practitionerOpenSchs` 係 array | **object** `{ day, timeSlots[] }` |
| 3 | 時間係 `"HH:mm"` | **HHMM 整數**：`900` = 09:00、`1800` = 18:00、`2000` = 20:00 |
| 4 | 預約數要另外攞 | `bookingDetail[]` —— ★ 每筆有 `bookingTime`/`bookingEndTime`（ISO UTC），可以砌真嘅 busy 塊 |
| 5 | PII 主要係 `visitReasons` | **`clinicPatient` 成個 object 內嵌**（見 §一） |

★ **第 1 點令 request 數由 6×7 變返 6** —— 每 10 分鐘 6 個 request，唔係 42 個。

---

## 一、🔴 PII —— 呢個 response 係目前見過最危險

**一筆預約入面實見嘅敏感欄：**

```
clinicPatient.personalIdentifier   HKID
clinicPatient.address / phoneNum / email / dateOfBirth
clinicPatient.medicalHistory       「沒有 None」← 病歷欄
clinicPatient.drugHistory.historyDes 「其他，請註明: —」
clinicPatient.emergencyContact     姓名 + 電話 + 關係（母子）
clinicPatient.occupation / gender / bloodType / phoneList[]
clinicPatient.billOsAmt            欠款金額
visitReasons[].des                 "RV" / "PAIN" ← 求診原因 = 病情
remarkByDoctor                     "after mos & implant pain" ← ★病情自由文字
createdBy / lastModifiedBy         "JOAN NURSE" ← 員工姓名
```

### 1.1 白名單（開診 4 欄 ＋ 預約 4 欄）

★ **更正（2026-08-19）**：我上一版當咗「冇逐 slot 預約資料」，**錯**。
`bookingTime` / `bookingEndTime` 一直喺 `bookingDetail[]` 入面，
實測 `2026-08-19T01:30:00Z` → HK 09:30–10:00，同 Apricot 畫面完全對得上。
時間戳唔係 PII —— **要抽**。

```ts
// lib/apricot/availability.ts

/** 開診時段 —— 只抽四樣 */
function extractOpenSch(dateStr: string, node: any) {
  const slots = node?.practitionerOpenSchs?.timeSlots
  if (!Array.isArray(slots)) return []
  return slots
    .map((t: any) => ({
      date: dateStr,
      startTime: hhmmIntToStr(t?.startTime),   // 900 → '09:00'
      endTime: hhmmIntToStr(t?.endTime),       // 1800 → '18:00'
    }))
    .filter(r => r.startTime && r.endTime)
}

/**
 * 預約時段 —— 🔴 只抽四樣，其餘一律唔掂
 *   ✅ bookingTime / bookingEndTime（ISO UTC 時間戳）
 *   ✅ bookingStatus（整數）· isRemoved（boolean）
 *   ❌ clinicPatient（HKID/病歷/電話/地址/緊急聯絡人）
 *   ❌ visitReasons（"PAIN" = 求診原因 = 病情）
 *   ❌ remarkByDoctor（"after mos & implant pain" = 病情自由文字）
 *   ❌ createdBy / lastModifiedBy（員工姓名）· code · cpId · patientId
 */
function extractBookings(dateStr: string, node: any) {
  const arr = node?.bookingDetail
  if (!Array.isArray(arr)) return []
  const out: { date: string; startMin: number; endMin: number; status: number }[] = []
  for (const b of arr) {
    if (b?.isRemoved === true) continue
    const s = utcIsoToHkMin(b?.bookingTime)
    const e = utcIsoToHkMin(b?.bookingEndTime)
    if (s == null || e == null || e <= s) continue
    out.push({ date: dateStr, startMin: s, endMin: e, status: Number(b?.bookingStatus ?? -1) })
  }
  return out
}

/** ISO UTC → HK 當日「由 00:00 起嘅分鐘數」；跨日／格式錯回 null */
function utcIsoToHkMin(iso: unknown, dateStr?: string): number | null {
  if (typeof iso !== 'string' || !iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const hk = new Date(t + 8 * 3600 * 1000)
  // ★ 跨日檢查：預約嘅 HK 日期要同 node 個日期一致，唔係就跳過
  if (dateStr && hk.toISOString().slice(0, 10) !== dateStr) return null
  return hk.getUTCHours() * 60 + hk.getUTCMinutes()
}

/** HHMM 整數 → 'HH:mm'；900 → '09:00'，2000 → '20:00' */
function hhmmIntToStr(n: unknown): string {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0 || v > 2359) return ''
  const str = String(Math.floor(v)).padStart(4, '0')
  const hh = str.slice(0, 2), mm = str.slice(2)
  if (Number(mm) > 59) return ''
  return `${hh}:${mm}`
}
```

⚠️★★★ **`extractBookings` 個 return 型別只准四個 primitive** ——
唔可以回 `b` 本身或者任何 sub-object。一回 object，`clinicPatient` 就跟住入 scope。

⚠️ **`utcIsoToHkMin` 個 `dateStr` 跨日檢查** —— 頂層 key 係 HK 日期，
但 `bookingTime` 係 UTC。HK 00:00–08:00 嘅預約，UTC 會落喺前一日。
唔檢查就會把預約放錯日。**實測樣本冇早過 09:00，但唔可以假設。**

### 1.2 probe 工具要改

```
❌ console.log(JSON.stringify(raw))
✅ 只 log：日期數、practitioner 數、timeSlots 數、bookingDetail 長度
```

---

## 二、★兩個新問題（實際 JSON 揭示）

### 2.1 API 返嘅 practitioner 多過 `Provider.apricotId` 存嘅六個

樣本入面出現：

| id | code | 喺 memory 六個之內？ |
|---|---|---|
| `696604810fb31f000937a8c4` | **002 / "MF Clinic"** | ❌ **唔係醫生** —— 診所層假 practitioner |
| `695e6e511e430c48022a7690` | LAU | ❌ 唔喺六個之內 |
| `695ff0c999883d05d0582402` | YEUNG | ❌ 唔喺六個之內 |
| `695ff0c999883d05d0582401` | TONG | ✓ |

**兩件事：**

**① `MF Clinic`（code `002`，`firstName: "MF Clinic"`）唔係醫生** ——
佢有開診時段 900-1800 同一個預約。呢個似係「診所自己」嘅 pseudo-practitioner。

**② `LAU` / `YEUNG` 係真醫生但 `Provider` 冇存佢哋嘅 `apricotId`**
（memory 六個：HO / MA / TSE / YIU / TONG / AEGIS）。

**處理：**

```ts
  // 用 apricotId 對 Provider；對唔到就跳過 + 記低
+ const knownIds = new Map(providers.map(p => [p.apricotId!, p.id]))
+ const unknown = new Set<string>()
  …
+ const providerId = knownIds.get(apricotProviderId)
+ if (!providerId) { unknown.add(`${apricotProviderId}:${node?.practitioner?.code ?? '?'}`); continue }
  …
+ if (unknown.size > 0) {
+   console.warn(`[availability] ${unknown.size} 個 Apricot practitioner 未對應 Provider：`,
+                [...unknown].join(', '))
+ }
```

⚠️ **唔好自動建 `Provider`** —— `MF Clinic` 呢類假 practitioner 會被建成醫生，
而且 `Provider` 有 `commission` / `payout` 下游。**人手對應先安全。**

★ **落刀前你要做**：睇 warning 列表，決定邊個要補 `apricotId`、邊個係 pseudo 要忽略。
建議加一個 `Provider.ignoredApricotIds` 之類？**唔好** —— 用 warning 就夠，
補齊之後 warning 自己會消失。

### 2.2 青衣冇 `apricotClinicId`

```ts
+ const clinics = await prisma.clinic.findMany({
+   where: { apricotClinicId: { not: null } },
+   select: { id: true, name: true, apricotClinicId: true },
+ })
+ const skipped = await prisma.clinic.count({ where: { apricotClinicId: null } })
+ if (skipped > 0) console.warn(`[availability] ${skipped} 間診所冇 apricotClinicId，唔會 sync`)
```

⚠️ **UI 要顯示「未接通」唔係「未開診」** —— 否則青衣永遠空白，冇人知係設定問題。

```tsx
{clinic.apricotClinicId
  ? (days.length ? <Grid/> : <Empty text="未開診" />)
  : <Empty text="呢間診所未接通 Apricot" tone="warn" />}
```

---

## 三、資料層

### 3.1 Schema —— 兩張表

**開診同預約係兩種粒度**（開診 = 每日一兩段；預約 = 每日十幾筆、可以重疊），
夾埋一張表會令 `bookedCount` 落錯位。分開先啱。

```prisma
+ /// Apricot 開診時段（零 PII）
+ model ProviderAvailability {
+   id          String   @id @default(cuid())
+   clinicId    String
+   clinic      Clinic   @relation(fields: [clinicId], references: [id], onDelete: Cascade)
+   providerId  String
+   provider    Provider @relation(fields: [providerId], references: [id], onDelete: Cascade)
+   date        String   // 'YYYY-MM-DD'（HK）
+   startTime   String   // 'HH:mm'
+   endTime     String   // 'HH:mm'
+   syncedAt    DateTime @default(now())
+
+   @@unique([clinicId, providerId, date, startTime])
+   @@index([clinicId, date])
+ }
+
+ /// Apricot 預約時段（🔴 零病人資料 —— 只有時間同狀態）
+ /// ⚠️ 呢張表【永遠】唔准加病人／病情／員工姓名任何欄
+ model ProviderBooking {
+   id          String   @id @default(cuid())
+   clinicId    String
+   clinic      Clinic   @relation(fields: [clinicId], references: [id], onDelete: Cascade)
+   providerId  String
+   provider    Provider @relation(fields: [providerId], references: [id], onDelete: Cascade)
+   date        String   // 'YYYY-MM-DD'（HK）
+   startMin    Int      // 由 00:00 起嘅分鐘數（09:30 → 570）
+   endMin      Int
+   status      Int      // Apricot bookingStatus；實見 0（已約）/ 4（已完成）
+   syncedAt    DateTime @default(now())
+
+   @@index([clinicId, date])
+   @@index([providerId, date])
+ }
```

⚠️ **`ProviderBooking` 冇 `@@unique`** —— 同一時段可以有多筆預約（實測圖一
11:15–11:45 有四筆並排），加 unique 會刪錯資料。靠「先刪後寫」保證唔重複。

⚠️ **`startMin` / `endMin` 用 `Int` 唔用 `String`** —— UI 要做 overlap 合併同排序，
分鐘數直接計；而開診嗰張表係純顯示所以用 `'HH:mm'` 字串。**兩張表刻意唔同，唔係手誤。**

⚠️ **存 `status` 但第一版唔 filter** —— memory 記低 `bookingStatus` 1/2/3/5 未知，
而圖一見到有 ✕（取消）同 ❗ 標記。**先存落嚟，日後知道邊個係取消就可以 filter 而唔使重 sync。**

⚠️ 兩張表都要加 `Provider` / `Clinic` 嘅 back-relation。

### 3.2 Sync（一次 call 拎晒 7 日，寫兩張表）

```ts
export async function syncAvailability(clinic: { id: string; apricotClinicId: string }) {
  const start = hkTodayStr()
  const end = addDaysStr(start, 6)          // ★ 滾動 7 日

  const providers = await prisma.provider.findMany({
    where: { isActive: true, apricotId: { not: null } },
    select: { id: true, apricotId: true },
  })

  const qs = new URLSearchParams()
  qs.set('startDate', start)
  qs.set('endDate', end)
  qs.set('openSchClinicId', clinic.apricotClinicId)   // ★ 單數
  for (const p of providers) qs.append('doctorIds', p.apricotId!)   // ★ 逐個列

  // ★ 只 call，唔喺呢度攞 lock —— lock 由外層一次過包住六間店（見 §3.3）
  const raw = await withApricotLockRetry(() =>
    apricotCall(`/services/aepsmsappt/api/appointments/getOverviewAppointments?${qs}`))

  const knownIds = new Map(providers.map(p => [p.apricotId!, p.id]))
  const unknown = new Set<string>()
  const availRows: any[] = []
  const bookRows: any[] = []

  for (const [dateStr, dayNode] of Object.entries(raw ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue      // ★ 過濾非日期 key
    const appts = (dayNode as any)?.appointments
    if (!appts || typeof appts !== 'object') continue

    for (const [apricotPid, node] of Object.entries(appts)) {
      const providerId = knownIds.get(apricotPid)
      if (!providerId) {
        unknown.add(`${apricotPid}:${(node as any)?.practitioner?.code ?? '?'}`)
        continue
      }
      for (const o of extractOpenSch(dateStr, node)) {
        availRows.push({ clinicId: clinic.id, providerId, ...o })
      }
      for (const b of extractBookings(dateStr, node)) {
        bookRows.push({ clinicId: clinic.id, providerId, ...b })
      }
    }
  }

  if (unknown.size > 0) {
    console.warn(`[availability] ${clinic.id} 未對應 practitioner：`, [...unknown].join(', '))
  }

  // ★ 決定性：先刪窗口內再寫（兩張表同一個 transaction）
  await prisma.$transaction([
    prisma.providerAvailability.deleteMany({
      where: { clinicId: clinic.id, date: { gte: start, lte: end } },   // ★ clinicId 唔可以少
    }),
    prisma.providerBooking.deleteMany({
      where: { clinicId: clinic.id, date: { gte: start, lte: end } },   // ★ 同上
    }),
    prisma.providerAvailability.createMany({ data: availRows, skipDuplicates: true }),
    prisma.providerBooking.createMany({ data: bookRows }),              // ★ 唔加 skipDuplicates
  ])

  return { open: availRows.length, bookings: bookRows.length, unknown: unknown.size }
}
```

⚠️★★★ **兩個 `deleteMany` 個 where 都要有 `clinicId`** —— 少一個就刪晒其他診所。

⚠️ **`providerBooking.createMany` 唔加 `skipDuplicates`** ——
同一醫生同一時段真係可以有多筆（圖一實證），加咗會靜靜少計。

⚠️ **`extractBookings` 傳 `dateStr` 做跨日檢查**（§1.1）——
`utcIsoToHkMin(b.bookingTime, dateStr)`。上面個 call 我寫咗簡版，落刀要補返個參數。

### 3.3 ★★★ Advisory lock —— 我上一版用錯咗 function

```
withApricotLockRetry  ≠  withApricotLock
```

| function | 實際做咩 | 出處 |
|---|---|---|
| `withApricotLockRetry(fn)` | **重試** —— 撞到 `lock`／`busy`／`HTTP_503` 等 700ms 再試（最多 3 次）；`AUTH_EXPIRED` / `RATE_LIMITED` **直接 throw 唔重試** | `client.ts:68` |
| `withApricotLock(fn)` | **PostgreSQL advisory lock**（`pg_try_advisory_lock(776001)`）—— 攞唔到就 **`console.warn` ＋ 回 `null`** | `lock.ts:4` |

★ 我上一版寫 `withApricotLockRetry(() => apricotCall(...))`，**完全冇攞 advisory lock** →
availability sync 會同你現有嘅 bill／payment sync **同時打 Apricot**，
一齊搶 token rotation。memory 明確記低「**嚴格序列化寫**」。

**正確做法（照抄 `sync.ts:320`）：lock 包住外層，唔係包住每個 call。**

```ts
// app/api/internal/sync-availability/route.ts
+ import { withApricotLock } from '@/lib/apricot/lock'

  const result = await withApricotLock(async () => {
    const results: any[] = []
    for (const c of clinics) {          // ★ 六間店喺同一個 lock 入面順序做
      try {
        results.push({ clinic: c.name, ...(await syncAvailability(c)) })
      } catch (e: any) {
        console.error(`[availability] ${c.name} 失敗`, e?.message)
        results.push({ clinic: c.name, error: e?.message ?? String(e) })
      }
      await new Promise(r => setTimeout(r, 500))
    }
    return results
  })

+ // ★ 攞唔到 lock 會回 null（唔係 throw）—— 一定要處理
+ if (result === null) {
+   return NextResponse.json({ ok: false, skipped: 'another apricot call in progress' })
+ }
  return NextResponse.json({ ok: true, results: result })
```

⚠️★★★ **`withApricotLock` 攞唔到 lock 回 `null` 唔係 throw** ——
唔處理就會 `result.map(...)` 撞 `null.map`。

⚠️ **`LOCK_KEY = 776001` 係全域一個** —— 即係 availability sync 進行中，
bill sync 會被跳過（反之亦然）。10 分鐘一次 × 六間店 ×（每間 1 個 request）
應該幾秒內完，撞唔到；**但你手動跑 bill sync 嗰陣可能撞。**
console 會出 `[apricot] 已有 call 進行中，今次跳過` —— 唔係錯誤。

⚠️ **`withApricotLockRetry` 仍然要留喺 `apricotCall` 外面** ——
佢處理嘅係 Apricot 自己回 503／busy，同 advisory lock 係兩件事。**兩個都要。**

### 3.4 ⚠️ 三個前置條件（`apricotCall` 會直接 throw）

| 條件 | 唔滿足會點 |
|---|---|
| `ExternalCredential` 有 Apricot 三件套 | `loadCreds()` 回 null → `throw APRICOT_NOT_CONFIGURED` |
| `APRICOT_ENC_KEY` 環境變數（32-byte base64） | `token.ts:6` **模組載入時就 throw** |
| bot 帳號嘅 refresh_token 未過期（7 日 sliding） | HTTP 401/403 → `markError` ＋ `throw APRICOT_AUTH_EXPIRED` |

★ **`APRICOT_AUTH_EXPIRED` 唔會重試**（`client.ts:79` 明確 pass through）——
所以 cron 每 10 分鐘會不停撞同一個錯。**要加監控**：

```ts
+ // sync 失敗連續 N 次 → 寫 Notification 俾 OWNER
+ if (results.every(r => r.error?.includes('AUTH_EXPIRED'))) {
+   console.error('[availability] Apricot 認證失效 —— bot 帳號要重新登入')
+ }
```

⚠️ memory 記低「**sliding 7-day window，只要每 7 日打一次 API 就永遠唔死**」——
而家 10 分鐘一次，**反而係最好嘅 keep-alive**。但反過來講，
**一旦壞咗就每 10 分鐘失敗一次**，log 會被洗版。

---

## 四、排程（拍板②）

```bash
# crontab
*/10 8-20  * * *  /home/clinicapp/clinic/scripts/sync-availability.sh
0    21-23,0-7 * * *  /home/clinicapp/clinic/scripts/sync-availability.sh
```

**每日 request：** 78（10 分鐘 × 13 小時）＋ 11（每小時）= **89 次 × 5 間店 = 445 個 request**

★ 比原本估算（864）少一半 —— 因為**一次 call 返晒 7 日**。

```bash
#!/usr/bin/env bash
# scripts/sync-availability.sh
set -euo pipefail
exec 9>/tmp/.availability-sync.lock
flock -n 9 || { echo "$(date '+%F %T') 上次未完，跳過"; exit 0; }

curl -sS -X POST "http://localhost:3000/api/internal/sync-availability" \
  -H "X-Internal-Token: ${INTERNAL_SYNC_TOKEN}" --max-time 180 \
  >> /tmp/availability-sync.log 2>&1
```

⚠️ **`flock` 唔可以省** —— Apricot token 係共用三件套（memory：「嚴格序列化寫」）。

```ts
// app/api/internal/sync-availability/route.ts
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  // ★ 唔經 RBAC —— shared secret，冇 fallback 預設值
  if (!process.env.INTERNAL_SYNC_TOKEN) {
    console.error('[sync-availability] INTERNAL_SYNC_TOKEN 未設')
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }
  if (req.headers.get('x-internal-token') !== process.env.INTERNAL_SYNC_TOKEN) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const clinics = await prisma.clinic.findMany({
    where: { apricotClinicId: { not: null } },
    select: { id: true, name: true, apricotClinicId: true },
  })

  // ★ 見 §3.3 —— 一定要用 withApricotLock 包住，唔係 withApricotLockRetry
  const result = await withApricotLock(async () => { /* … §3.3 個 for loop … */ })
  if (result === null) {
    return NextResponse.json({ ok: false, skipped: 'another apricot call in progress' })
  }
  return NextResponse.json({ ok: true, results: result })
}
```

⚠️ **一間失敗唔中斷其餘** ✓（逐間 try/catch）

⚠️ **`check-rbac-matrix.sh` 會唔會 fail？** `/api/internal/*` 唔喺 RBAC_MATRIX ——
**落刀前跑一次**，需要就加豁免清單。

---

## 五、API route

```
GET /api/provider-availability?clinicId=<Clinic.id>&from=YYYY-MM-DD
```

### 5.1 回傳格式

```ts
{
  clinic: { id, name, connected },              // connected = !!apricotClinicId
  from: '2026-08-19',
  days: [{
    date: '2026-08-19',
    providers: [{
      providerId, name, color,
      open: [{ s: 600, e: 1200 }],              // 開診（分鐘數）
      busy: [{ s: 570, e: 600, count: 1 }],     // ★ 真實預約時段（合併重疊）
      total: 14,                                // 當日預約總數
    }],
  }],
  sync: { lastSyncAt, stale },                  // stale = max(syncedAt) > 30 分鐘
}
```

### 5.2 ★ 重疊合併（唔可以照抄原版 `mergeRanges`）

原版 `mergeRanges()` 假設 slot 唔重疊。**但實測圖一 11:15–11:45 有四筆並排。**
要改成「掃描線」合併，保留 count：

```ts
/** 重疊嘅預約合併成一段，count = 該段最高同時預約數 */
function mergeBookings(rows: { startMin: number; endMin: number }[]): Range[] {
  if (rows.length === 0) return []
  const sorted = [...rows].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)
  const out: Range[] = []
  let cur = { s: sorted[0].startMin, e: sorted[0].endMin, count: 1 }
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i]
    if (r.startMin <= cur.e) {                 // ★ 重疊或者相接 → 合併
      cur.e = Math.max(cur.e, r.endMin)
      cur.count += 1
    } else {
      out.push(cur)
      cur = { s: r.startMin, e: r.endMin, count: 1 }
    }
  }
  out.push(cur)
  return out
}
```

⚠️ **`r.startMin <= cur.e` 用 `<=` 唔用 `<`** —— 09:30–10:00 同 10:00–10:30
係連續唔係重疊，但畫出嚟應該係一整條。用 `<` 會斷開成兩格，中間出現一條假空隙。

⚠️ **`count` 係「該段總預約數」唔係「同時預約數」** ——
掃描線做真嘅「最高並發」要 sweep event，複雜好多。
第一版 `count` 當「呢段時間入面有幾多個預約」已經夠用（tooltip 顯示）。
**但唔好喺 UI 寫「同時 N 人」**，寫「N 個預約」。

### 5.3 其餘照抄，三處改

| 上傳 MD | clinic-workforce |
|---|---|
| `requireAuth` | **`requirePerm(req, 'scheduling')`** |
| `AvailabilitySlot` | `ProviderAvailability` ＋ `ProviderBooking` |
| `ApricotSession.lastSyncAt` | **`max(syncedAt)`** |

```ts
+ 'GET /api/provider-availability': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
+ // RBAC_PERM_OVERRIDES
+ 'GET /api/provider-availability': ['scheduling'],
```

⚠️ **診所 scope** —— MANAGER 唔應該睇到其他公司。照抄 `provider-schedule/route.ts`。

⚠️ **`weekStart` 改名做 `from`** —— 拍板③係滾動 7 日，留住舊名會令下個人以為固定週。

## 六、UI（完整代碼，已改成 clinic-workforce 版）

### 6.1 `apps/web/src/app/(protected)/provider-availability/page.tsx` — 新增

```tsx
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

interface Range { s: number; e: number; count?: number }
interface DayProvider { providerId: string; name: string; color: string | null; open: Range[]; busy: Range[] }
interface ScheduleDay { date: string; providers: DayProvider[] }
interface ScheduleResp {
  clinic: { id: string; name: string; connected: boolean }
  from: string
  days: ScheduleDay[]
  sync: { lastSyncAt: string | null; stale: boolean }
}
interface ClinicOpt { id: string; name: string; connected: boolean }

// ★ 醫生色：優先用 Provider.color（schema :325 已有），冇值先 hash
const FALLBACK = ['#6366f1', '#059669', '#d97706', '#64748b', '#db2777', '#0891b2']
function palette(seed: string, color: string | null) {
  if (color) return color
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return FALLBACK[Math.abs(h) % FALLBACK.length]
}
/** 同色淺底（band）—— 直接用 8 位 hex alpha，唔使多開一個 palette */
const soft = (hex: string) => `${hex}22`

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']
const fmtMin = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

function hkTodayStr(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** open − busy → 空閒 gap（>=30 分鐘先顯示，太碎冇意義） */
function freeGaps(open: Range[], busy: Range[]): Range[] {
  const gaps: Range[] = []
  for (const o of open) {
    let cur = o.s
    for (const b of busy.filter(b => b.s < o.e && b.e > o.s).sort((a, b2) => a.s - b2.s)) {
      if (b.s - cur >= 30) gaps.push({ s: cur, e: b.s })
      cur = Math.max(cur, b.e)
    }
    if (o.e - cur >= 30) gaps.push({ s: cur, e: o.e })
  }
  return gaps
}

export default function ProviderAvailabilityPage() {
  const [clinics, setClinics] = useState<ClinicOpt[]>([])
  const [clinicId, setClinicId] = useState<string>('')
  const [from, setFrom] = useState(hkTodayStr())        // ★ 滾動 7 日（唔係 weekStart）
  const [data, setData] = useState<ScheduleResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [zoomDate, setZoomDate] = useState<string | null>(null)

  // 診所清單（★ 用返現有 /api/clinics，唔開新 API）
  useEffect(() => {
    fetch('/api/clinics', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : { clinics: [] }))
      .then(d => {
        const list: ClinicOpt[] = (d.clinics ?? []).map((c: any) => ({
          id: c.id, name: c.name, connected: !!c.apricotClinicId,
        }))
        setClinics(list)
        if (!clinicId && list.length) setClinicId(list.find(c => c.connected)?.id ?? list[0].id)
      })
      .catch(() => setClinics([]))
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!clinicId) return
    setLoading(true); setError(null)
    try {
      const r = await fetch(
        `/api/provider-availability?clinicId=${encodeURIComponent(clinicId)}&from=${from}`,
        { credentials: 'include', cache: 'no-store' },
      )
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setData(await r.json())
    } catch {
      setError('載入失敗 — 撳重試')
    } finally {
      setLoading(false)
    }
  }, [clinicId, from])

  useEffect(() => { void load() }, [load])

  // ★ 10 分鐘 sync 一次 → 前端每 5 分鐘 refetch，唔使人手撳
  useEffect(() => {
    const t = setInterval(() => { void load() }, 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [load])

  // 時間軸範圍：跟資料（floor/ceil 到整點），fallback 08:00–21:00
  const [axisMin, axisMax] = useMemo(() => {
    let lo = Infinity, hi = -Infinity
    for (const d of data?.days ?? [])
      for (const p of d.providers)
        for (const r of p.open) { lo = Math.min(lo, r.s); hi = Math.max(hi, r.e) }
    if (!isFinite(lo)) return [8 * 60, 21 * 60]
    return [Math.floor(lo / 60) * 60, Math.ceil(hi / 60) * 60]
  }, [data])
  const span = Math.max(1, axisMax - axisMin)
  const pct = (m: number) => `${(((m - axisMin) / span) * 100).toFixed(2)}%`
  const pctH = (s: number, e: number) => `${(((e - s) / span) * 100).toFixed(2)}%`

  const today = hkTodayStr()
  const axisLabels = useMemo(() => {
    const out: number[] = []
    for (let m = axisMin; m <= axisMax; m += 120) out.push(m)
    return out
  }, [axisMin, axisMax])

  const cur = clinics.find(c => c.id === clinicId)
  const zoomDay = zoomDate ? data?.days.find(d => d.date === zoomDate) ?? null : null

  /** 一條日 column（桌面 + 手機放大共用；mini = 手機週概覽縮版） */
  function DayColumn({ day, mini }: { day: ScheduleDay; mini: boolean }) {
    if (day.providers.length === 0) {
      return (
        <div style={{ position: 'relative', height: '100%', borderRadius: 6, background: '#f1f5f9',
                      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: '#94a3b8', fontSize: mini ? 9 : 12,
                         writingMode: mini ? 'vertical-rl' : undefined }}>
            {data?.sync.lastSyncAt ? '休診' : '未同步'}
          </span>
        </div>
      )
    }
    return (
      <div style={{ position: 'relative', height: '100%', borderRadius: 6,
                    background: '#f1f5f9', overflow: 'hidden' }}>
        {day.providers.map(pr => {
          const c = palette(pr.providerId, pr.color)
          const gaps = mini ? [] : freeGaps(pr.open, pr.busy)
          return (
            <div key={pr.providerId} style={{ position: 'absolute', inset: 0 }}>
              {pr.open.map((o, i) => (
                <div key={`o${i}`} style={{ position: 'absolute', left: 0, right: 0,
                       background: soft(c), top: pct(o.s), height: pctH(o.s, o.e) }}>
                  {!mini && i === 0 && (
                    <span style={{ position: 'absolute', top: 2, left: 4, fontSize: 10,
                                   fontWeight: 600, color: c }}>{pr.name}</span>
                  )}
                </div>
              ))}
              {pr.busy.map((b, i) => (
                <div key={`b${i}`}
                  title={`已約 ${fmtMin(b.s)}–${fmtMin(b.e)}${b.count ? ` · ${b.count} 個預約` : ''}`}
                  style={{ position: 'absolute', left: mini ? 1 : 4, right: mini ? 1 : 4,
                           borderRadius: 3, background: c, top: pct(b.s), height: pctH(b.s, b.e) }}>
                  {!mini && (
                    <span style={{ fontSize: 9, color: '#fff', padding: '0 4px',
                                   lineHeight: 1.2, display: 'block', overflow: 'hidden',
                                   textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      已約{b.count ? ` ·${b.count}` : ''}
                    </span>
                  )}
                </div>
              ))}
              {gaps.map((g, i) => (
                <div key={`g${i}`} style={{ position: 'absolute', left: 4, right: 4, borderRadius: 3,
                       border: '1px dashed #cbd5e1', background: 'rgba(255,255,255,.7)',
                       display: 'flex', alignItems: 'center', padding: '0 4px',
                       top: pct(g.s), height: pctH(g.s, g.e) }}>
                  <span style={{ fontSize: 9, color: '#64748b', overflow: 'hidden',
                                 textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    空閒 {fmtMin(g.s)}–{fmtMin(g.e)}
                  </span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {/* header */}
      <div style={{ flexShrink: 0, background: '#fff', borderBottom: '1px solid #e5e7eb',
                    padding: '10px 12px', display: 'flex', alignItems: 'center',
                    gap: 8, flexWrap: 'wrap' }}>
        {zoomDate && (
          <button onClick={() => setZoomDate(null)} className="md:hidden"
            style={{ fontSize: 13, color: '#2563eb', background: 'none', border: 'none' }}>
            ‹ 成週
          </button>
        )}
        <span style={{ fontSize: 15, fontWeight: 600 }}>醫生時間表</span>

        <select value={clinicId} onChange={e => { setClinicId(e.target.value); setZoomDate(null) }}
          style={{ fontSize: 12, borderRadius: 999, background: '#eff6ff', color: '#1d4ed8',
                   border: 0, padding: '4px 10px' }}>
          {clinics.map(c => (
            <option key={c.id} value={c.id}>{c.name}{c.connected ? '' : '（未接通）'}</option>
          ))}
        </select>

        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
                       border: '1px solid #e5e7eb', borderRadius: 8, padding: '2px 4px' }}>
          <button onClick={() => setFrom(addDays(from, -7))} aria-label="前 7 日"
            style={{ background: 'none', border: 'none', color: '#64748b', padding: 2 }}>‹</button>
          <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            {from.slice(5).replace('-', '/')}–{addDays(from, 6).slice(5).replace('-', '/')}
          </span>
          <button onClick={() => setFrom(addDays(from, 7))} aria-label="後 7 日"
            style={{ background: 'none', border: 'none', color: '#64748b', padding: 2 }}>›</button>
        </span>

        <button onClick={() => { setFrom(hkTodayStr()); setZoomDate(null) }}
          style={{ fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 8,
                   padding: '4px 8px', background: '#fff', color: '#64748b' }}>
          今日起
        </button>

        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {data?.sync.stale ? (
            <span title="上次同步超過 30 分鐘"
              style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999,
                       background: '#fef2f2', color: '#b91c1c' }}>⚠️ 同步過期</span>
          ) : data?.sync.lastSyncAt ? (
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999,
                           background: '#f0fdf4', color: '#15803d', whiteSpace: 'nowrap' }}>
              Apricot {new Date(data.sync.lastSyncAt).toLocaleTimeString('zh-HK',
                { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Hong_Kong' })}
            </span>
          ) : null}
        </span>
      </div>

      {/* body */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 }}>
        {/* ★ 青衣：未接通 ≠ 未開診 */}
        {cur && !cur.connected ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <div style={{ fontSize: 14, color: '#b45309', marginBottom: 6 }}>
              ⚠️ {cur.name} 未接通 Apricot
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>
              請喺診所設定填 Apricot 診所 ID（apricotClinicId）
            </div>
          </div>
        ) : (
          <>
            {loading && <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '40px 0' }}>載入緊…</div>}
            {error && (
              <div style={{ textAlign: 'center', padding: '40px 0' }}>
                <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 8 }}>{error}</div>
                <button onClick={() => void load()}
                  style={{ fontSize: 12, padding: '6px 12px', borderRadius: 8,
                           background: '#2563eb', color: '#fff', border: 'none' }}>重試</button>
              </div>
            )}

            {data && !loading && !error && (
              <>
                {/* ═══ 桌面：直軸 × 七日 ═══ */}
                <div className="hidden md:flex" style={{ gap: 4, height: '100%', minHeight: 420 }}>
                  <div style={{ width: 44, flexShrink: 0, position: 'relative', marginTop: 24 }}>
                    {axisLabels.map(m => (
                      <span key={m} style={{ position: 'absolute', right: 6, transform: 'translateY(-50%)',
                                             fontSize: 10, color: '#94a3b8', top: pct(m) }}>{fmtMin(m)}</span>
                    ))}
                  </div>
                  <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6 }}>
                    {data.days.map(day => {
                      const isToday = day.date === today
                      const dow = WEEKDAY[new Date(`${day.date}T00:00:00Z`).getUTCDay()]
                      return (
                        <div key={day.date} style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                          <div style={{ height: 24, textAlign: 'center', fontSize: 11 }}>
                            <span style={isToday
                              ? { background: '#2563eb', color: '#fff', borderRadius: 999, padding: '2px 8px' }
                              : { color: '#94a3b8' }}>
                              {dow} {Number(day.date.slice(8))}
                            </span>
                          </div>
                          <div style={{ flex: 1, ...(isToday ? { boxShadow: '0 0 0 1px #2563eb', borderRadius: 6 } : {}) }}>
                            <DayColumn day={day} mini={false} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* ═══ 手機：週概覽 / 單日放大 ═══ */}
                <div className="md:hidden" style={{ height: '100%', minHeight: 380 }}>
                  {zoomDay ? (
                    <div style={{ display: 'flex', gap: 8, height: '100%' }}>
                      <div style={{ width: 44, flexShrink: 0, position: 'relative' }}>
                        {axisLabels.map(m => (
                          <span key={m} style={{ position: 'absolute', right: 4, transform: 'translateY(-50%)',
                                                 fontSize: 9, color: '#94a3b8', top: pct(m) }}>{fmtMin(m)}</span>
                        ))}
                      </div>
                      <div style={{ flex: 1 }}><DayColumn day={zoomDay} mini={false} /></div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 6, height: '100%' }}>
                      <div style={{ width: 32, flexShrink: 0, position: 'relative', marginTop: 28 }}>
                        {axisLabels.map(m => (
                          <span key={m} style={{ position: 'absolute', right: 2, transform: 'translateY(-50%)',
                                                 fontSize: 8, color: '#94a3b8', top: pct(m) }}>
                            {fmtMin(m).slice(0, 2)}
                          </span>
                        ))}
                      </div>
                      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
                        {data.days.map(day => {
                          const isToday = day.date === today
                          const dow = WEEKDAY[new Date(`${day.date}T00:00:00Z`).getUTCDay()]
                          return (
                            <button key={day.date} onClick={() => setZoomDate(day.date)}
                              style={{ display: 'flex', flexDirection: 'column', minHeight: 0,
                                       textAlign: 'left', background: 'none', border: 'none', padding: 0 }}>
                              <div style={{ height: 28, textAlign: 'center', fontSize: 9,
                                            lineHeight: 1.2, width: '100%' }}>
                                <span style={isToday
                                  ? { background: '#2563eb', color: '#fff', borderRadius: 999, padding: '0 4px' }
                                  : { color: '#94a3b8' }}>
                                  {dow}<br />{Number(day.date.slice(8))}
                                </span>
                              </div>
                              <div style={{ flex: 1, width: '100%',
                                            ...(isToday ? { boxShadow: '0 0 0 1px #2563eb', borderRadius: 6 } : {}) }}>
                                <DayColumn day={day} mini />
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* legend */}
                <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12,
                              flexWrap: 'wrap', fontSize: 10, color: '#94a3b8' }}>
                  <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                                    background: '#f1f5f9', marginRight: 4 }} />冇開診</span>
                  <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                                    background: soft('#6366f1'), marginRight: 4 }} />開診（色按醫生）</span>
                  <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                                    background: '#6366f1', marginRight: 4 }} />已約</span>
                  <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                                    border: '1px dashed #cbd5e1', marginRight: 4 }} />可約空隙</span>
                  <span className="md:hidden" style={{ marginLeft: 'auto', color: '#64748b' }}>撳日子放大</span>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
```

### 6.2 ⚠️ 九處同上傳 MD 唔同（唔好照抄原版）

| # | 原版 | clinic-workforce |
|---|---|---|
| 1 | Tailwind token（`bg-brand-soft` / `text-t2` / `bg-panel-2`） | **全部換 inline style** —— clinic-workforce 冇呢套 token |
| 2 | `lucide-react` icon | **換純文字 `‹ › ⚠️`** —— 唔使確認有冇裝 |
| 3 | `weekStart` + `hkMondayStr()` | **`from` + `hkTodayStr()`**（拍板③滾動）|
| 4 | 「上一週／下一週／今週」 | 「前 7 日／後 7 日／今日起」 |
| 5 | `palette()` 純 hash | **優先 `Provider.color`**，冇值先 hash |
| 6 | `clinicCode`（code 字串） | **`clinicId`（Clinic.id）** —— 同 RBAC scope 一致 |
| 7 | 「重新同步」掣（call queue） | **剷走** —— clinic-workforce 冇 queue，改為每 5 分鐘自動 refetch |
| 8 | 冇「未接通」狀態 | **加**（青衣）|
| 9 | axis fallback `09:00–21:00` | **`08:00–21:00`**（實測有 0900 開診）|

⚠️ **`soft()` 用 8 位 hex alpha（`#6366f122`）** —— 舊瀏覽器唔支援。
你哋目標係現代瀏覽器（PWA 打卡），實測冇問題就算；驚就改 `rgba()`。

⚠️ **`useEffect(() => {...}, [])` 個 eslint-disable** —— 診所清單只載一次，
`clinicId` 唔應該入 dep（會無限 loop）。

### 6.3 ★UI 要用返真 busy 塊（我上一版建議錯咗）

我上一版建議「`busy` 留空，只喺醫生名旁顯示 `· N 約`」，理由係「冇逐 slot 資料」。
**實際 JSON 有 `bookingTime` / `bookingEndTime`，所以呢個建議係錯嘅。**

→ **§6.1 個 `DayColumn` 照原樣保留 `busy` 同 `gaps` 兩段**，唔使改。

**但 tooltip 文案要準：**

```tsx
- title={`已約 ${fmtMin(b.s)}–${fmtMin(b.e)}${b.count ? ` · ${b.count} 個預約` : ''}`}
+ title={`${fmtMin(b.s)}–${fmtMin(b.e)} · ${b.count ?? 1} 個預約`}
```

⚠️ **唔好寫「同時 N 人」** —— `count` 係「呢段時間內有幾多個預約」（§5.2），
唔係並發數。

**醫生名旁邊加當日總數：**

```tsx
- <span style={{ … }}>{pr.name}</span>
+ <span style={{ … }}>{pr.name}{pr.total ? ` · ${pr.total}` : ''}</span>
```

★ 圖一 Apricot 自己都係咁做（`Dr. Lau Ho Yin,Samson  14`）。

### 6.4 導航入口

```tsx
// (protected)/layout.tsx 或者側欄設定
+ { href: '/provider-availability', label: '醫生時間表', perm: 'scheduling' }
```

⚠️ 同現有 `/provider-schedule`（人手排更）**並存唔衝突** ——
一個係「Apricot 實際開診」，一個係「你哋自己排嘅更」。
建議 label 分清楚：**「醫生時間表（Apricot）」** vs **「醫生當值表」**。

## 七、驗收

### 7.1 PII（★最重要）

| ☐ | # | 動作 | 預期 |
|---|---|---|---|
| ☐ | 1 | probe 輸出 | **只有結構統計，冇任何值** ★★★ |
| ☐ | 2 | `SELECT * FROM "ProviderBooking" LIMIT 20` | 只有 id／clinicId／providerId／date／startMin／endMin／status／syncedAt ★★★ |
| ☐ | 2b | `SELECT * FROM "ProviderAvailability" LIMIT 20` | 只有 id／clinicId／providerId／date／startTime／endTime／syncedAt ★★★ |
| ☐ | 3 | `grep -in "clinicPatient\|visitReason\|remarkByDoctor\|personalIdentifier"` 喺 `lib/apricot/availability.ts` | **零命中** ★★★ |
| ☐ | 3b | fixture 測試 | 餵一份含 `clinicPatient` 嘅樣本，斷言 `extractBookings` 輸出**只有四個 key** ★★★ |
| ☐ | 4 | app log | 冇任何 raw response |

### 7.2 Sync

| ☐ | # | 動作 | 預期 |
|---|---|---|---|
| ☐ | 5 | 手動 call 一次 | 五間店有 row（青衣冇） |
| ☐ | 6 | 連續兩次 | 兩張表總數**都唔會翻倍** |
| ☐ | 7 | 只 sync 一間 | **其餘四間唔會冇咗**（兩張表都要驗）★★★ |
| ☐ | 8 | warning | 列出 `MF Clinic` / `LAU` / `YEUNG` 等未對應 practitioner ★★ |
| ☐ | 9 | 開診時間解析 | `900` → `09:00`、`1800` → `18:00`、`2000` → `20:00` ★★★ |
| ☐ | 10 | **8/19 Dr. Lau 第一筆預約** | `startMin = 570`（09:30）、`endMin = 600`（10:00）★★★ |
| ☐ | 11 | 對返 Apricot 畫面 | 每格時間**完全一致**（用圖一逐格對）★★★ |
| ☐ | 12 | 8/19 重疊時段（11:15–11:45） | `ProviderBooking` 有**四筆獨立 row**，冇被 dedupe ★★★ |
| ☐ | 13 | 8/19 Dr. Tong / Yeung | `ProviderBooking` **零行**（`bookingDetail` 空） |
| ☐ | 14 | 跨日預約（HK 00:00–08:00） | 落**正確嘅日**（`utcIsoToHkMin` 檢查）★★ |
| ☐ | 15 | `isRemoved: true` 嘅預約 | **唔會入庫** |
| ☐ | 16 | `status` 欄 | 有值（實見 0 / 4），**唔會全部 −1** |
| ☐ | 17 | 一間失敗 | 其餘照做 |
| ☐ | 18 | 兩個 sync 同時 | `flock` 擋住（OS 層） |
| ☐ | 18b | availability sync 進行中手動跑 bill sync | 見 `[apricot] 已有 call 進行中，今次跳過`，**唔會兩邊一齊打** ★★★ |
| ☐ | 18c | 攞唔到 lock | API 回 `{ ok: false, skipped: … }`，**唔會 crash** ★★★ |
| ☐ | 19 | Apricot token | sync 後仍然有效 |

### 7.3 API ／ UI

| ☐ | # | 動作 | 預期 |
|---|---|---|---|
| ☐ | 15 | `check-rbac-matrix.sh` | 過（含 `/api/internal/*`） |
| ☐ | 16 | MANAGER 睇其他公司 | 403 ★★★ |
| ☐ | 17 | 桌面 | 直軸 08:00–21:00 × 七日 |
| ☐ | 18 | 手機 | 週概覽 ＋ 撳日放大 |
| ☐ | 19 | **青衣** | 「未接通 Apricot」**唔係**「未開診」★★ |
| ☐ | 20 | sync chip | `max(syncedAt)`，超過 30 分鐘變黃 |
| ☐ | 21 | 醫生色 | 用 `Provider.color` |

### 7.4 排程

| ☐ | # | 動作 | 預期 |
|---|---|---|---|
| ☐ | 22 | 跑一晚 | log 冇錯 |
| ☐ | 23 | request 數 | ≈ 445/日 |
| ☐ | 24 | `INTERNAL_SYNC_TOKEN` 未設 | **503** ★★★ |
| ☐ | 25 | 錯 token | 403 |

★★★ 六格必跑：`#2` `#7` `#9` `#16` `#19` `#24`。

---

## 八、落刀次序

```
1. §3.1 schema + migration（★單獨 deploy）
2. §一 白名單 extract（★先寫 PII 測試：餵一份含 clinicPatient 嘅 fixture，
   斷言輸出只有六個 key）
3. §3.2 sync + §2.1 unknown warning
4. 手動 call 一次 → 跑 §7.1 §7.2（★#2 #9 先）
5. §2.1 睇 warning 補 apricotId（LAU / YEUNG）；MF Clinic 忽略
6. §四 內部 API + cron
7. §五 API route + RBAC
8. §六 UI
9. 跑 §7.3 §7.4
```

⚠️ **第 2 步個 PII 測試唔好跳** —— 呢個 response 有 HKID／病歷／醫生備註，
而白名單係唯一防線。用 fixture 斷言比人手 review 可靠。

---

## 九、仍然未答（唔阻第一版）

| 問題 | 影響 |
|---|---|
| `bookingStatus` 1/2/3/5 | 而家數晒（除 `isRemoved`）—— 可能包含已取消 |
| `blocks` / `groupClasses` 樣本仍然空 | 可能係醫生封鎖時段，同 `ProviderLeave` 對得上 |
| 一個醫生一日會唔會多過一段開診 | 會嘅話 `bookedCount` 落第一段嘅做法要改 |
| `MF Clinic` 呢類 pseudo practitioner 有幾多個 | 睇 §7.2 `#8` warning |
