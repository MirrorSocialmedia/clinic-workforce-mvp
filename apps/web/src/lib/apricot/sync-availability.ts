// ★ cw-pa: Apricot 醫生時間表 sync 引擎（P2）
// Spec: docs/specs/PROVIDER_AVAILABILITY_SPEC.md §3.2（syncAvailability）
//        §3.3（withApricotLock 外層一次包住所有店）／§2.1（unknown warning）／§2.2（青衣跳過）
//
// 🔴 PII 紅線：本檔永不 log raw response（response 內嵌病人 HKID／病歷／備註）。
//    只 log 結構統計（行數）＋ practitioner id/code（§2.1 要求，屬員工元資料唔係病人 PII）。
//
// 架構（§3.3 ★★★）：
//   - advisory lock（pg_try_advisory_lock 776001）只喺 runAvailabilitySync 外層攞一次，
//     包住六間店 —— 同 bill/payment sync 共用一個 lock key，嚴格序列化打 Apricot。
//   - syncAvailability 內「唔好」再攞 lock；每個 API call 用 withApricotLockRetry 包住
//     （處理 Apricot 自己回 503/busy，同 advisory lock 係兩件事，兩個都要）。
//
// 可重用性：callFn 可注入（預設 = 真 apricotCall + retry）。dev 測試／mock 傳自己嘅函數，
//    P3 internal API 直接 call runAvailabilitySync()（預設 = 真 API）。

import { prisma } from '@/lib/prisma'
import { toHKDateStr } from '@/lib/hk-date'
import { apricotCall, withApricotLockRetry } from './client'
import { withApricotLock } from './lock'
import { extractOpenSch, extractBookings } from './availability'

// ─── Types ──────────────────────────────────────────────────────────────

/** 單次 API call 抽象（path → raw JSON）。預設係真 Apricot。 */
export type ApricotCallFn = (path: string) => Promise<any>

/** syncAvailability 回傳（一行一店） */
export interface AvailabilitySyncResult {
  open: number      // 寫入 ProviderAvailability 行數
  bookings: number  // 寫入 ProviderBooking 行數
  unknown: number   // 未對應 Provider 嘅 practitioner 數（種，唔係次）
}

/** runAvailabilitySync 成功回傳（P3 internal API 直接 JSON 化） */
export interface AvailabilityRunResult {
  ok: true
  start: string             // window 起（HK，YYYY-MM-DD）
  end: string               // window 止（HK，YYYY-MM-DD）
  skippedClinics: number    // 冇 apricotClinicId 嘅店數（§2.2）
  results: Array<
    ({ clinic: string; clinicId: string } & AvailabilitySyncResult)
    | { clinic: string; clinicId: string; error: string }
  >
}

/** 攞唔到 advisory lock（§3.3 ★★★：回 null 唔係 throw —— caller 一定要處理） */
export interface AvailabilityRunSkipped {
  ok: false
  skipped: string
}

export type AvailabilityRunOutcome = AvailabilityRunResult | AvailabilityRunSkipped

/** 預設 call：真 Apricot + retry（503/busy 等 700ms 重試 3 次；AUTH/RATE 直接 throw） */
const defaultCall: ApricotCallFn = (path) => withApricotLockRetry(() => apricotCall(path))

const APPOINTMENTS_PATH = '/services/aepsmsappt/api/appointments/getOverviewAppointments'
const CLINIC_DELAY_MS = 500 // §3.3：逐間之間 delay

// ─── Helpers ────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' + N 日（純 calendar 運算，唔受 host 時區影響） */
export function addDaysStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** 今日（HK）YYYY-MM-DD */
function hkTodayStr(): string {
  return toHKDateStr(new Date())
}

/**
 * ★ 2026-08-22（cw-patwk）：sync 窗口 = from 起 7 日（from 為 'YYYY-MM-DD'）。
 * from 無／格式壞 → fallback 今日（維持 cron「今日起 7 日」舊行為，cron 唔用傳）。
 *
 * ★★★ 單一窗口來源：syncAvailability 同 runAvailabilitySync 兩個 call site
 *   都必須經呢個 function 算 start/end —— 各自算就會出現「deleteMany 刪本週、
 *   寫入下週」兩邊殘嘅災難（MD §3.2 警告）。
 */
