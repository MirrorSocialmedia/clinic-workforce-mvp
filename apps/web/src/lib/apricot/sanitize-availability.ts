// ★ cw-extapi-20260823-a1: 本檔由 wa-clinic-inbox repo 搬入（src/lib/apricot/sanitize.ts，
//   2026-08-23 原檔 95 行逐字照搬 — MD §B.2「搬過嚟等佢喺呢邊終老」）。
//   clinic-workforce 係全系統唯一 Apricot 整合點，sanitize 白名單收歸呢度。
//   本 repo 舊 sanitize.ts（toCleanPatients / sanitizePayment）唔郁。
//
// ★ cwc-rdchain-20260823-a1: 白名單 v2（read-chain MD §1 — 取代舊「visitReasons 一律禁」）
//   ✅ 准：visitReasons[].des、appointment remarks（remarkByDoctor）、visit 日期、
//      醫生、patient id/code/fullName
//   ✅ 變形：phoneNum 只准以 HMAC hash 形式存（§2.3 phone-hash.ts），raw 即棄
//   🔴 照禁：HKID（personalIdentifier）、地址、DOB、medicalHistory、drugHistory、
//      緊急聯絡人、電郵、bloodType、occupation、diagnosis、createdBy
//   extractIndexRows = 白名單 v2 嘅逐欄 pickup（AppointmentIndex / PatientIndex 數據源）。
/**
 * Apricot overview response — PII 白名單 sanitize（MD §8.1 🔴 白名單制）
 *
 * getOverviewAppointments 嘅 raw response 帶病人資料（clinicPatient / visitReasons /
 * diagnosis / createdBy...）— **只准**留白名單欄位：
 *   - practitionerOpenSchs[]：開診時段（startTime/endTime）
 *   - appointments[]：佔用時段（startTime/endTime）→ 算 bookedCount
 *   - 【v2】booking 級：appt id / bookingStatus / patient id/code/fullName /
 *     phoneNum→HMAC hash / visitReasons[].des / remarkByDoctor
 * 其餘全部 drop。raw response 永不入 log 永不落 disk（鐵律）—
 * 呢個 function 係落地前唯一嘅過濾口，sanitize 後嘅 object 先可以入 DB。
 *
 * 白名單手法（同 provider-roster sanitize.ts 一樣）：逐欄 pickup，唔係剷黑名單。
 */

import { utcIsoToHkMin } from './availability'
import { phoneHash } from '../phone-hash'

export interface SanitizedOpenSch {
  startTime: string; // "HH:mm"
  endTime: string;   // "HH:mm"
}

export interface SanitizedAppointment {
  startTime: string;
  endTime: string;
}

export interface SanitizedOverview {
  openSchs: SanitizedOpenSch[];
  appointments: SanitizedAppointment[];
}

function toHHmm(v: unknown): string | null {
  const s = String(v ?? "").trim();
  // 收 "HH:mm" / "HH:mm:ss" / ISO 時間戳（提取 HH:mm）
  let m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  m = new Date(s).toISOString().match(/T(\d{2}):(\d{2})/);
  if (m && !isNaN(new Date(s).getTime())) return `${m[1]}:${m[2]}`;
  return null;
}

function minToHHmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

interface OverviewRawLike {
  practitionerOpenSchs?: unknown;
  appointments?: unknown;
}

/**
 * 白名單 pickup：raw overview → 只留開診時段 + 佔用時段。
 * 任何 PII 欄位（clinicPatient/visitReasons/diagnosis/createdBy/...）喺呢度天然被 drop
 * （根本唔讀佢哋）。
 */
export function sanitizeOverview(raw: OverviewRawLike): SanitizedOverview {
  const openSchs: SanitizedOpenSch[] = [];
  for (const sch of Array.isArray(raw?.practitionerOpenSchs) ? raw.practitionerOpenSchs : []) {
    const st = toHHmm(sch?.startTime ?? sch?.start);
    const en = toHHmm(sch?.endTime ?? sch?.end);
    if (st && en && st !== en) openSchs.push({ startTime: st, endTime: en });
  }

  const appointments: SanitizedAppointment[] = [];
  for (const appt of Array.isArray(raw?.appointments) ? raw.appointments : []) {
    const st = toHHmm(appt?.startTime ?? appt?.start);
    const en = toHHmm(appt?.endTime ?? appt?.end);
    if (st && en && st !== en) appointments.push({ startTime: st, endTime: en });
  }

  return { openSchs, appointments };
}

// ── 白名單 v2：booking 級 index 行（AppointmentIndex / PatientIndex 數據源）────

/**
 * 白名單 v2 pickup（read-chain MD §1/§2）— raw bookingDetail → 只留 index 需要嘅欄位。
 *
 * ✅ 抽：
 *   - id（apricotApptId，upsert 唯一鍵）
 *   - bookingTime / bookingEndTime → HK HH:mm（同 extractBookings 同一把 UTC→HK 轉換）
 *   - bookingStatus（整數；缺省/NaN → -1，跟 extractBookings 口徑）
 *   - clinicPatient.id / code / fullName
 *   - clinicPatient.phoneNum → **phoneHash() 即棄 raw**（🔴 raw 唔入回傳 object）
 *   - visitReasons[].des（只留 des 文字，code 之外嘅病人關聯欄位一律唔讀）
 *   - remarkByDoctor（fallback remarks）→ remarks
 * ❌ 唔抽：HKID / 地址 / DOB / 病歷 / 藥歷 / 緊急聯絡人 / 電郵 / 性別 / 職業 / 診斷 /
 *    createdBy / 任何非白名單欄位（天然 drop — 根本唔讀佢哋）
 *
 * 跳過規則（同 extractBookings 同口徑）：
 *   - isRemoved === true（同 grid 排除）
 *   - 壞時間戳／跨日／end <= start
 *   - 無 booking id 或無 patient id（upsert 冇唯一鍵 — 唔硬造）
 */
