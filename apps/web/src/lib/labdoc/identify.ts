/**
 * cwm-labdoc P2 — §6 識別規則
 *
 * CHUNK 1（本檔現有）：§6.1 Lab（ALIAS／NAME）＋ §6.4 單號正規化＋INVOICE_NO 重複偵測
 *   ＋ payeeIsNew（§6.1.4，認到 Lab 後對 PAYEE alias）。
 * CHUNK 2 擴充（identifyDocument 入面補字段，runner 結構唔變）：
 *   §6.2 診所（CUSTOMER_NO／CLINIC_ALIAS／ADDRESS／SHORT_CODE／NAME／MANUAL）
 *   §6.3 醫生（CUSTOMER_NO／DOCTOR_ALIAS／NAME／MANUAL）
 *   §6.5 病人編號 patientCodeNorm（reuse lib/cost-entry/clinic-prefix.ts 嘅 prefix 對照）
 *
 * 所有識別都用「讀」操作；alias 學習（寫 LabAlias 等）發生喺 §7.1 確認時（CHUNK 3），唔喺讀單時。
 */
import type { LabDocResult } from './schema'

// ------------------------------------------------------------------
// 通用正規化
// ------------------------------------------------------------------

/** 全形 → 半形（FF01–FF5E 偏移 0xFEE0；全形空格 → 半形空格） */
export function toHalfWidth(s: string): string {
  return s
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFee0))
    .replace(/\u3000/g, ' ')
}

/**
 * §6.1 Lab 名正規化：細階 → 全形轉半形 → 去標點同空格（留 CJK＋英數）
 * → 去 limited|ltd|co|company|laboratory|lab|dental|solutions|有限公司|牙科器材|牙科。
 * 去 token 按「長 token 優先」repeat-until-stable（防 'co' 先食咗 'company' 開頭）。
 */