export function resolveSyncWindow(from?: string): { start: string; end: string } {
  const start = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : hkTodayStr()
  return { start, end: addDaysStr(start, 6) }
}

// ─── §3.2 單間診所 sync ─────────────────────────────────────────────────

/**
 * 一次 call 拎晒 7 日窗口（from 起 ~ +6；from 無 = HK today），寫兩張表。
 *
 * ★★★ 決定性寫：先刪本 shop 窗口內舊 row 再 create（同一個 $transaction）——
 *   兩個 deleteMany 嘅 where 都要有 clinicId（少一個就刪晒其他診所）。
 *   ProviderBooking.createMany 唔加 skipDuplicates（同一時段可以真係有多筆）。
 *
 * 唔喺呢度攞 advisory lock —— lock 由 runAvailabilitySync 外層一次包住（§3.3）。
 * ★ 2026-08-22（cw-patwk）：opts.from = 前端當前顯示週首日（拉嗰一週）；
 *   外層 runAvailabilitySync 會傳返自己已算好嘅 start，保證 deleteMany 窗口一致。
 */
export async function syncAvailability(
  clinic: { id: string; name?: string; apricotClinicId: string },
  callFn: ApricotCallFn = defaultCall,
  opts: { from?: string } = {},
): Promise<AvailabilitySyncResult> {
  const { start, end } = resolveSyncWindow(opts?.from) // ★ 單一窗口來源（唔好再自算）

  const providers = await prisma.provider.findMany({
    where: { isActive: true, apricotId: { not: null } },
    select: { id: true, apricotId: true },
  })

  const qs = new URLSearchParams()
  qs.set('startDate', start)
  qs.set('endDate', end)
  // ★ 2026-08-21：clinicIds 係【必填】—— 唔傳 Apricot 直接回 400：
  //   "Required request parameter 'clinicIds' for method parameter type List is not present"
  //   （Spring List 參數）。同 openSchClinicId 唔同嘢：
  //     clinicIds       = 篩預約屬邊間店（List，可多值 —— 未試）
  //     openSchClinicId = 攞開診時段（單數，逐間店）
  //   兩個都要傳，唔可以二選一。
  qs.append('clinicIds', clinic.apricotClinicId)
  qs.set('openSchClinicId', clinic.apricotClinicId) // ★ 單數
  for (const p of providers) qs.append('doctorIds', p.apricotId!) // ★ 逐個列

  // ★ 必填參數自檢 —— 漏一個 Apricot 就回 400，而 log 唔開頁冇人睇
  const REQUIRED = ['startDate', 'endDate', 'clinicIds', 'openSchClinicId'] as const
  const missing = REQUIRED.filter(k => !qs.get(k))
  if (missing.length > 0) {
    throw new Error(`[availability] query 缺必填參數：${missing.join(', ')}`)
  }
  if (qs.getAll('doctorIds').length === 0) {
    throw new Error('[availability] 冇任何 provider 有 apricotId —— 補齊先再 sync')
  }

  // ★ 只 call —— retry 處理 503/busy；lock 由外層負責
  const raw = await callFn(`${APPOINTMENTS_PATH}?${qs.toString()}`)

  const knownIds = new Map(providers.map((p) => [p.apricotId!, p.id]))
  // §2.1：unknown practitioner 收集（id:code → 出現次數；Set 升級做 Map 係為咗 #8 報告要次數）
  const unknown = new Map<string, number>()
  const availRows: { clinicId: string; providerId: string; date: string; startTime: string; endTime: string }[] = []
  const bookRows: { clinicId: string; providerId: string; date: string; startMin: number; endMin: number; status: number }[] = []

  for (const [dateStr, dayNode] of Object.entries(raw ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue // ★ 過濾非日期 key（meta 之類）
    const appts = (dayNode as any)?.appointments
    if (!appts || typeof appts !== 'object') continue

    for (const [apricotPid, node] of Object.entries(appts)) {
      const providerId = knownIds.get(apricotPid)
      if (!providerId) {
        // §2.1：對唔到 Provider → 跳過 + 記低（唔好自動建 Provider）
        const key = `${apricotPid}:${(node as any)?.practitioner?.code ?? '?'}`
        unknown.set(key, (unknown.get(key) ?? 0) + 1)
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
    const detail = [...unknown.entries()].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(', ')
    console.warn(`[availability] ${clinic.name ?? clinic.id} ${unknown.size} 個 Apricot practitioner 未對應 Provider：`, detail)
  }

  // ★ 決定性：先刪窗口內再寫（兩張表同一個 transaction）
  await prisma.$transaction([
    prisma.providerAvailability.deleteMany({
      where: { clinicId: clinic.id, date: { gte: start, lte: end } }, // ★ clinicId 唔可以少
    }),
    prisma.providerBooking.deleteMany({
      where: { clinicId: clinic.id, date: { gte: start, lte: end } }, // ★ 同上
    }),
    prisma.providerAvailability.createMany({ data: availRows, skipDuplicates: true }),
    prisma.providerBooking.createMany({ data: bookRows }), // ★ 唔加 skipDuplicates（§3.2）
  ])

  return { open: availRows.length, bookings: bookRows.length, unknown: unknown.size }
}

// ─── §3.3 外層：lock 一次包住所有店 ─────────────────────────────────────

/**
 * 逐間診所 sync（一間失敗唔中斷其餘）。
 *
 * ★★★ withApricotLock 攞唔到 lock 回 null（唔係 throw）→ 回傳 { ok: false, skipped }
 *     唔會 crash（§7.2 #18c）—— P3 internal API 直接 return 呢個 JSON。
 *
 * AUTH_EXPIRED → 剩餘店唔再打（spec §3.4：唔會重試，續打只會刷 log + 撞同一個錯），
 *     該店記 error 後 break，caller 見到可報 CEO 重新登入 bot 帳號。
 */
export async function runAvailabilitySync(
  opts: { callFn?: ApricotCallFn; from?: string } = {},
): Promise<AvailabilityRunOutcome> {
  const { callFn, from } = opts
  // §2.2：冇 apricotClinicId 嘅店（青衣）唔會 sync —— warning 出嚟
  const skippedClinics = await prisma.clinic.count({ where: { apricotClinicId: null } })
  if (skippedClinics > 0) {
    console.warn(`[availability] ${skippedClinics} 間診所冇 apricotClinicId，唔會 sync`)
  }

  // ★ 2026-08-22（cw-patwk）：from = 前端當前顯示週首日；無 → 今日（cron 唔傳，行為唔變）。
  //   傳落 syncAvailability 嘅係已算好嘅 start（regex 必定過），deleteMany 同寫入同一窗口。
  const { start, end } = resolveSyncWindow(from)

  const result = await withApricotLock(async () => {
    const clinics = await prisma.clinic.findMany({
      where: { apricotClinicId: { not: null } }, // §2.2：只 sync 有接通嘅
      select: { id: true, name: true, apricotClinicId: true },
      orderBy: { name: 'asc' },
    })

    const results: AvailabilityRunResult['results'] = []
    for (const c of clinics) {
      // where 已 filter not null — 運行時多一層防禦（Prisma 型別唔會窄化）
      if (!c.apricotClinicId) continue
      const clinicRef = { id: c.id, name: c.name, apricotClinicId: c.apricotClinicId }
      try {
        results.push({
          clinic: c.name,
          clinicId: c.id,
          // ★ callFn 傳 undefined 行預設（真 Apricot）；from: start 保證窗口同外層一致
          ...(await syncAvailability(clinicRef, callFn, { from: start })),
        })
      } catch (e: any) {
        const msg = e?.message ?? String(e)
        console.error(`[availability] ${c.name} 失敗：`, msg)
        results.push({ clinic: c.name, clinicId: c.id, error: msg })
        if (msg.includes('AUTH_EXPIRED')) {
          // ★ spec §3.4 + 任務鐵律：AUTH_EXPIRED 唔會重試 —— 停手，唔好循環撞
          console.error('[availability] Apricot 認證失效 —— 剩餘診所唔再打，bot 帳號要重新登入（報 CEO）')
          break
        }
      }
      await new Promise((r) => setTimeout(r, CLINIC_DELAY_MS))
    }
    return results
  })

  // ★★★ 攞唔到 lock 回 null（唔係 throw）
  if (result === null) {
    return { ok: false, skipped: 'another apricot call in progress' }
  }
  return { ok: true, start, end, skippedClinics, results: result }
}
