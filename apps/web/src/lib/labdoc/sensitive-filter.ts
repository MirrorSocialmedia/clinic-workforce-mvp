/**
 * cwm-labdoc P2 — §5.6 敏感數字過濾（取代 QA 報告 §5.4 嘅「≥8 位＋dash」規則）
 *
 * 🔴 零原文：本模組永不 log 欄位值。命中時只做
 *   console.warn('[labdoc] sensitive removed', { docId, field })（spec §5.6 指定嘅 metadata log）。
 *
 * 只檢查以下欄位（spec 白名單）：
 *   lab.*、billTo.*、description、readIssues、patientNameRaw、patientRaw、clinicRaw、doctorRaw
 * **唔檢查**：docNoRaw、labCaseRef、patientCodeRaw、customerNoRaw（F-03 —
 *   單號／Lab 編號／病人編號／客戶編號本身就係數字串，唔准誤殺）。
 *
 * 命中任何規則 → **整欄設 null**（唔係局部刪節）＋ readIssues 加 SENSITIVE_REMOVED:<欄名>
 * ＋ metadata warn。readIssues 欄命中 → 該元素移除（「設 null」喺陣列上 = 移除元素）。
 *
 * 規則（spec §5.6）：
 *  - 港式銀行帳號：\b\d{3}-\d{6}-\d{3}\b ／ \b\d{3}-\d{3}-\d{6}\b
 *    ／ \b0\d{2}-\d{3}\b.*\d{9}（Bank & Branch＋帳號）
 *    ／ \b\d{9,12}\b 而且同欄出現 account|a/c|戶口|帳號
 *  - Swift：\b[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?\b 而且同欄有 swift
 *  - MICR：⑈|⑆|⑇ 或 \b\d{6}\s+\d{3}\s+\d{3}\s+\d{6}\s+\d{3}\b
 *    ＋ OCR 掩碼變體（digit 或 x 嘅 6-3-3-6-3 分組）— 純數字版嘅超集，
 *    覆蓋支票 MICR 圈零被 OCR 讀成 x 嘅形態（spec §15.2 測試字串
 *    「3118xx 004 691 524xxx xxx」要能命中）。
 *  - FPS：同欄有 FPS 而且有 \d{7,9}
 *
 * 單測字串（spec §15.2，sensitive-filter.test.ts 鎖定）：
 *   必刪：040-543613-838、809-644065-838、000661528（同欄有帳號关键字）、
 *         016-478（同欄有 9 位帳號）、3118xx 004 691 524xxx xxx
 *   必留：INV-260805010、IN-MDL2001313043、202609-0811、0172649、DT9003874
 */
import type { LabDocResult } from './schema'

