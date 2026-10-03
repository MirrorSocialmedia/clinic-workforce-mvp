// ============================================================
// ★ cwm-patientsearch-20261003：統一病人搜尋（第一期）
//
// 背景：青衣係另一個 Apricot 帳號（病人編號純數字），舊版逐帳號搜之後 `slice(0, 20)`，
//   某帳號失敗只 console.warn —— 員工見唔到青衣結果亦唔知點解。
//
// 做法：
//   ① 每個「資料來源」（= Apricot 帳號，以佢服務嘅診所名稱顯示，唔出現帳號代號）各自搜
//   ② 加埋本地病人索引（PatientIndex，有預約記錄嘅病人）—— 即時、唔使 Apricot
//   ③ 合併排序：編號完全吻合 > 編號頭尾吻合 > 編號包含 > 姓名；同分按來源輪流排（唔會互相擠走）
//   ④ 每個結果帶診所（編號前綴推斷；來源只服務一間診所就直接用嗰間）
//   ⑤ 每個來源回報狀態（成功幾多筆／失敗原因）—— 畫面顯示，log 亦記低（只記筆數同欄位名，唔記病人資料）
//
// 第二期（另做）：來源設定化（顯示名、編號格式、前綴規則入 DB），轉介／SP／wa-inbox 共用。
// ============================================================
import { prisma } from '@/lib/prisma'
import { withApricotLockRetry, searchPatients } from '@/lib/apricot/client'
import { listApricotAccounts, withApricotAccount, normalizeApricotAccount } from '@/lib/apricot/account'
import { guessClinicByPatientCode } from '@/lib/cost-entry/clinic-prefix'

export interface PatientHit {
  extId: string
  code: string
  fullName: string
  account: string // 內部用（bill-search 要帶返）；畫面唔顯示
  clinicId: string | null // 推斷到嘅診所
  clinicLabel: string // 顯示用：診所名（推唔到 = 來源名）
}

export interface SourceStatus {
  label: string // 來源顯示名（佢服務嘅診所）
  ok: boolean
  found: number
  error?: string
}

type SourceClinic = { id: string; name: string; shortName: string | null; account: string }

const ERROR_TEXT: Record<string, string> = {
  APRICOT_AUTH_EXPIRED: '憑證失效，需要重新授權',
  APRICOT_NOT_CONFIGURED: '未設定憑證',
  APRICOT_BUSY: 'Apricot 忙碌，請稍後重試',
}
export function sourceErrorText(e: unknown): string {
  const msg = String((e as any)?.message ?? e ?? '')
  for (const [k, v] of Object.entries(ERROR_TEXT)) if (msg.includes(k)) return v
  if (msg.startsWith('APRICOT_HTTP_')) return `連線失敗（${msg.replace('APRICOT_HTTP_', 'HTTP ')}）`
  return '連線失敗'
}

/** 來源顯示名：佢服務嘅診所（1–2 間直接列名；多過 2 間 =「旺角等 5 間」） */
export function sourceLabel(clinics: { name: string; shortName: string | null }[]): string {
  const names = clinics.map(c => c.name)
  if (names.length === 0) return '其他'
  if (names.length <= 2) return names.join('、')
  return `${names[0]}等 ${names.length} 間`
}

/** 0 = 編號完全吻合；1 = 編號頭／尾吻合；2 = 編號包含；3 = 姓名包含；4 = 其他（Apricot 自己 match 到） */
export function matchScore(keyword: string, code: string, name: string): number {
  const k = keyword.trim().toUpperCase()
  const c = code.trim().toUpperCase()
  if (!k) return 4
  if (c === k) return 0
  if (c.startsWith(k) || c.endsWith(k)) return 1
  if (c.includes(k)) return 2
  if (name.toUpperCase().includes(k)) return 3
  return 4
}

/** 合併：同一病人（account+extId）去重；按分數，同分按來源輪流；最多 limit 個 */
export function mergeHits(keyword: string, bySource: PatientHit[][], limit = 30): PatientHit[] {
  const seen = new Set<string>()
  const scored: { h: PatientHit; score: number; src: number; idx: number }[] = []
  bySource.forEach((hits, src) => hits.forEach((h, idx) => {
    const key = `${h.account}|${h.extId}`
    if (seen.has(key)) return
    seen.add(key)
    scored.push({ h, score: matchScore(keyword, h.code, h.fullName), src, idx })
  }))
  scored.sort((a, b) => a.score - b.score || a.idx - b.idx || a.src - b.src)
  return scored.slice(0, limit).map(x => x.h)
}

