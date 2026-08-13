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
}

export function normalizeMethod(raw: string): string {
  return METHOD_MAP[raw.trim().toUpperCase()] ?? 'UNKNOWN'
}
