/**
 * cwm-labdoc P2 — §5.4 輸出 JSON 契約（zod 端，CWM 讀單驗證用）。
 *
 * ★ 契約檔：結構必須同 `test/fixtures/labdoc/schema.v1.json`（兩 repo 共用契約文字；
 *   W repo 同名檔 byte-identical）一致。改契約要兩邊同步 + 更新 fixture（同一個 PR）。
 *   本檔同 W 側（wa-clinic-inbox src/lib/labdoc/schema.ts）語義一致：
 *   - 多餘欄位：丟棄（z.object 預設非 strict — parse 輸出即已丟棄）
 *   - 必填欄缺 / 格式錯 → bad_response（重試計一次）
 *   - INVOICE 嘅 sections = []；STATEMENT 嘅 groups = []（superRefine 強制）
 *   - 日期一律 YYYY-MM-DD、statementMonth YYYY-MM（regex 強制）
 *   讀單後系統檢查（§5.5）同敏感數字過濾（§5.6）係 CWM 側（validate-extract.ts / sensitive-filter.ts）。
 */
import { z } from 'zod'

const str = z.string().nullable()
const num = z.number().finite().nullable()
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').nullable()
const monthStr = z.string().regex(/^\d{4}-\d{2}$/, 'statementMonth must be YYYY-MM').nullable()

/** INVOICE：同一病人嘅行放同一個 group。 */
export const labDocInvoiceLine = z.object({
  description: z.string(),
  toothRaw: str,
  qty: num,
  unitPrice: num,
  listPrice: num,
  discountRaw: str,
  amount: z.number().finite(),
})

export const labDocPatientGroup = z.object({
  patientNameRaw: str,
  patientCodeRaw: str,
  labCaseRef: str,
  lines: z.array(labDocInvoiceLine),
})

/** STATEMENT 行（lineType 標 INVOICE/CREDIT/PAYMENT/CHARGE/BF）。 */
export const labDocStatementLine = z.object({
  lineType: z.enum(['INVOICE', 'CREDIT', 'PAYMENT', 'CHARGE', 'BF']),
  docNoRaw: str,
  date: dateStr,
  patientRaw: str,
  patientCodeRaw: str,
  labCaseRef: str,
  description: str,
  toothRaw: str,
  qty: num,
  unitPrice: num,
  amount: z.number().finite(),
  agingBucket: str,
})

export const labDocSection = z.object({
  clinicRaw: str,
  doctorRaw: str,
  customerNoRaw: str,
  addressRaw: str,
  pageFrom: num,
  pageTo: num,
  total: num,
  currentTotal: num,
  lines: z.array(labDocStatementLine),
})

export const labDocResultSchema = z
  .object({
    kind: z.enum(['INVOICE', 'STATEMENT']),
    lab: z.object({
      nameRaw: str,
      nameCnRaw: str,
      payeeRaw: str,
    }),
    billTo: z.object({
      nameRaw: str,
      addressRaw: str,
      customerNoRaw: str,
      shortCodeRaw: str,
      doctorRaw: str,
    }),
    docNoRaw: str,
    docNoLabel: str,
    dateRaw: str,
    date: dateStr,
    deliveryDate: dateStr,
    orderReceivedDate: dateStr,
    statementMonth: monthStr,
    groups: z.array(labDocPatientGroup),
    sections: z.array(labDocSection),
    subtotal: num,
    total: num,
    readIssues: z.array(z.string()),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'INVOICE' && v.sections.length > 0) {
      ctx.addIssue({ code: 'custom', message: 'INVOICE: sections must be []', path: ['sections'] })
    }
    if (v.kind === 'STATEMENT' && v.groups.length > 0) {
      ctx.addIssue({ code: 'custom', message: 'STATEMENT: groups must be []', path: ['groups'] })
    }
  })

export type LabDocResult = z.infer<typeof labDocResultSchema>