const RE_BANK_363 = /\b\d{3}-\d{6}-\d{3}\b/
const RE_BANK_336 = /\b\d{3}-\d{3}-\d{6}\b/
const RE_BANK_BRANCH_ACCT = /\b0\d{2}-\d{3}\b.*\d{9}/
const RE_ACCT_RUN = /\b\d{9,12}\b/
const RE_ACCT_KW = /account|a\/c|戶口|帳號/i
const RE_SWIFT_CODE = /\b[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?\b/
const RE_SWIFT_KW = /swift/i
const RE_MICR_CIRCLED = /[⑈⑆⑇]/
/** 6-3-3-6-3 分組，digit 或 x（OCR 把圈零讀成 x）。純數字 MICR 亦係佢嘅子集。 */
const RE_MICR_GROUPS = /\b[0-9xX]{6}\s+[0-9xX]{3}\s+[0-9xX]{3}\s+[0-9xX]{6}\s+[0-9xX]{3}\b/
const RE_FPS_KW = /fps/i
const RE_FPS_DIGITS = /\d{7,9}/

/** 單一欄位值有冇命中敏感數字規則（純函數，單測直用）。 */
export function isSensitiveNumber(s: string): boolean {
  if (RE_BANK_363.test(s)) return true
  if (RE_BANK_336.test(s)) return true
  if (RE_BANK_BRANCH_ACCT.test(s)) return true
  if (RE_ACCT_RUN.test(s) && RE_ACCT_KW.test(s)) return true
  if (RE_SWIFT_CODE.test(s) && RE_SWIFT_KW.test(s)) return true
  if (RE_MICR_CIRCLED.test(s)) return true
  if (RE_MICR_GROUPS.test(s)) return true
  if (RE_FPS_KW.test(s) && RE_FPS_DIGITS.test(s)) return true
  return false
}

export interface SensitiveFilterOutcome {
  /** 過濾後嘅結果（新物件；原物件唔會畀改） */
  result: LabDocResult
  /** 被設 null 嘅欄路徑（例 'lab.nameRaw'、'groups[0].lines[2].description'）— 讀單runner 會轉做 SENSITIVE_REMOVED:<欄名> readIssue */
  removedFields: string[]
}

/**
 * §5.6 過濾。input 必須已過 zod（欄位形狀保證）；回深克隆＋命中欄 null 化。
 * 🔴 opts.docId 只入 metadata log；任何欄位值唔准出現喺 log。
 */
export function filterSensitiveNumbers(input: LabDocResult, opts: { docId: string }): SensitiveFilterOutcome {
  const out: LabDocResult = structuredClone(input)
  const removed: string[] = []

  const remove = (field: string, get: () => string | null, set: (v: string | null) => void): void => {
    const v = get()
    if (v !== null && typeof v === 'string' && isSensitiveNumber(v)) {
      set(null)
      removed.push(field)
      console.warn('[labdoc] sensitive removed', { docId: opts.docId, field })
    }
  }

  // lab.*（三欄全查）
  remove('lab.nameRaw', () => out.lab.nameRaw, (v) => void (out.lab.nameRaw = v))
  remove('lab.nameCnRaw', () => out.lab.nameCnRaw, (v) => void (out.lab.nameCnRaw = v))
  remove('lab.payeeRaw', () => out.lab.payeeRaw, (v) => void (out.lab.payeeRaw = v))

  // billTo.*（customerNoRaw 除外 — F-03 明列唔查）
  remove('billTo.nameRaw', () => out.billTo.nameRaw, (v) => void (out.billTo.nameRaw = v))
  remove('billTo.addressRaw', () => out.billTo.addressRaw, (v) => void (out.billTo.addressRaw = v))
  // billTo.customerNoRaw：F-03 — 客戶編號唔准當敏感數字刪（Modern 客戶編號跟醫生，純數字）
  remove('billTo.shortCodeRaw', () => out.billTo.shortCodeRaw, (v) => void (out.billTo.shortCodeRaw = v))
  remove('billTo.doctorRaw', () => out.billTo.doctorRaw, (v) => void (out.billTo.doctorRaw = v))

  // INVOICE 分組：patientNameRaw ＋ 每行 description（patientCodeRaw／labCaseRef 唔查 — F-03）
  out.groups.forEach((g, gi) => {
    remove(`groups[${gi}].patientNameRaw`, () => g.patientNameRaw, (v) => void (g.patientNameRaw = v))
    g.lines.forEach((l, li) => {
      // spec §5.6：命中 → 整欄設 null（INVOICE line.description 類型上必填 — 運行時准 null；DB 行由 runner 寫 '[removed]' sentinel）
      remove(`groups[${gi}].lines[${li}].description`, () => l.description, (v) => void (l.description = v as unknown as string))
    })
  })

  // STATEMENT 分段：clinicRaw／doctorRaw ＋ 每行 description／patientRaw
  out.sections.forEach((s, si) => {
    remove(`sections[${si}].clinicRaw`, () => s.clinicRaw, (v) => void (s.clinicRaw = v))
    remove(`sections[${si}].doctorRaw`, () => s.doctorRaw, (v) => void (s.doctorRaw = v))
    s.lines.forEach((l, li) => {
      remove(`sections[${si}].lines[${li}].description`, () => l.description, (v) => void (l.description = v))
      remove(`sections[${si}].lines[${li}].patientRaw`, () => l.patientRaw, (v) => void (l.patientRaw = v))
    })
  })

  // readIssues：LLM 自己寫入嘅 string 亦可能抄到帳號 → 命中元素移除
  out.readIssues = out.readIssues.filter((s, i) => {
    if (typeof s === 'string' && isSensitiveNumber(s)) {
      removed.push(`readIssues[${i}]`)
      console.warn('[labdoc] sensitive removed', { docId: opts.docId, field: `readIssues[${i}]` })
      return false
    }
    return true
  })

  return { result: out, removedFields: removed }
}
