const METHOD_MAP: Record<string, string> = {
  'CASH': 'CASH',
  'HCV': 'HCV',
  'FPS': 'FPS',
  'CREDIT': 'CREDIT',
  'VISA': 'VISA',
  'MASTER': 'MASTERCARD',
  'AE': 'AMEX',
  'ALIPAY HK': 'ALIPAY',
  'UNION PAY': 'UNIONPAY',
  'OCTOPUS': 'OCTOPUS',
  'WECHAT PAY': 'WECHAT',
  'PAYME': 'PAYME',
  'CCF': 'CCF',
  'FREE SP': 'FREE_SP',
  'CHEQUE': 'CHEQUE', // ★ 2026-10-01：青衣有 cheque（之前唔喺表 → 永遠 UNKNOWN，規則配唔到）
}

/**
 * ★ cwm-apricotty-20261001：中文／變體名（青衣 TY 帳號嘅付款方式用中文名 + 數字 code）。
 * key = 大楷、去晒空白。只收【語義肯定】嘅名 —— 例如「信用卡」唔收（CREDIT 喺本系統係預繳／餘額，
 * 唔係信用卡；信用卡要分 VISA／MASTERCARD）。認唔到 → UNKNOWN（needsReview），唔好估。
 */
const ALIAS_MAP: Record<string, string> = {
  '現金': 'CASH', '现金': 'CASH',
  '醫療券': 'HCV', '医疗券': 'HCV', '長者醫療券': 'HCV', '长者医疗券': 'HCV', '醫療劵': 'HCV', '長者醫療劵': 'HCV',
  '轉數快': 'FPS', '转数快': 'FPS',
  'MASTERCARD': 'MASTERCARD', '萬事達': 'MASTERCARD', '万事达': 'MASTERCARD', '萬事達卡': 'MASTERCARD',
  'AMEX': 'AMEX', 'AMERICANEXPRESS': 'AMEX', '美國運通': 'AMEX', '美国运通': 'AMEX',
  'ALIPAY': 'ALIPAY', 'ALIPAYHK': 'ALIPAY', '支付寶': 'ALIPAY', '支付宝': 'ALIPAY', '支付寶HK': 'ALIPAY', '支付寶香港': 'ALIPAY', '支付宝香港': 'ALIPAY',
  'UNIONPAY': 'UNIONPAY', '銀聯': 'UNIONPAY', '银联': 'UNIONPAY', '銀聯卡': 'UNIONPAY',
  '八達通': 'OCTOPUS', '八达通': 'OCTOPUS',
  'WECHAT': 'WECHAT', 'WECHATPAY': 'WECHAT', '微信': 'WECHAT', '微信支付': 'WECHAT', '微信支付HK': 'WECHAT',
  '支票': 'CHEQUE', 'CHECK': 'CHEQUE',
}

export function normalizeMethod(raw: string): string {
  const key = (raw ?? '').trim().toUpperCase()
  return METHOD_MAP[key] ?? ALIAS_MAP[key.replace(/\s+/g, '')] ?? 'UNKNOWN'
}

/**
 * ★ cwm-apricotty-20261001：Apricot paymentMethods 一項 → { methodRaw, methodNorm }（三個 sync 入口共用）。
 * 原帳號 code／des 都係英文名（CASH／VISA…）；青衣帳號 code 係數字（001／002／010），中文名喺 des。
 * prefer = 舊有優先次序（upsertPayment 用 code 先；分配用 des 先）—— 舊次序認到嘅照舊（零行為改變），
 * 認唔到先試另一個欄。methodRaw 顯示用：認到嗰個欄；都認唔到 → 有 des 用 des（人睇得明），否則 code。
 */
export function apricotMethod(
  m: { code?: string | null; des?: string | null },
  prefer: 'code' | 'des' = 'code',
): { methodRaw: string; methodNorm: string } {
  const code = (m?.code ?? '').trim()
  const des = (m?.des ?? '').trim()
  const order = prefer === 'code' ? [code, des] : [des, code]
  for (const v of order) {
    if (!v) continue
    const norm = normalizeMethod(v)
    if (norm !== 'UNKNOWN') return { methodRaw: v, methodNorm: norm }
  }
  return { methodRaw: des || code, methodNorm: 'UNKNOWN' }
}

/**
 * ★ 2026-10-01：對照表認唔到嘅方式 → 睇吓「付款方式規則」有冇同名（唔理大細楷／空白）嘅規則；
 * 有 = 用該規則嘅 method 做 key（老闆喺規則頁加咗就即刻生效，唔使等改 code）；冇 = null（照舊 UNKNOWN）。
 * 同名多條（例如 cheque／CHEQUE）→ 揀字母序第一個（決定性）。
 */
export function ruleKeyForRaw(raw: string | null | undefined, rules: Array<{ method: string }>): string | null {
  const k = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ')
  const key = raw ? k(raw) : ''
  if (!key) return null
  const hits = [...new Set(rules.map(r => r.method).filter(m => k(m) === key))].sort()
  return hits[0] ?? null
}