function clinicFor(code: string, account: string, clinics: SourceClinic[]): { clinicId: string | null; clinicLabel: string } {
  const mine = clinics.filter(c => c.account === account)
  const byPrefix = guessClinicByPatientCode(code, mine.map(c => ({ id: c.id, shortName: c.shortName })))
  const hit = byPrefix ? mine.find(c => c.id === byPrefix) : (mine.length === 1 ? mine[0] : null)
  return hit ? { clinicId: hit.id, clinicLabel: hit.name } : { clinicId: null, clinicLabel: sourceLabel(mine) }
}

/** Apricot 回嘅病人 → PatientHit（只攞 id／編號／姓名三欄，PII 白名單同 toCleanPatients 一致） */
function toHits(raw: unknown, account: string, clinics: SourceClinic[]): PatientHit[] {
  const arr = Array.isArray(raw) ? raw : []
  return arr.slice(0, 20).map((p: any) => {
    const code = String(p.code ?? '')
    return {
      extId: String(p.id ?? ''),
      code,
      fullName: String(p.fullName ?? p.chiFullName ?? ''),
      account,
      ...clinicFor(code, account, clinics),
    }
  }).filter(p => p.extId && p.code)
}

export async function searchPatientsAllSources(keyword: string): Promise<{ patients: PatientHit[]; sources: SourceStatus[] }> {
  const clinicRows = await prisma.clinic.findMany({
    where: { apricotClinicId: { not: null } },
    select: { id: true, name: true, shortName: true, apricotAccount: true },
    orderBy: { name: 'asc' },
  })
  const clinics: SourceClinic[] = clinicRows.map(c => ({ id: c.id, name: c.name, shortName: c.shortName, account: normalizeApricotAccount(c.apricotAccount) }))
  const labelOf = (account: string) => sourceLabel(clinics.filter(c => c.account === account))

  const bySource: PatientHit[][] = []
  const sources: SourceStatus[] = []
  const errors: unknown[] = []

  // ① 本地病人索引（有預約記錄先有；冇都唔緊要）
  try {
    const local = await prisma.patientIndex.findMany({
      where: { patientCode: { contains: keyword.trim(), mode: 'insensitive' } },
      select: { patientApricotId: true, patientCode: true, patientName: true, apricotAccount: true },
      take: 20,
    })
    bySource.push(local.map(p => {
      const account = normalizeApricotAccount(p.apricotAccount)
      return { extId: p.patientApricotId, code: p.patientCode, fullName: p.patientName, account, ...clinicFor(p.patientCode, account, clinics) }
    }))
  } catch (e) {
    console.warn('[patient-search] 本地索引查詢失敗', (e as any)?.message)
  }

  // ② 逐個 Apricot 來源（全局鎖：一個一個嚟）
  for (const account of await listApricotAccounts()) {
    const label = labelOf(account)
    try {
      const raw = await withApricotAccount(account, () => withApricotLockRetry(() => searchPatients(keyword)))
      const hits = toHits(raw, account, clinics)
      const rawCount = Array.isArray(raw) ? raw.length : -1
      // ★ 診斷：只記筆數；Apricot 有回但全部被濾走 → 記低第一筆嘅【欄位名】（唔記值，唔會漏 PII）
      console.info(`[patient-search] 來源=${label} raw=${rawCount} kept=${hits.length}`)
      if (rawCount > 0 && hits.length === 0) {
        console.warn(`[patient-search] 來源=${label} 有回應但冇一筆有 id+code，欄位：${Object.keys((raw as any[])[0] ?? {}).join(',')}`)
      }
      if (rawCount < 0) console.warn(`[patient-search] 來源=${label} 回應唔係陣列：${typeof raw}`)
      bySource.push(hits)
      sources.push({ label, ok: true, found: hits.length })
    } catch (e) {
      errors.push(e)
      console.warn(`[patient-search] 來源=${label} 搜尋失敗`, (e as any)?.message)
      sources.push({ label, ok: false, found: 0, error: sourceErrorText(e) })
    }
  }

  const patients = mergeHits(keyword, bySource)
  // 全部 Apricot 來源失敗而本地都冇 → 照舊拋錯（route 轉 503／401／502）
  if (patients.length === 0 && errors.length > 0 && errors.length === sources.length) throw errors[0]
  return { patients, sources }
}
