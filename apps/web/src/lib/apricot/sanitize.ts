// PII 白名單 — 只抽取白名單欄位，唔係剷走黑名單

export function sanitizePayment(raw: any): any {
  return {
    id: raw.id,
    code: raw.code,
    paymentTime: raw.paymentTime,
    amt: raw.amt,
    isVoid: raw.isVoid,
    payerType: raw.payerType,
    paymentMethods: (raw.paymentMethods || []).map((m: any) => ({
      code: m.paymentMethod?.code,
      des: m.paymentMethod?.des,
      amt: m.amt,
      payType: m.payType,
      collectAmt: m.collectAmt,
      walletAmt: m.walletAmt,
    })),
    refList: (raw.refList || []).map((r: any) => ({
      billId: r.billId,
      billCode: r.billCode,
      amt: r.amt,
    })),
  }
}

export function sanitizeBill(raw: any): any {
  return {
    id: raw.id,
    code: raw.code,
    billTime: raw.billTime,
    amt: raw.amt,
    ttlAmt: raw.ttlAmt,
    paidAmt: raw.paidAmt,
    osAmt: raw.osAmt,
    isVoid: raw.isVoid,
    isRefunded: raw.isRefunded,
    refundRefId: raw.refundRefId,
    itemDiscAmt: raw.itemDiscAmt,
    itemDiscPer: raw.itemDiscPer,
    practitioner: raw.practitioner ? { id: raw.practitioner.id } : null,
    clinic: raw.clinic ? { id: raw.clinic.id } : null,
    billDetails: (raw.billDetails || []).map((d: any) => ({
      eleId: d.eleId,
      itemType: d.itemType,
      feeItem: d.feeItem ? { id: d.feeItem.id, code: d.feeItem.code, des: d.feeItem.des } : null,
      qty: d.qty,
      up: d.up,
      uc: d.uc,
      discPer: d.discPer,
      discAmt: d.discAmt,
      ttlDisc: d.ttlDisc,
      amt: d.amt,
      ttlAmt: d.ttlAmt,
      reconPaymentDetails: (d.reconPaymentDetails || []).map((r: any) => ({
        des: r.paymentMethod?.des,
        amt: r.amt,
      })),
    })),
  }
}

// ★ MD-F: Clean patient list (PII whitelist: extId, code, fullName only)
export type CleanPatient = { extId: string; code: string; fullName: string }

export function toCleanPatients(raw: any): CleanPatient[] {
  const arr = Array.isArray(raw) ? raw : []
  return arr.slice(0, 20).map((p: any) => ({
    extId: String(p.id ?? ''),
    code: String(p.code ?? ''),
    fullName: String(p.fullName ?? p.chiFullName ?? ''),
  })).filter(p => p.extId && p.code)
}

// PII leak 測試 — 每次 sync 後跑
// 通用（payments / bills）— fullName 亦算 PII
const PII_KEYS_STRICT = [
  'clinicPatient', 'personalIdentifier', 'medicalHistory',
  'drugHistory', 'phoneNum', 'phoneList', 'dateOfBirth', 'diagnosis',
  'address', 'email', 'fullName', 'emergencyContact', 'bloodType', 'occupation',
]

// 病人搜尋 — fullName 刻意保留（income report 要用）
const PII_KEYS_PATIENT = PII_KEYS_STRICT.filter(k => k !== 'fullName')

export function assertNoPii(obj: any): void {
  const json = JSON.stringify(obj)
  for (const leak of PII_KEYS_STRICT) {
    if (json.includes(leak)) throw new Error(`PII 洩漏：${leak}`)
  }
}

// ★ MD-F: Patient-search 專用 — 容許 fullName
export function assertNoPiiPatient(obj: any): void {
  const json = JSON.stringify(obj)
  for (const leak of PII_KEYS_PATIENT) {
    if (json.includes(leak)) throw new Error(`PII 洩漏：${leak}`)
  }
}