export interface SanitizedIndexRow {
  apricotApptId: string
  bookingStatus: number
  date: string       // 'YYYY-MM-DD'（HK）
  startTime: string  // 'HH:mm'
  endTime: string    // 'HH:mm'
  patientApricotId: string
  patientCode: string
  patientName: string
  phoneHash: string  // HMAC-SHA256 hex（64）；phoneNum 缺失 → ''（空 = 唔可以 match）
  visitReasons: string[]
  remarks: string | null
}

export function extractIndexRows(dateStr: string, node: any): SanitizedIndexRow[] {
  const arr = node?.bookingDetail
  if (!Array.isArray(arr)) return []
  const out: SanitizedIndexRow[] = []
  for (const b of arr) {
    if (b?.isRemoved === true) continue
    const s = utcIsoToHkMin(b?.bookingTime, dateStr)
    const e = utcIsoToHkMin(b?.bookingEndTime, dateStr)
    if (s == null || e == null || e <= s) continue // 壞格式／跨日／無效時段
    const apptId = b?.id != null ? String(b.id) : ''
    if (!apptId) continue // 無唯一鍵 → 唔入 index（唔硬造）
    const cp = b?.clinicPatient ?? b?.patient
    const pid = cp?.id != null ? String(cp.id) : ''
    if (!pid) continue // 無 patient id → 唔入 index（唔硬造）
    const st = Number(b?.bookingStatus ?? -1)
    const phone = cp?.phoneNum == null ? '' : String(cp.phoneNum).trim()
    const reasons = Array.isArray(b?.visitReasons)
      ? b.visitReasons
          .map((v: any) => (v?.des != null ? String(v.des).trim() : ''))
          .filter((x: string) => x !== '')
      : []
    const remRaw = b?.remarkByDoctor ?? b?.remarks
    out.push({
      apricotApptId: apptId,
      bookingStatus: Number.isFinite(st) ? st : -1,
      date: dateStr,
      startTime: minToHHmm(s),
      endTime: minToHHmm(e),
      patientApricotId: pid,
      patientCode: cp?.code != null ? String(cp.code) : '',
      patientName: cp?.fullName != null ? String(cp.fullName) : '',
      // 🔴 phoneNum → hash 即棄 raw（raw 唔入 out，落地前斷言兜底）
      phoneHash: phone ? phoneHash(phone) : '',
      visitReasons: reasons,
      remarks: typeof remRaw === 'string' && remRaw.trim() !== '' ? remRaw : null,
    })
  }
  return out
}

// ── PII 洩漏斷言（sanitized output 落地前再兜一次底） ────────────────────

/**
 * 白名單 v2 更新（cwc-rdchain-20260823-a1）：
 * - `visitReasons` / `remarks` 移出禁表（v2 准入 — AppointmentIndex 用呢兩個 key 落地）
 * - 其餘照禁。
 */
const PII_KEYS_STRICT = [
  "clinicPatient",
  "personalIdentifier",
  "medicalHistory",
  "drugHistory",
  "phoneNum",
  "phoneList",
  "dateOfBirth",
  "diagnosis",
  "address",
  "email",
  "fullName",
  "emergencyContact",
  "bloodType",
  "occupation",
  "createdBy",
];

/**
 * 落地前 assert：sanitized object 絕唔可含任何 PII key（defence in depth）。
 *
 * ★ cwc-rdchain-20260823-a1 語義升級：舊版 = JSON.stringify 子串掃描；新版 = **key 逐層掃描**
 * （object key 精確命中禁表）。原因：白名單 v2 之後 sanitized object 開始承載自由文字
 * （remarks / visitReasons[].des），子串掃描會把醫生備註入面嘅英文單詞（例如 "email"）
 * 誤判做 PII key 洩漏 → 該店 sync 假陽性 fail。key 掃描先係呢道防線嘅本義：
 * 攞住「raw object 未經白名單就落地」呢個威脅（key 出現 = 漏咗 drop），
 * 同時唔會誤殺白名單自由文字。
 */
function findPiiKey(obj: unknown, seen: Set<object> = new Set()): string | null {
  if (obj === null || typeof obj !== 'object') return null
  if (seen.has(obj)) return null
  seen.add(obj)
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = findPiiKey(item, seen)
      if (hit !== null) return hit
    }
    return null
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (PII_KEYS_STRICT.includes(k)) return k
    const hit = findPiiKey(v, seen)
    if (hit !== null) return hit
  }
  return null
}

/** 落地前 assert：sanitized object 絕唔可含任何 PII key（defence in depth）。 */
export function assertNoPii(obj: unknown): void {
  const leak = findPiiKey(obj)
  if (leak) throw new Error(`PII 洩漏：${leak}`)
}
