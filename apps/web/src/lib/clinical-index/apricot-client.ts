// ============================================================
// Apricot 臨床端點包裝 + 限速（cwi-followup-p1-20260915）
//
// 四條端點（MD §0.1 實測 URL）：
//   1. POST /services/aepsmsope/api/clinic-patients/search  — 當日到訪（固定 page size 50）
//   2. GET  /services/aepsmsope/api/appointments/patient/{cpId}
//   3. GET  /services/aepsmsope/api/consultation-notes/patient/{cpId}
//   4. POST /services/aepsmsbill/api/bills/search           — ⚠️ service 係 aepsmsbill
//
// 限速：每 call 之間 sleep（鐵律 400ms；rateLimitMs()）。callFn 可注入
// （預設 = 真 apricotCall）— e2e 傳決定性 stub，生產 null → 真 API。
//
// 錯誤口徑（apricotCall 已定義，原樣傳上層）：
//   APRICOT_NOT_CONFIGURED / APRICOT_AUTH_EXPIRED / APRICOT_RATE_LIMITED /
//   APRICOT_HTTP_x — RATE_LIMITED 觸發「停當晚、cursor 續」（MD §2.5）。
// ============================================================

import { apricotCall } from '@/lib/apricot/client'
import { hkDateStart, hkDateEnd } from '@/lib/hk-date'
import { PAGE_SIZE, rateLimitMs, type ClinicalCallFn } from './types'

/** 預設 callFn = 真 Apricot（cookie 三件套 + rotation 已喺 apricotCall 封裝）。 */
const defaultCall: ClinicalCallFn = (path, init) => apricotCall(path, init)

/**
 * 包一層限速計數：每次 call 之間 sleep(rateLimitMs())（第一次唔 sleep）。
 * 回傳 call（傳入 pipeline）+ calls()（計數 → ClinicalIndexJob.apiCalls）。
 */
export function makeThrottledCallFn(base: ClinicalCallFn = defaultCall): {
  call: ClinicalCallFn
  calls: () => number
} {
  let n = 0
  const rateMs = rateLimitMs()
  const call: ClinicalCallFn = async (path, init) => {
    if (n > 0) await new Promise((r) => setTimeout(r, rateMs))
    n++
    return base(path, init)
  }
  return { call, calls: () => n }
}

/** 判斷係咪「停當晚」級錯誤（限速／認證）— 觸發 cursor 續。 */
export function isStopNightError(e: unknown): boolean {
  const msg = (e as { message?: string })?.message ?? ''
  return msg === 'APRICOT_RATE_LIMITED' || msg === 'APRICOT_AUTH_EXPIRED' || msg === 'APRICOT_NOT_CONFIGURED'
}

/**
 * clinic-patients/search 掃全部 page（MD §0.1：固定 size 50，size 參數無效；
 * 純 array；掃到回空為止 — 實作上 partial page（<50）即末頁，省最後一次空 call）。
 */
export async function searchPatientsForDate(call: ClinicalCallFn, date: string): Promise<any[]> {
  const out: any[] = []
  for (let page = 0; ; page++) {
    const data = await call(
      `/services/aepsmsope/api/clinic-patients/search?page=${page}&sort=asc&sortBy=fullName&keyword=`,
      {
        body: JSON.stringify({
          params: [
            { key: 'lastVisitStartDate', value: hkDateStart(date).toISOString() },
            { key: 'lastVisitEndDate', value: hkDateEnd(date).toISOString() },
            { key: 'registrationClinic', details: [] }, // 唔分店（MD §0.1 實測）
          ],
        }),
      },
    )
    const rows = Array.isArray(data) ? data : (data?.content ?? [])
    out.push(...rows)
    if (rows.length < PAGE_SIZE) break
  }
  return out
}

/** 病人預約（MD §0.1：size 20 實測口徑；含 visitReasons[] 結構化 code）。 */
export async function getPatientAppointments(call: ClinicalCallFn, cpId: string): Promise<any[]> {
  const data = await call(`/services/aepsmsope/api/appointments/patient/${cpId}?page=0&size=20&sort=desc`)
  return Array.isArray(data) ? data : (data?.content ?? data?.list ?? [])
}

/** 診症記錄（MD §0.1：size 8 實測口徑；兩種樣板見 §0.3）。 */
export async function getPatientNotes(call: ClinicalCallFn, cpId: string): Promise<any[]> {
  const data = await call(`/services/aepsmsope/api/consultation-notes/patient/${cpId}?page=0&size=8&sort=desc&filter=`)
  return Array.isArray(data) ? data : (data?.content ?? data?.list ?? [])
}

/** 帳單（MD §0.1：service = aepsmsbill；items 唔會回 — 列表冇明細）。 */
export async function getPatientBills(call: ClinicalCallFn, cpId: string, date: string): Promise<any[]> {
  const data = await call(
    `/services/aepsmsbill/api/bills/search?page=0&size=50&sort=desc&keyword=&sortBy=billTime`,
    {
      body: JSON.stringify({
        params: [
          { key: 'startDate', value: hkDateStart(date).toISOString() },
          { key: 'endDate', value: hkDateEnd(date).toISOString() },
          { key: 'patientCustomerType', value: 'patient' },
          { key: 'patients', details: [cpId] }, // ★ details 唔係 value（實測）
        ],
      }),
    },
  )
  return Array.isArray(data) ? data : (data?.content ?? [])
}

/** 逐病人 3 call（MD §2.3：appointments / consultation-notes / bills，順序執行 — 限速喺 callFn 層）。 */
export async function fetchPatientData(
  call: ClinicalCallFn,
  cpId: string,
  day: string,
): Promise<{ appointments: any[]; notes: any[]; bills: any[] }> {
  const appointments = await getPatientAppointments(call, cpId)
  const notes = await getPatientNotes(call, cpId)
  const bills = await getPatientBills(call, cpId, day)
  return { appointments, notes, bills }
}
