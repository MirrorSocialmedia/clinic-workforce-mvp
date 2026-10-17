// ============================================================
// ★ cwi-patient-identify-20261017：用電話認病人（新客／舊客判定 — 擁有人拍板）
//
// 背景：以前要有預約先配到病人（索引只由預約同步嚟）— 冇預約嘅舊客判唔到。
// 做法：逐個 Apricot 帳號（青衣／臻善＋匯樂…）直接搜 clinic-patients?keyword=：
//   ① 搜尋寫法 = 實測結果（2026-10-17 probe）：Apricot 用字串比對 — 「dddd dddd」（兩段都要有）
//      同「dddddddd」搵到；帶國碼／橫線搵唔到。兩種都搜、合併。
//   ② 每個結果再核對電話欄（phoneNum／phoneList）係咪同一個號碼 — 搜尋字眼誤中嘅篩走。
//   ③ 認到嘅病人 upsert PatientIndex（id／編號／姓名／舊格式 hash／帳號）
//      → visits／balance／refresh 之後識揀返正確帳號；patient-lookup 亦搵到。
// 結果：FOUND（≥1）／NOT_FOUND（全部帳號搜過都冇）／PARTIAL（有帳號失敗而且冇搵到 — 唔當新客）。
// 🔴 原始電話只喺記憶體用嚟搜同核對 — 唔寫 log、唔落庫（PatientIndex 只存 hash）。
// ============================================================
import { prisma } from '@/lib/prisma'
import { withApricotLockRetry, searchPatients } from '@/lib/apricot/client'
import { listApricotAccounts, withApricotAccount, normalizeApricotAccount } from '@/lib/apricot/account'
import { effectivePrefixes } from '@/lib/apricot/sources'
import { sourceErrorText, sourceLabel, clinicFor, type SourceClinic } from '@/lib/patient-search'
import { probeTarget, patientPhoneStrings, phoneFieldMatches, type ProbeTarget } from '@/lib/apricot/phone-probe'
import { phoneHash } from '@/lib/phone-hash'

export interface IdentifiedPatient {
  patientApricotId: string
  patientCode: string
  patientName: string
  source: string // 帳號顯示名（佢服務嘅診所）
  clinicId: string | null
  clinicLabel: string
}

export interface IdentifyResult {
  status: 'FOUND' | 'NOT_FOUND' | 'PARTIAL'
  patients: IdentifiedPatient[]
  sources: { label: string; ok: boolean; found: number; error?: string }[]
}

/** 實測有效嘅搜尋寫法（香港：「dddd dddd」+「dddddddd」；內地：「ddd dddd dddd」+ 11 位） */
export function identifyKeywords(t: ProbeTarget): string[] {
  const c = t.core
  if (t.kind === 'HK') return [`${c.slice(0, 4)} ${c.slice(4)}`, c]
  if (t.kind === 'CN') return [`${c.slice(0, 3)} ${c.slice(3, 7)} ${c.slice(7)}`, c]
  return [c]
}

export async function identifyPatientByPhone(rawPhone: string): Promise<IdentifyResult | null> {
  const target = probeTarget(rawPhone)
  if (!target) return null
  const keywords = identifyKeywords(target)

  const [clinicRows, settings] = await Promise.all([
    prisma.clinic.findMany({
      where: { apricotClinicId: { not: null } },
      select: { id: true, name: true, shortName: true, apricotAccount: true, patientCodePrefix: true },
      orderBy: { name: 'asc' },
    }),
    prisma.apricotSource.findMany({ select: { account: true, displayName: true } }),
  ])
  const clinics: SourceClinic[] = clinicRows.map(c => ({ id: c.id, name: c.name, prefixes: effectivePrefixes(c), account: normalizeApricotAccount(c.apricotAccount) }))
  const labelOf = (account: string) =>
    sourceLabel(clinics.filter(c => c.account === account), settings.find(r => normalizeApricotAccount(r.account) === account)?.displayName)

  const patients: IdentifiedPatient[] = []
  const sources: IdentifyResult['sources'] = []
  const now = new Date()
  for (const account of await listApricotAccounts()) {
    const label = labelOf(account)
    const seen = new Map<string, { p: any; phone: string }>()
    let error: string | undefined
    for (const kw of keywords) {
      try {
        const raw = await withApricotAccount(account, () => withApricotLockRetry(() => searchPatients(kw)))
        for (const p of Array.isArray(raw) ? raw : []) {
          const id = p?.id != null ? String(p.id) : ''
          if (!id || seen.has(id)) continue
          const phone = patientPhoneStrings(p).find(f => phoneFieldMatches(f, target))
          if (phone) seen.set(id, { p, phone })
        }
      } catch (e) {
        error = sourceErrorText(e)
        break // 呢個帳號用唔到 → 唔使再試第二種寫法
      }
    }
    for (const [id, { p, phone }] of seen) {
      const code = String(p.code ?? '')
      const name = String(p.fullName ?? p.chiFullName ?? '')
      const where = clinicFor(code, account, clinics, labelOf)
      patients.push({ patientApricotId: id, patientCode: code, patientName: name, source: label, ...where })
      // 寫入病人索引（帳號 + 舊格式 hash）— visits／balance／refresh 揀帳號；patient-lookup 搵到
      await prisma.patientIndex.upsert({
        where: { patientApricotId: id },
        update: { patientCode: code, patientName: name, phoneHash: phoneHash(phone), lastSeenAt: now, apricotAccount: account },
        create: { patientApricotId: id, patientCode: code, patientName: name, phoneHash: phoneHash(phone), lastSeenAt: now, apricotAccount: account },
      })
    }
    sources.push({ label, ok: !error, found: seen.size, ...(error ? { error } : {}) })
    console.info(`[patient-identify] 來源=${label} found=${seen.size}${error ? ` error=${error}` : ''}`)
  }

  const status: IdentifyResult['status'] = patients.length > 0 ? 'FOUND' : sources.every(s => s.ok) ? 'NOT_FOUND' : 'PARTIAL'
  return { status, patients, sources }
}
