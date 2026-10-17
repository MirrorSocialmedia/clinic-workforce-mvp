// ============================================================
// upsertVisitIndex — ClinicalRecordIndex 唯一寫入路徑（cwi-followup-p1-20260915）
//
// 🔴 鐵律（MD §2.8）：夜跑、回填、手動刷新**共用呢一個 function** ——
//    唔好另寫一份 upsert（S7 grep 確認）。
//
// 冪等：upsert by @@unique([patientApricotId, visitDate, apricotApptId])。
//
// 合併守則：
//   - phoneHashes：新值非空 → 用新值；空 → 保留現有行（refresh 無 patient
//     search，攞唔到電話 — 唔准抹走夜跑已填嘅 hash）。
//   - note 欄：已有 hasNote=true 唔會降返 false（Apricot note 唔會消失；
//     重掃「只更新 note 欄」— MD §2.3）。
//   - bill 欄：新值 null → 保留現有（未來行先索引、bill 後到嘅情形）。
//
// 原始電話唔過界：只存 phoneHashes（§1.2 phoneHashes 多號）。
// ============================================================

import { basePrisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { toHKDateStr } from '@/lib/hk-date'
import { phoneHashes } from '@/lib/phone'
import { extractNoteText } from './extract-note-text'
import { extractRxCodes, type RxCodeEntry } from '@/lib/clinical/extract-rx-codes'
import type { NoteText, ResolvedVisit } from './types'

interface ExistingRow {
  id: string
  phoneHashes: string[]
  hasNote: boolean
  noteKind: string | null
  noteJson: unknown
  apricotNoteId: string | null
  rxCodes: string[]
  billTtlAmt: number | null
  billOsAmt: number | null
}
const SELECT_MERGE = {
  id: true, phoneHashes: true, hasNote: true, noteKind: true, noteJson: true,
  apricotNoteId: true, rxCodes: true, billTtlAmt: true, billOsAmt: true,
} as const

/** 合併守則（檔案頭）→ create/update data 對。 */
function merged(r: ResolvedVisit, existing: ExistingRow | null): { create: Prisma.ClinicalRecordIndexCreateInput; update: Prisma.ClinicalRecordIndexUpdateInput } {
  const phoneHashes = r.phoneHashes.length ? r.phoneHashes : (existing?.phoneHashes ?? [])
  const keepNote = !!existing?.hasNote && !r.hasNote
  const billTtlAmt = r.billTtlAmt ?? existing?.billTtlAmt ?? null
  const billOsAmt = r.billOsAmt ?? existing?.billOsAmt ?? null
  // 無 note → Prisma.DbNull（SQL NULL；Prisma 6 Json 欄唔接受裸 null）
  const noteJson: Prisma.InputJsonValue | typeof Prisma.DbNull = keepNote
    ? (existing!.noteJson as Prisma.InputJsonValue)
    : r.hasNote
      ? (r.noteJson as Prisma.InputJsonValue)
      : Prisma.DbNull
  const noteFields = keepNote
    ? { hasNote: true, noteKind: existing!.noteKind, noteJson }
    : { hasNote: r.hasNote, noteKind: r.noteKind, noteJson }
  const vdate = new Date(`${r.visitDate}T00:00:00Z`)
  return {
    create: {
      clinicId: r.clinicId,
      patientApricotId: r.patientApricotId,
      patientCode: r.patientCode,
      phoneHashes,
      visitDate: vdate,
      apricotApptId: r.apricotApptId,
      apricotNoteId: keepNote ? existing!.apricotNoteId : r.apricotNoteId,
      bookingStatus: r.bookingStatus,
      visitReasonCodes: r.visitReasonCodes,
      providerCode: r.providerCode,
      ...noteFields,
      rxCodes: r.rxCodes ?? [],
      billTtlAmt,
      billOsAmt,
      syncedAt: new Date(),
    },
    update: {
      clinicId: r.clinicId,
      patientCode: r.patientCode,
      apricotNoteId: keepNote ? existing!.apricotNoteId : r.apricotNoteId,
      bookingStatus: r.bookingStatus,
      visitReasonCodes: r.visitReasonCodes,
      providerCode: r.providerCode,
      ...noteFields,
      // rxCodes 跟 note 欄走（keepNote = 保留現有；新 note = 新抽取）— 同 P1 守則
      rxCodes: keepNote ? (existing!.rxCodes ?? []) : (r.rxCodes ?? []),
      billTtlAmt,
      billOsAmt,
      // phoneHashes 只係新值非空先覆寫（守則；update 路徑 existing 必非空）
      ...(r.phoneHashes.length ? { phoneHashes: r.phoneHashes } : {}),
      syncedAt: new Date(),
    },
  }
}

/**
 * 🔴 唯一寫入路徑 — upsert ClinicalRecordIndex（見檔案頭守則）。
 *
 * Prisma 6 限制：composite unique input 唔接受 null（apricotApptId 型 = string）。
 * - apricotApptId 非 null → 原子 typed upsert（夜跑／回填／刷新並行都安全）。
 * - apricotApptId null（defensive — P1 resolvePatientDay 無 appointment 錨點
 *   直接返 null，實際唔會入呢度）→ findFirst + create/update（PG unique 對
 *   NULL 唔衝突，低並發下可接受）。
 */
export async function upsertVisitIndex(r: ResolvedVisit): Promise<void> {
  const vdate = new Date(`${r.visitDate}T00:00:00Z`)

  if (r.apricotApptId === null) {
    const existing = await basePrisma.clinicalRecordIndex.findFirst({
      where: { patientApricotId: r.patientApricotId, visitDate: vdate, apricotApptId: null },
      select: SELECT_MERGE,
    })
    const m = merged(r, existing)
    if (existing) {
      await basePrisma.clinicalRecordIndex.update({ where: { id: existing.id }, data: m.update })
    } else {
      await basePrisma.clinicalRecordIndex.create({ data: m.create })
    }
    return
  }

  const where = {
    patientApricotId_visitDate_apricotApptId: {
      patientApricotId: r.patientApricotId,
      visitDate: vdate,
      apricotApptId: r.apricotApptId,
    },
  }
  const existing = await basePrisma.clinicalRecordIndex.findUnique({ where, select: SELECT_MERGE })
  const m = merged(r, existing)
  await basePrisma.clinicalRecordIndex.upsert({ where, create: m.create, update: m.update })
}

/** Apricot clinicId → 本系統 Clinic.id（只收有 apricotClinicId 嘅 clinic）。 */
export async function buildClinicMap(): Promise<Map<string, string>> {
  const clinics = await basePrisma.clinic.findMany({
    where: { apricotClinicId: { not: null } },
    select: { id: true, apricotClinicId: true },
  })
  return new Map(clinics.map((c) => [c.apricotClinicId as string, c.id]))
}

/** walk-in（冇預約）到診嘅 bookingStatus — 4 = 已完成（同 Apricot 完成預約一致；跟進規則當正常到診）。 */
export const WALK_IN_BOOKING_STATUS = 4

/**
 * 由病人三樣 raw 資料 resolve 出一個 visit 索引（純函數 — unit 可測）。
 * 錨點：當日已到診預約 → 否則 walk-in（冇掛預約嘅診症記錄／帳單；cwi-walkin-20261018 取代設計決定 #4）。
 * 返 null = 當日乜都冇。
 */
export function resolvePatientDay(opts: {
  patient: any
  appointments: any[]
  notes: any[]
  bills: any[]
  day: string
  /** Apricot clinicId → 本系統 Clinic.id（未設 apricotClinicId 嘅 clinic 唔喺入面）。 */
  clinicMap: Map<string, string>
  phoneKey: string
  /** 藥物字典（cwi-followup-p4 S4 — note → rxCodes 抽取；唔傳 = []）。 */
  rxCodeEntries?: RxCodeEntry[]
}): ResolvedVisit | null {
  const { patient, appointments, notes, bills, day, clinicMap, phoneKey, rxCodeEntries } = opts

  // 1) 錨點 = 該日嘅 appointment（conTime／checkInTime 嘅 HK 日 — MD §2.2 visitDate 定義；
  //    conTime 可能係 UTC Z 格式 → 必須 toHKDateStr，唔好用字串前綴）
  const appt = appointments.find((a) => {
    const t = a?.conTime ?? a?.checkInTime
    return typeof t === 'string' && t.length >= 10 && toHKDateStr(t) === day
  }) ?? null

  // ★ cwi-walkin-20261018（擁有人拍板：walk-in 要算到診）：當日冇已到診預約，但有「冇掛預約」嘅診症記錄
  //   或帳單 → 用佢做錨點（bookingStatus = 4 已完成）。冇掛預約 = bookingId 空（掛咗其他預約嘅 note 唔濫配）。
  const onDay = (t: unknown) => typeof t === 'string' && t.length >= 10 && toHKDateStr(t) === day
  const unlinkedNote = notes.find((n) => !n?.bookingId && onDay(n?.conTime)) ?? null
  const dayBill = bills.find((b) => b && !b.isVoid && onDay(b.billTime)) ?? null
  const walkIn = appt ? null : (unlinkedNote ?? dayBill)
  if (!appt && !walkIn) return null

  const anchorClinic: unknown = appt ? appt.clinicId : (walkIn?.clinicId ?? walkIn?.clinic?.id)
  const apricotClinicId: string | null = typeof anchorClinic === 'string' ? anchorClinic : (patient?.registrationClinic ?? null)
  const clinicId = apricotClinicId ? clinicMap.get(apricotClinicId) : undefined
  if (!clinicId) return null // clinic 映射唔到（dev clinic 未設 apricotClinicId）→ 跳

  // 2) note 對接：bookingId === appointment.id（§0.3 note 結構）；預約冇掛 note → 同日「冇掛預約」嘅 note
  //    （醫生喺 Apricot 直接開診症記錄、無揀預約嘅情況）
  const note = appt
    ? (appt.id ? notes.find((n) => n?.bookingId === appt.id) : undefined) ?? unlinkedNote
    : unlinkedNote
  const noteText: NoteText | null = note ? extractNoteText(note) : null

  // 3) 帳單：當日非 void 合計（MD §2.3「取 ttl/os」）— 有 billTime 嘅（overview 全部日子）只計當日
  const valid = bills.filter((b) => b && !b.isVoid && (typeof b.billTime !== 'string' || onDay(b.billTime)))
  const billTtlAmt = valid.length ? Math.round(valid.reduce((s, b) => s + (Number(b.ttlAmt) || 0), 0)) : null
  const billOsAmt = valid.length ? Math.round(valid.reduce((s, b) => s + (Number(b.osAmt) || 0), 0)) : null

  // 4) 電話 → 多號 hash（§1.2）— 原始號碼只喺呢一刻用，唔入庫
  const phoneNum: string | null =
    typeof patient?.phoneNum === 'string' ? patient.phoneNum : ((appt ?? walkIn)?.clinicPatient?.phoneNum ?? null)
  const practitioner = appt?.practitioner ?? note?.practitioner ?? walkIn?.practitioner

  return {
    clinicId,
    patientApricotId: patient.cpId ?? patient.id ?? '',
    patientCode: patient.code ?? null,
    phoneHashes: phoneHashes(phoneNum, phoneKey),
    visitDate: day,
    apricotApptId: typeof appt?.id === 'string' ? appt.id : null,
    apricotNoteId: typeof note?.id === 'string' ? note.id : null,
    // 鐵律 7：爽約明確 -3（原樣存 bookingStatus；觸發邏輯先判斷 — 唔喺入庫時過濾）
    bookingStatus: appt ? Number(appt.bookingStatus ?? 0) : WALK_IN_BOOKING_STATUS,
    visitReasonCodes: Array.isArray(appt?.visitReasons) ? appt.visitReasons.map((v: any) => v?.code).filter((c: unknown): c is string => typeof c === 'string') : [],
    providerCode: typeof appt?.providerCode === 'string' ? appt.providerCode : (typeof practitioner?.code === 'string' ? practitioner.code : null),
    hasNote: !!noteText,
    noteKind: noteText ? noteText.kind : null,
    noteJson: noteText,
    // S4：藥物 code（note → 字典匹配；零全文入庫）
    rxCodes: rxCodeEntries ? extractRxCodes(noteText, rxCodeEntries) : [],
    billTtlAmt,
    billOsAmt,
  }
}

/**
 * 重掃專用（MD §2.3「parseVersion 唔變，只更新 note 欄」）：
 * 只更新 note 四欄 + syncedAt — 唔動 bookingStatus／bill／phone。
 */
export async function rescanUpdateNote(
  rowId: string,
  note: { apricotNoteId: string | null; noteKind: string; noteJson: NoteText },
): Promise<void> {
  await basePrisma.clinicalRecordIndex.update({
    where: { id: rowId },
    data: {
      apricotNoteId: note.apricotNoteId,
      noteKind: note.noteKind,
      noteJson: note.noteJson,
      hasNote: true,
      syncedAt: new Date(),
    },
  })
}
