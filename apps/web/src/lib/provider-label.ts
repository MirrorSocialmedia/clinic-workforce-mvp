// ============================================================
// ★ cwm-chequerec-20261005：醫生顯示名 —— 簡稱（Provider.name，例「Dr.Ho」）＋中文全名（nameZh）
//   同姓醫生（Dr.Ho／Dr.Ho Pak Hei）淨睇簡稱分唔到，所以支票、支票紀錄一律用「Dr.Ho · 何嘉俊」。
//   ⚠️ Provider.shortName 係更表膠囊用嘅單字（例「陳」），唔係呢度講嘅簡稱。
//   中文全名唔必填（老闆拍板）—— 冇就淨顯示簡稱，UI 另外出「未填中文名」提示。
// ============================================================

export interface ProviderNameParts {
  name: string
  nameZh?: string | null
}

/** 「Dr.Ho · 何嘉俊」；未填中文全名 → 「Dr.Ho」 */
export function providerLabel(p: ProviderNameParts): string {
  const name = (p.name ?? '').trim()
  const zh = (p.nameZh ?? '').trim()
  if (!zh) return name
  if (!name) return zh
  return `${name} · ${zh}`
}

/** 未填中文全名 */
export function missingNameZh(p: ProviderNameParts): boolean {
  return !(p.nameZh ?? '').trim()
}

/** 簡稱正規化：細階、去空白同「.」（「Dr. Ho」＝「dr.ho」＝「DR HO」） */
export function normProviderName(name: string): string {
  return (name ?? '').toLowerCase().replace(/[\s.]+/g, '')
}

/**
 * 同簡稱（正規化後相同）嘅醫生 id —— 醫生管理頁出「同名」警告用。
 * 回傳 Set<id>：喺入面 = 有另一個醫生同佢簡稱一樣。
 */
export function duplicateNameIds(list: Array<{ id: string; name: string }>): Set<string> {
  const byKey = new Map<string, string[]>()
  for (const p of list) {
    const k = normProviderName(p.name)
    if (!k) continue
    byKey.set(k, [...(byKey.get(k) ?? []), p.id])
  }
  const out = new Set<string>()
  for (const ids of byKey.values()) if (ids.length > 1) ids.forEach(id => out.add(id))
  return out
}