export function normLabName(s: string | null): string {
  if (!s) return ''
  let t = toHalfWidth(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
  const DROP = [
    '有限公司',
    '牙科器材',
    'laboratory',
    'solutions',
    'company',
    'dental',
    'limited',
    '牙科',
    'ltd',
    'lab',
    'co',
  ]
  let changed = true
  while (changed) {
    changed = false
    for (const d of DROP) {
      if (t.includes(d)) {
        t = t.split(d).join('')
        changed = true
      }
    }
  }
  return t
}

/**
 * §6.4 單號正規化：去空格、轉大階、全形轉半形。
 * **唔去前置 0**（0254131）；**唔將 O 轉 0**（Modern 0321231O 係 labCaseRef，唔係單號）。
 */
export function normDocNo(raw: string | null): string | null {
  if (!raw) return null
  const s = toHalfWidth(raw).toUpperCase().replace(/\s+/g, '')
  return s === '' ? null : s
}

// ------------------------------------------------------------------
// §6.1 Lab
// ------------------------------------------------------------------

export interface LabIdentifyResult {
  labId: string | null
  labBasis: 'ALIAS' | 'NAME' | null
  /** §6.1.4：認到 Lab 而 payeeRaw 唔喺該 Lab 嘅 PAYEE alias → true（頭部黃；唔擋） */
  payeeIsNew: boolean
}

/**
 * §6.1 識別 Lab（只讀；唔寫 alias — 寫入喺 §7.1 確認時）。
 * 1. LabAlias(NAME_EN, norm(nameRaw)) 或 (NAME_CN, norm(nameCnRaw)) 中 → ALIAS
 * 2. Lab.name 正規化後同 nameRaw／nameCnRaw 互相包含、較短邊 ≥ 4 字、只有一間中 → NAME
 * 3. 唔中 → null（員工確認時揀 — CHUNK 3）
 */
export async function identifyLab(
  prisma: any,
  result: LabDocResult,
): Promise<LabIdentifyResult> {
  const nameEn = result.lab.nameRaw
  const nameCn = result.lab.nameCnRaw

  // 1) alias
  const aliasCandidates: Array<{ kind: 'NAME_EN' | 'NAME_CN'; raw: string }> = []
  if (nameEn) aliasCandidates.push({ kind: 'NAME_EN', raw: nameEn })
  if (nameCn) aliasCandidates.push({ kind: 'NAME_CN', raw: nameCn })
  for (const c of aliasCandidates) {
    const n = normLabName(c.raw)
    if (!n) continue
    const alias = await prisma.labAlias.findFirst({ where: { kind: c.kind, rawNorm: n }, select: { labId: true } })
    if (alias) {
      return { labId: alias.labId, labBasis: 'ALIAS', payeeIsNew: await checkPayeeNew(prisma, alias.labId, result.lab.payeeRaw) }
    }
  }

  // 2) NAME：互相包含、較短邊 ≥ 4、只有一間
  const normRaw = normLabName(nameEn)
  const normRawCn = normLabName(nameCn)
  const labs = await prisma.lab.findMany({ where: { isActive: true }, select: { id: true, name: true } })
  const hits: string[] = []
  for (const lab of labs) {
    const nLab = normLabName(lab.name)
    if (!nLab || hits.length > 1) continue
    const match = (raw: string): boolean => {
      if (!raw) return false
      if (!(nLab.includes(raw) || raw.includes(nLab))) return false
      return Math.min(nLab.length, raw.length) >= 4
    }
    if (match(normRaw) || match(normRawCn)) hits.push(lab.id)
  }
  if (hits.length === 1) {
    return { labId: hits[0], labBasis: 'NAME', payeeIsNew: await checkPayeeNew(prisma, hits[0], result.lab.payeeRaw) }
  }
  return { labId: null, labBasis: null, payeeIsNew: false }
}

/** §6.1.4：norm(payeeRaw) 唔喺該 Lab 嘅 LabAlias(PAYEE) → true。payeeRaw 為空 = false（無得比）。 */
async function checkPayeeNew(prisma: any, labId: string, payeeRaw: string | null): Promise<boolean> {
  if (!payeeRaw) return false
  const n = normLabName(payeeRaw)
  if (!n) return false
  const alias = await prisma.labAlias.findFirst({ where: { labId, kind: 'PAYEE', rawNorm: n }, select: { id: true } })
  return alias === null
}

// ------------------------------------------------------------------
// §6.4 單號同重複（INVOICE_NO 硬擋部分；CASE_NO 軟提示喺 CHUNK 2/UI）
// ------------------------------------------------------------------

export interface DocNoIdentifyResult {
  docNo: string | null
  docNoKind: 'INVOICE_NO' | 'CASE_NO' | null
  /** INVOICE_NO 撞另一張活動單（partial unique index 範圍）→ 呢張轉 DUPLICATE */
  duplicateOfId: string | null
}

/**
 * §6.4：docNoKind = LabProfile.defaultDocNoKind；AI 嘅 docNoLabel 含 `case` → CASE_NO。
 * INVOICE_NO 撞 unique index → DUPLICATE（讀單時）。CASE_NO 只軟提示（唔設 duplicateOfId）。
 * labId 係 null（Others）→ 無硬擋（軟提示 = CHUNK 2 用 norm 後 labNameRaw 做 key）。
 */
export async function identifyDocNo(
  prisma: any,
  result: LabDocResult,
  opts: { selfDocId: string; labId: string | null; defaultDocNoKind?: string | null },
): Promise<DocNoIdentifyResult> {
  const docNo = normDocNo(result.docNoRaw)
  let docNoKind: 'INVOICE_NO' | 'CASE_NO' | null = null
  if (docNo) {
    docNoKind = /case/i.test(result.docNoLabel ?? '') ? 'CASE_NO' : (opts.defaultDocNoKind === 'CASE_NO' ? 'CASE_NO' : 'INVOICE_NO')
  }
  let duplicateOfId: string | null = null
  if (result.kind === 'INVOICE' && docNoKind === 'INVOICE_NO' && docNo && opts.labId) {
    const dup = await prisma.labDocument.findFirst({
      where: {
        labId: opts.labId,
        docNo,
        id: { not: opts.selfDocId },
        status: { notIn: ['VOID', 'DUPLICATE'] },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    duplicateOfId = dup?.id ?? null
  }
  return { docNo, docNoKind, duplicateOfId }
}

// ------------------------------------------------------------------
// 組合入口（runner §5.1 用；CHUNK 2 喺呢度加 clinic/provider/lines.patientCode）
// ------------------------------------------------------------------

export interface IdentifyOutcome {
  labId: string | null
  labBasis: 'ALIAS' | 'NAME' | null
  payeeIsNew: boolean
  docNo: string | null
  docNoKind: 'INVOICE_NO' | 'CASE_NO' | null
  duplicateOfId: string | null
}

export interface IdentifyDocumentOpts {
  selfDocId: string
  uploadLabId?: string | null
  /** LabProfile.defaultDocNoKind（INVOICE_NO | CASE_NO；Prisma 欄係 String — 非 'CASE_NO' 一律當 'INVOICE_NO'） */
  defaultDocNoKind?: string | null
}

/**
 * 讀單識別入口（§5.1 step 5 尾）。
 * decision log（2026-10-05 gen2，§0.4 型未指定情況保守處理）：
 * AI 識別到 Lab（ALIAS/NAME）→ 用 AI 結果；未識別 → 保留上傳時揀嘅 labId
 * （用戶明確預選，basis 留 null — 唔係 §6.1 正式 basis，確認時才可寫 alias）。
 */
export async function identifyDocument(
  prisma: any,
  result: LabDocResult,
  opts: IdentifyDocumentOpts,
): Promise<IdentifyOutcome> {
  const lab = await identifyLab(prisma, result)
  const labId = lab.labId ?? opts.uploadLabId ?? null
  const payeeIsNew = lab.labId ? lab.payeeIsNew : false
  const docNo = await identifyDocNo(prisma, result, {
    selfDocId: opts.selfDocId,
    labId,
    defaultDocNoKind: opts.defaultDocNoKind ?? null,
  })
  return {
    labId,
    // upload 預選唔係 §6.1 basis（ALIAS/NAME）— 確認時先定 basis
    labBasis: lab.labBasis,
    payeeIsNew,
    docNo: docNo.docNo,
    docNoKind: docNo.docNoKind,
    duplicateOfId: docNo.duplicateOfId,
  }
}
