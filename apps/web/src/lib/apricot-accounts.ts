/**
 * lib/apricot-accounts.ts — Apricot 帳號唯讀 helper（cwm-apricotacct-20260913 Stage 2）
 *
 * ★ 老細鐵律①：Provider.apricotId 已剷走，`ApricotPractitioner` 表係【唯一來源】。
 *   所有需要「醫生 ↔ Apricot 帳號」映射嘅代碼，一律經呢度，唔准直直讀 Provider。
 *   tsc 會逼所有舊 caller 改到嚟（呢個係設計，唔准用 as any / getter 兜住）。
 */

/**
 * ★ 一個醫生嘅【全部】Apricot 帳號 id。
 *   ⚠️ 回空 array 代表「冇綁任何帳號」—— caller 唔可以當成「唔 filter」。
 *      Prisma { in: [] } 回零行，會靜靜出一張 $0 月結單 → 一定要明確 throw。
 */
export async function apricotIdsOfProvider(db: any, providerId: string): Promise<string[]> {
  const rows = await db.apricotPractitioner.findMany({
    where: { providerId, kind: 'PROVIDER' },
    select: { apricotId: true },
  })
  return rows.map(({ apricotId }: { apricotId: string }) => apricotId)
}

/** apricotId → { apricotId, name, kind, providerId?, clinicId? }（一個 map，一次 query） */
export async function resolveApricotAccounts(db: any, apricotIds: string[]) {
  if (apricotIds.length === 0) return new Map<string, any>()
  const rows = await db.apricotPractitioner.findMany({
    where: { apricotId: { in: apricotIds } },
    select: { apricotId: true, name: true, kind: true, providerId: true, clinicId: true },
  })
  return new Map(rows.map((r: any) => [r.apricotId, r] as [string, any])) // ApricotPractitioner row
}

/**
 * ★ F 章：醫生帳號重複檢查（api/providers POST/PUT 共用）。
 *   ① 請求內重複 → 「重複輸入」
 *   ② 已被其他個體綁定 → 錯誤訊息帶邊個（kind=CLINIC → 「診所帳號」，其餘 → 「另一位醫生」）
 *   回 null = 冇重複。
 * @param excludeProviderId PUT 時傳自己 id（自己已綁嘅帳號唔算重複）
 */
export async function findDuplicateProviderAccounts(
  db: any,
  accounts: Array<{ apricotId: string; name?: string }>,
  excludeProviderId: string | null,
): Promise<string | null> {
  if (accounts.length === 0) return null
  const seen = new Set<string>()
  for (const { apricotId } of accounts) {
    if (seen.has(apricotId)) {
      return `Apricot ID「${apricotId}」重複輸入`
    }
    seen.add(apricotId)
  }
  const existing = await db.apricotPractitioner.findMany({
    where: {
      apricotId: { in: accounts.map(({ apricotId }) => apricotId) },
      ...(excludeProviderId ? { providerId: { not: excludeProviderId } } : {}),
    },
    select: { apricotId: true, name: true, kind: true, providerId: true },
  })
  for (const { apricotId: exId, kind, name, providerId } of existing) {
    if (providerId === excludeProviderId) continue
    return `Apricot ID「${exId}」已經綁咗${kind === 'CLINIC' ? '診所帳號' : '另一位醫生'}「${name}」`
  }
  return null
}
