// ============================================================
// ★ cwm-datasource-20261003：Apricot 資料來源（第二期 —— 設定化）
//
// 「來源」= 一個 Apricot 帳號（一套登入 cookie）。之前帳號代號、顯示名、編號規則都寫死喺代碼／靠
//  shortName 估；而家入 DB，由「資料來源」設定頁管理：
//   - 顯示名（員工見到嘅名；冇設 = 佢服務嘅診所名）
//   - 病人編號格式（排序用）、每間店嘅編號前綴（推斷診所用）
//   - 憑證：狀態、網頁貼新 token（取代 docker exec 腳本）、測試連線
// 帳號代號（MAIN／TY／S2…）只係內部 key，唔顯示俾員工。
// ============================================================
import { prisma } from '@/lib/prisma'
import { APRICOT_MAIN, normalizeApricotAccount, withApricotAccount, credentialProviderKey } from './account'
import { withApricotLockRetry, searchPatients } from './client'
import { credentialHealth, normalizeCodePattern, parsePrefixList, type CodePattern, type CredentialHealth } from './source-pure'

export type SourceClinicView = {
  id: string
  name: string
  shortName: string | null
  patientCodePrefix: string | null
  /** 實際用嚟推斷嘅前綴（有設 patientCodePrefix 用佢，否則 shortName） */
  effectivePrefixes: string[]
}

export type SourceView = {
  account: string
  displayName: string
  /** 冇自訂顯示名（用緊診所名） */
  displayNameIsDefault: boolean
  patientCodePattern: CodePattern | null
  clinics: SourceClinicView[]
  credential: {
    configured: boolean
    lastOkAt: Date | null
    lastError: string | null
    refreshExpiry: Date | null
    updatedAt: Date | null
    health: CredentialHealth
  }
}

/** ExternalCredential.provider → 帳號（'APRICOT' → MAIN；'APRICOT:TY' → TY；其他 null） */
export function accountOfProvider(provider: string): string | null {
  if (provider === 'APRICOT') return APRICOT_MAIN
  if (provider.startsWith('APRICOT:')) return normalizeApricotAccount(provider.slice(8))
  return null
}

/** 1–2 間直接列名；多過 2 間 =「旺角等 5 間」 */
export function defaultSourceName(clinicNames: string[]): string {
  if (clinicNames.length === 0) return '未分配診所'
  if (clinicNames.length <= 2) return clinicNames.join('、')
  return `${clinicNames[0]}等 ${clinicNames.length} 間`
}

export function effectivePrefixes(c: { shortName: string | null; patientCodePrefix: string | null }): string[] {
  const own = parsePrefixList(c.patientCodePrefix)
  if (own.length) return own
  const s = (c.shortName ?? '').trim().toUpperCase()
  return /^[A-Z]{1,6}$/.test(s) ? [s] : []
}

/** 全部來源（DB 設定 ∪ 有店用緊 ∪ 有憑證）—— MAIN 永遠第一 */
export async function listSources(now: Date = new Date()): Promise<SourceView[]> {
  const [rows, clinics, creds] = await Promise.all([
    prisma.apricotSource.findMany(),
    prisma.clinic.findMany({
      where: { apricotClinicId: { not: null } },
      select: { id: true, name: true, shortName: true, apricotAccount: true, patientCodePrefix: true },
      orderBy: { name: 'asc' },
    }),
    prisma.externalCredential.findMany({
      where: { provider: { startsWith: 'APRICOT' } },
      select: { provider: true, lastOkAt: true, lastError: true, refreshExpiry: true, updatedAt: true },
    }),
  ])
  const accounts = new Set<string>([APRICOT_MAIN])
  rows.forEach(r => accounts.add(normalizeApricotAccount(r.account)))
  clinics.forEach(c => accounts.add(normalizeApricotAccount(c.apricotAccount)))
  creds.forEach(c => { const a = accountOfProvider(c.provider); if (a) accounts.add(a) })

  const sorted = [...accounts].sort((a, b) => (a === APRICOT_MAIN ? -1 : b === APRICOT_MAIN ? 1 : a.localeCompare(b)))
  return sorted.map(account => {
    const row = rows.find(r => normalizeApricotAccount(r.account) === account)
    const mine = clinics.filter(c => normalizeApricotAccount(c.apricotAccount) === account)
    const cred = creds.find(c => c.provider === credentialProviderKey(account)) ?? null
    const custom = row?.displayName?.trim()
    return {
      account,
      displayName: custom || defaultSourceName(mine.map(c => c.name)),
      displayNameIsDefault: !custom,
      patientCodePattern: normalizeCodePattern(row?.patientCodePattern),
      clinics: mine.map(c => ({
        id: c.id, name: c.name, shortName: c.shortName, patientCodePrefix: c.patientCodePrefix,
        effectivePrefixes: effectivePrefixes(c),
      })),
      credential: {
        configured: !!cred,
        lastOkAt: cred?.lastOkAt ?? null,
        lastError: cred?.lastError ?? null,
        refreshExpiry: cred?.refreshExpiry ?? null,
        updatedAt: cred?.updatedAt ?? null,
        health: credentialHealth(cred, now),
      },
    }
  })
}

/** 已知來源？（設定 row／有店／有憑證）—— 改店歸屬、貼憑證前驗證，防打錯代號生出幽靈帳號 */
export async function isKnownSource(account: string): Promise<boolean> {
  const a = normalizeApricotAccount(account)
  if (a === APRICOT_MAIN) return true
  const [row, clinic, cred] = await Promise.all([
    prisma.apricotSource.findUnique({ where: { account: a }, select: { id: true } }),
    prisma.clinic.findFirst({ where: { apricotAccount: a }, select: { id: true } }),
    prisma.externalCredential.findUnique({ where: { provider: credentialProviderKey(a) }, select: { id: true } }),
  ])
  return !!(row || clinic || cred)
}

/**
 * 測試連線：用一個唔會中嘅編號搜一次病人（最平嘅 call；結果直接丟，唔 log）。
 * 成功 = apricotCall 已經寫返 lastOkAt；失敗 = 已 markError。
 */
export async function testSourceConnection(account: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await withApricotAccount(account, () => withApricotLockRetry(() => searchPatients('ZZ0000000000')))
    // apricotCall 只喺有 rotation 先寫 lastOkAt —— 測試成功一定要標記，否則一直「未驗證」
    await prisma.externalCredential.update({
      where: { provider: credentialProviderKey(account) },
      data: { lastOkAt: new Date(), lastError: null },
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e as any)?.message ?? e) }
  }
}
