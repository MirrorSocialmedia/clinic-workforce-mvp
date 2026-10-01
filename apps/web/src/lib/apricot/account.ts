// ============================================================
// Apricot 多帳號（cwm-apricotty-20261001）
//
// 背景：青衣（菁薈）係另一個 Apricot 帳號（另一套登入 cookie），之前系統只得一個帳號。
// 做法：「每間店歸一個帳號」— Clinic.apricotAccount（預設 MAIN）。
//   - 按店嘅操作（收款 sync、時間表、寫入預約）→ 由店搵帳號
//   - 按病人嘅操作（visits／note／balance／refresh）→ PatientIndex.apricotAccount
//   - 按日子掃全帳號嘅 job（臨床索引、字典）→ 逐個帳號跑
//
// 機制：AsyncLocalStorage 帶住「而家用緊邊個帳號」—— apricotCall 讀佢揀 token。
//   冇設 = MAIN → 現有代碼零改動照行（未寫入青衣 token 之前行為一分唔變）。
//
// ⚠️ 限流鎖（776001）刻意維持【全局一把】唔逐帳號分：
//   Apricot 每個 request 都 rotate token（iat），同一帳號並發即死；全局鎖係最穩陣嘅保證，
//   青衣只係多一間店嘅量。
// ============================================================
import { AsyncLocalStorage } from 'node:async_hooks'
import { prisma } from '@/lib/prisma'

export const APRICOT_MAIN = 'MAIN'
/** 帳號名：大階英文／數字／底線（入 credential key、URL query，唔准亂） */
export const APRICOT_ACCOUNT_RE = /^[A-Z][A-Z0-9_]{0,15}$/

const als = new AsyncLocalStorage<string>()

export function normalizeApricotAccount(a: string | null | undefined): string {
  const v = (a ?? '').trim().toUpperCase()
  return v && APRICOT_ACCOUNT_RE.test(v) ? v : APRICOT_MAIN
}

/** 而家嘅帳號（冇設 = MAIN） */
export function currentApricotAccount(): string {
  return als.getStore() ?? APRICOT_MAIN
}

/** 喺指定帳號下行 fn（入面所有 apricotCall 用該帳號 token） */
export function withApricotAccount<T>(account: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  return als.run(normalizeApricotAccount(account), fn)
}

/**
 * ExternalCredential.provider 值：MAIN 沿用舊值 'APRICOT'（現有行唔使 migrate），
 * 其他帳號 = 'APRICOT:<帳號>'（provider 本身係 unique）。
 */
export function credentialProviderKey(account: string): string {
  const a = normalizeApricotAccount(account)
  return a === APRICOT_MAIN ? 'APRICOT' : `APRICOT:${a}`
}

/** apricotClinicId → 帳號（搵唔到 = MAIN） */
export async function accountForApricotClinic(apricotClinicId: string | null | undefined): Promise<string> {
  if (!apricotClinicId) return APRICOT_MAIN
  const c = await prisma.clinic.findUnique({ where: { apricotClinicId }, select: { apricotAccount: true } })
  return normalizeApricotAccount(c?.apricotAccount)
}

/** 本地 Clinic.id → 帳號（搵唔到 = MAIN） */
export async function accountForClinic(clinicId: string | null | undefined): Promise<string> {
  if (!clinicId) return APRICOT_MAIN
  const c = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { apricotAccount: true } })
  return normalizeApricotAccount(c?.apricotAccount)
}

/**
 * 病人 → 帳號：① PatientIndex（預約索引寫入時記低）② 預約／臨床索引嘅店 → 店帳號
 * ③ 都搵唔到 = MAIN（同舊行為一樣）。
 */
export async function accountForPatient(patientApricotId: string | null | undefined): Promise<string> {
  if (!patientApricotId) return APRICOT_MAIN
  const p = await prisma.patientIndex.findUnique({ where: { patientApricotId }, select: { apricotAccount: true } })
  if (p) return normalizeApricotAccount(p.apricotAccount)
  const appt = await prisma.appointmentIndex.findFirst({ where: { patientApricotId }, select: { clinicId: true }, orderBy: { date: 'desc' } })
  const visit = appt ? null : await prisma.clinicalRecordIndex.findFirst({ where: { patientApricotId }, select: { clinicId: true }, orderBy: { visitDate: 'desc' } })
  return accountForClinic(appt?.clinicId ?? visit?.clinicId ?? null)
}

/**
 * 有設定嘅帳號（有接通店 + 有 token）— 全帳號 job 用。
 * MAIN 永遠喺第一位（即使未寫 token，保持舊行為：冇 token → APRICOT_NOT_CONFIGURED）。
 */
export async function listApricotAccounts(): Promise<string[]> {
  const rows = await prisma.clinic.findMany({
    where: { apricotClinicId: { not: null } },
    select: { apricotAccount: true },
    distinct: ['apricotAccount'],
  })
  const set = new Set<string>([APRICOT_MAIN, ...rows.map(r => normalizeApricotAccount(r.apricotAccount))])
  return [...set].sort((a, b) => (a === APRICOT_MAIN ? -1 : b === APRICOT_MAIN ? 1 : a.localeCompare(b)))
}

/** 「成個帳號用唔到」嘅錯誤（token 失效／未寫入）— 同帳號剩餘工作跳過，其他帳號照做 */
export function isAccountDeadError(msg: string): boolean {
  return msg.includes('APRICOT_AUTH_EXPIRED') || msg.includes('APRICOT_NOT_CONFIGURED')
}
