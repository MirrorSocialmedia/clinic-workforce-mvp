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
 * §6.1 Lab 名正規化：細階 → 全形轉半形 → 去公司尾詞（英文用 word boundary，防 'Sodental' 俾 'dental' 食）
 * → 去標點同空格（留 CJK＋英數）。
 * CJK 詞：有限公司／牙科器材／牙科（無 word boundary，按字串）。
 */
export function normLabName(s: string | null): string {
  if (!s) return ''
  let t = toHalfWidth(s).toLowerCase()
  t = t.replace(/有限公司/g, '').replace(/牙科器材/g, '').replace(/牙科/g, '')
  for (const d of ['laboratory', 'solutions', 'company', 'limited', 'dental', 'ltd', 'lab', 'co']) {
    t = t.replace(new RegExp(`\\b${d}\\b`, 'g'), '')
  }
  return t.replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
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

/**
 * §6.2 診所名正規化（ClinicNameAlias.rawNorm 同 NAME 比較共用 — 學習側 CHUNK 3 必須用同一個）。
 * 細階＋全形轉半形＋去標點同空格（留 CJK＋英數）。
 */
export function normClinicName(s: string | null): string {
  if (!s) return ''
  return toHalfWidth(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
}

/**
 * §6.3 醫生名正規化：細階、去 dr｜dr.｜doctor｜醫生、去標點同空格。
 * （long-first repeat-until-stable，防 'dr' 先食咗 'dr.' 開頭。）
 */
export function normDoctor(s: string | null): string {
  if (!s) return ''
  let t = toHalfWidth(s).toLowerCase()
  let changed = true
  while (changed) {
    changed = false
    for (const d of ['doctor', 'dr.', 'dr', '醫生']) {
      if (t.includes(d)) {
        t = t.split(d).join('')
        changed = true
      }
    }
  }
  return t.replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
}

/** 客戶編號正規化：全形轉半形＋去空格＋大階（EC-101 / ec 101 → EC-101）。 */
export function normCustomerNo(s: string | null): string {
  if (!s) return ''
  const t = toHalfWidth(s).replace(/\s+/g, '').toUpperCase()
  return t
}

/** 地址正規化（§6.2 ADDRESS 比較用）：小階＋全形轉半形＋去標點空格（留 CJK＋英數）。 */
function normAddress(s: string | null): string {
  if (!s) return ''
  return toHalfWidth(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
}

/**
 * §6.2.3：由地址抽「街道名＋門牌號」。
 * 中：`(.+?[路道街])(\d+)號`；英：`(\d+)\s+([A-Za-z ]+(Road|Street|Avenue))`。
 * 回 { street, num }（都已 norm）— 比較時街道 substring ＋ 門牌號獨立 token（防 418 食咗 18）。
 */
function extractStreetNo(addressRaw: string | null): { street: string; num: string } | null {
  if (!addressRaw) return null
  const s = toHalfWidth(addressRaw).trim()
  const zh = s.match(/([^\d]+?[路道街])(\d+)號/)
  if (zh) return { street: normAddress(zh[1]), num: zh[2] }
  const en = s.match(/(\d+)\s+([A-Za-z ]+(?:Road|Street|Avenue))/i)
  if (en) return { street: normAddress(en[2]), num: en[1] }
  return null
}

/** 門牌號作獨立 token 出現（前後唔係數字）— 防 shop 418 食咗 18。 */
function hasNumToken(normAddr: string, num: string): boolean {
  return new RegExp(`(^|[^0-9])${num}([^0-9]|$)`).test(normAddr)
}

/**
 * §6.2.5：由 Clinic.name 抽地區名（末尾 （...）／(...) 分組；例「臻善牙科（大圍）」→「大圍」）。
 * 「滙樂牙科（AEGIS DENTAL)（土瓜湾）」→ 取最後一個分組「土瓜湾」。
 */
export function clinicDistrict(name: string): string | null {
  const m = name.match(/[（(]([^（）()]+)[）)]\s*$/)
  if (!m) return null
  const d = m[1].trim()
  return d.length >= 2 ? d : null
}

/** 地區名比較正規化：湾→灣（簡繁）＋小階＋去標點空格。 */
function normDistrict(s: string): string {
  return toHalfWidth(s).replace(/湾/g, '灣').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
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
// §6.2 診所（依次，搵到就停；**唔准**用上傳者主屬店）
// ------------------------------------------------------------------

export type ClinicBasis = 'CUSTOMER_NO' | 'CLINIC_ALIAS' | 'ADDRESS' | 'SHORT_CODE' | 'NAME' | 'MANUAL'

export interface ClinicIdentifyResult {
  clinicId: string | null
  clinicBasis: ClinicBasis
  /** 命中原文片段（寫 clinicEvidence，≤120 字） */
  evidence: string | null
  /** §6.2.1：CUSTOMER_NO 命中同時帶出 providerId（如有） */
  providerIdFromCustomerNo: string | null
}

/** STATEMENT：section 層嘅 clinic 資料（§6.2 用「billTo 或 section.clinicRaw」）。 */
interface ClinicSources {
  customerNoRaw: string | null
  nameCandidates: string[]
  addressRaw: string | null
  shortCodeRaw: string | null
}

function clinicSources(result: LabDocResult): ClinicSources {
  const b = result.billTo
  const first = result.sections[0]
  const names = [b.nameRaw, ...result.sections.map((s) => s.clinicRaw)].filter(
    (s): s is string => typeof s === 'string' && s.trim() !== '',
  )
  return {
    customerNoRaw: b.customerNoRaw ?? first?.customerNoRaw ?? null,
    nameCandidates: [...new Set(names)],
    addressRaw: b.addressRaw ?? first?.addressRaw ?? null,
    shortCodeRaw: b.shortCodeRaw ?? null,
  }
}

/**
 * §6.2 識別診所（只讀；alias 學習喺 §7.1 確認時 — CHUNK 3）。
 * 順序：CUSTOMER_NO → CLINIC_ALIAS → ADDRESS → SHORT_CODE → NAME（地區名）→ MANUAL。
 * 「只有一間中先揀」= ADDRESS/SHORT_CODE/NAME 多間中 → 落回下一步／MANUAL。
 * ★ P3：核心收埋做 identifyClinicFromSources（月結單 section 級識別重用 — §8.1）。
 */
export async function identifyClinic(
  prisma: any,
  result: LabDocResult,
  opts: { labId: string | null },
): Promise<ClinicIdentifyResult> {
  return identifyClinicFromSources(prisma, opts.labId, clinicSources(result))
}

/** §6.2 核心：explicit sources（document 級 clinicSources／P3 section 級 sectionSources 共用）。 */
export async function identifyClinicFromSources(
  prisma: any,
  labId: string | null,
  src: ClinicSources,
): Promise<ClinicIdentifyResult> {
  const manual: ClinicIdentifyResult = { clinicId: null, clinicBasis: 'MANUAL', evidence: null, providerIdFromCustomerNo: null }

  // 1) CUSTOMER_NO（需要 labId — 冇 lab 冇得比 LabCustomerNo）
  if (src.customerNoRaw && labId) {
    const c = await prisma.labCustomerNo.findFirst({
      where: { labId, customerNo: normCustomerNo(src.customerNoRaw) },
      select: { clinicId: true, providerId: true },
    })
    if (c) {
      return {
        clinicId: c.clinicId,
        clinicBasis: 'CUSTOMER_NO',
        evidence: src.customerNoRaw.slice(0, 120),
        providerIdFromCustomerNo: c.providerId ?? null,
      }
    }
  }

  // 2) CLINIC_ALIAS（rawNorm 全庫 unique）
  for (const raw of src.nameCandidates) {
    const alias = await prisma.clinicNameAlias.findFirst({
      where: { rawNorm: normClinicName(raw) },
      select: { clinicId: true },
    })
    if (alias) {
      return { clinicId: alias.clinicId, clinicBasis: 'CLINIC_ALIAS', evidence: raw.slice(0, 120), providerIdFromCustomerNo: null }
    }
  }

  // 本地比較用嘅 clinics（3/4/5 共用一次 query）
  const clinics: Array<{ id: string; name: string; shortName: string | null; address: string | null; addressEn: string | null }> =
    await prisma.clinic.findMany({ select: { id: true, name: true, shortName: true, address: true, addressEn: true } })

  // 3) ADDRESS（街道 substring ＋ 門牌號 token；只有一間中）
  if (src.addressRaw) {
    const sn = extractStreetNo(src.addressRaw)
    if (sn && sn.street) {
      const hits = clinics.filter((c) => {
        const na = normAddress(c.address)
        const ne = normAddress(c.addressEn)
        const inA = na.includes(sn.street) && hasNumToken(na, sn.num)
        const inE = ne.includes(sn.street) && hasNumToken(ne, sn.num)
        return inA || inE
      })
      if (hits.length === 1) {
        return { clinicId: hits[0].id, clinicBasis: 'ADDRESS', evidence: src.addressRaw.slice(0, 120), providerIdFromCustomerNo: null }
      }
    }
  }

  // 4) SHORT_CODE（大階完全一樣；只有一間）
  if (src.shortCodeRaw) {
    const code = src.shortCodeRaw.trim().toUpperCase()
    const hits = clinics.filter((c) => c.shortName && c.shortName.toUpperCase() === code)
    if (hits.length === 1) {
      return { clinicId: hits[0].id, clinicBasis: 'SHORT_CODE', evidence: src.shortCodeRaw.slice(0, 120), providerIdFromCustomerNo: null }
    }
  }

  // 5) NAME（clinic 名嘅地區名喺 raw 入面；簡繁 湾→灣；只有一間中）
  const rawNorms = src.nameCandidates.map((r) => normDistrict(r)).filter(Boolean)
  if (rawNorms.length > 0) {
    const hitClinics = new Map<string, string>() // clinicId → 命中嘅 raw（evidence）
    for (const raw of src.nameCandidates) {
      const rn = normDistrict(raw)
      if (!rn) continue
      for (const c of clinics) {
        if (hitClinics.has(c.id)) continue
        const district = clinicDistrict(c.name)
        if (!district) continue
        const nd = normDistrict(district)
        if (nd && rn.includes(nd)) hitClinics.set(c.id, raw)
      }
    }
    if (hitClinics.size === 1) {
      const [clinicId, raw] = [...hitClinics.entries()][0]
      return { clinicId, clinicBasis: 'NAME', evidence: raw.slice(0, 120), providerIdFromCustomerNo: null }
    }
  }

  // 6) MANUAL
  return manual
}

// ------------------------------------------------------------------
// §6.3 醫生（B2）
// ------------------------------------------------------------------

export type ProviderBasis = 'CUSTOMER_NO' | 'DOCTOR_ALIAS' | 'NAME' | 'MANUAL'

export interface ProviderIdentifyResult {
  providerId: string | null
  providerBasis: ProviderBasis
  evidence: string | null
}

/**
 * provider 英文名嘅字（去 honorific dr｜dr.｜doctor；唔去空格 — 先抽字先核）。
 * 例「Dr.Ho Ka Chun 何嘉俊醫生」→ ['ho','ka','chun']（Dr 唔算名）。
 */
function providerEnglishWords(pName: string): string[] {
  let t = toHalfWidth(pName).toLowerCase()
  for (const d of ['doctor', 'dr.', 'dr']) {
    t = t.split(d).join('')
  }
  return t.match(/[a-z]+/g) ?? []
}

/** §6.3.3：doctorRaw 包含 provider 英文名全部字（要 ≥2 字；例「Ho Ka Chun」⊂「Dr.Ho Ka Chun 何嘉俊醫生」）。 */
function providerWordsContained(pName: string, normRaw: string): boolean {
  const words = providerEnglishWords(pName).filter((w) => w.length >= 2)
  return words.length >= 2 && words.every((w) => normRaw.includes(w))
}

/**
 * §6.3 識別醫生（只讀；ProviderNameAlias 學習喺確認時 — CHUNK 3）。
 * 順序：CUSTOMER_NO（§6.2.1 帶出）→ DOCTOR_ALIAS → NAME（相等／英文名全字包含；只有一個 active provider 中）→ MANUAL。
 * INVOICE 冇醫生名 → MANUAL（確認時必填 — CHUNK 3）。
 * ★ P3：核心收埋做 identifyProviderFromSources（月結單 section 級識別重用 — §8.1）。
 */
export async function identifyProvider(
  prisma: any,
  result: LabDocResult,
  opts: { customerNoProviderId: string | null; customerNoRaw: string | null },
): Promise<ProviderIdentifyResult> {
  const doctorRaw = result.billTo.doctorRaw ?? result.sections[0]?.doctorRaw ?? null
  return identifyProviderFromSources(prisma, {
    doctorRaw,
    customerNoProviderId: opts.customerNoProviderId,
    customerNoRaw: opts.customerNoRaw,
  })
}

/** §6.3 核心：explicit doctorRaw（document 級／P3 section 級共用）。 */
export async function identifyProviderFromSources(
  prisma: any,
  sources: { doctorRaw: string | null; customerNoProviderId: string | null; customerNoRaw: string | null },
): Promise<ProviderIdentifyResult> {
  const doctorRaw = sources.doctorRaw
  const manual: ProviderIdentifyResult = { providerId: null, providerBasis: 'MANUAL', evidence: doctorRaw ? doctorRaw.slice(0, 120) : null }

  // 1) CUSTOMER_NO（§6.2.1 帶出嘅 providerId）
  if (sources.customerNoProviderId) {
    return { providerId: sources.customerNoProviderId, providerBasis: 'CUSTOMER_NO', evidence: (doctorRaw ?? sources.customerNoRaw ?? '').slice(0, 120) }
  }
  if (!doctorRaw) return manual

  // 2) DOCTOR_ALIAS
  const alias = await prisma.providerNameAlias.findFirst({
    where: { rawNorm: normDoctor(doctorRaw) },
    select: { providerId: true },
  })
  if (alias) {
    return { providerId: alias.providerId, providerBasis: 'DOCTOR_ALIAS', evidence: doctorRaw.slice(0, 120) }
  }

  // 3) NAME：norm 後相等（name／shortName）或者英文名全部字包含；只有一個中
  const providers: Array<{ id: string; name: string; shortName: string | null }> = await prisma.provider.findMany({
    where: { isActive: true },
    select: { id: true, name: true, shortName: true },
  })
  const normRaw = normDoctor(doctorRaw)
  const hits = providers.filter((p) => {
    if (!normRaw) return false
    const nName = normDoctor(p.name)
    const nShort = p.shortName ? normDoctor(p.shortName) : ''
    if (nName && normRaw === nName) return true
    if (nShort && normRaw === nShort) return true
    return providerWordsContained(p.name, normRaw)
  })
  if (hits.length === 1) {
    return { providerId: hits[0].id, providerBasis: 'NAME', evidence: doctorRaw.slice(0, 120) }
  }
  return manual
}

// ------------------------------------------------------------------
// ★ P3 §8.1：月結單 section 級識別（診所＋醫生；§6.2/§6.3 同一規則逐段跑）
// ------------------------------------------------------------------

/** section 級 clinic sources（§6.2：「billTo.nameRaw 或 section.clinicRaw」；customerNo 逐段優先）。 */
export function sectionSources(
  result: LabDocResult,
  section: { clinicRaw: string | null; customerNoRaw: string | null; addressRaw: string | null },
): ClinicSources {
  const b = result.billTo
  const names = [section.clinicRaw, b.nameRaw].filter((s): s is string => typeof s === 'string' && s.trim() !== '')
  return {
    customerNoRaw: section.customerNoRaw ?? b.customerNoRaw ?? null,
    nameCandidates: [...new Set(names)],
    addressRaw: section.addressRaw ?? b.addressRaw ?? null,
    shortCodeRaw: b.shortCodeRaw ?? null,
  }
}

export interface SectionIdentifyResult {
  clinicId: string | null
  clinicBasis: ClinicBasis
  clinicEvidence: string | null
  providerId: string | null
  providerBasis: ProviderBasis
  providerEvidence: string | null
  /** 兩邊都識別到 */
  complete: boolean
}

/**
 * §8.1：逐段識別診所＋醫生（只讀；alias 學習喺 assign 時 — POST /sections/:sid/assign）。
 * 任何一邊未識別 → 分段 NEEDS_ASSIGN（runner 落 section status）。
 */
export async function identifyStatementSection(
  prisma: any,
  result: LabDocResult,
  opts: { labId: string | null; section: { clinicRaw: string | null; doctorRaw: string | null; customerNoRaw: string | null; addressRaw: string | null } },
): Promise<SectionIdentifyResult> {
  const src = sectionSources(result, opts.section)
  const clinic = await identifyClinicFromSources(prisma, opts.labId, src)
  const provider = await identifyProviderFromSources(prisma, {
    doctorRaw: opts.section.doctorRaw,
    customerNoProviderId: clinic.providerIdFromCustomerNo,
    customerNoRaw: src.customerNoRaw,
  })
  return {
    clinicId: clinic.clinicId,
    clinicBasis: clinic.clinicBasis,
    clinicEvidence: clinic.evidence,
    providerId: provider.providerId,
    providerBasis: provider.providerBasis,
    providerEvidence: provider.evidence,
    complete: clinic.clinicId !== null && provider.providerId !== null,
  }
}

/** §8.1：statementMonth fallback — section 行最遲日期嘅月份（無日期行 → null）。回 'YYYY-MM'。 */
export function latestStatementLineMonth(
  result: LabDocResult,
): string | null {
  let latest: string | null = null
  for (const s of result.sections) {
    for (const l of s.lines) {
      if (!l.date) continue
      if (!latest || l.date > latest) latest = l.date
    }
  }
  return latest ? latest.slice(0, 7) : null
}

// ------------------------------------------------------------------
// 組合入口（runner §5.1 用）
// ------------------------------------------------------------------

export interface IdentifyOutcome {
  labId: string | null
  labBasis: 'ALIAS' | 'NAME' | null
  payeeIsNew: boolean
  docNo: string | null
  docNoKind: 'INVOICE_NO' | 'CASE_NO' | null
  duplicateOfId: string | null
  clinicId: string | null
  clinicBasis: ClinicBasis
  clinicEvidence: string | null
  providerId: string | null
  providerBasis: ProviderBasis
  providerEvidence: string | null
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
  // §6.2 診所（CUSTOMER_NO 路徑需要 labId；唔到 lab 就冇呢個 basis）
  const clinic = await identifyClinic(prisma, result, { labId })
  // §6.3 醫生（CUSTOMER_NO 用 §6.2.1 帶出嘅 providerId）
  const provider = await identifyProvider(prisma, result, {
    customerNoProviderId: clinic.providerIdFromCustomerNo,
    customerNoRaw: result.billTo.customerNoRaw ?? result.sections[0]?.customerNoRaw ?? null,
  })
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
    clinicId: clinic.clinicId,
    clinicBasis: clinic.clinicBasis,
    clinicEvidence: clinic.evidence,
    providerId: provider.providerId,
    providerBasis: provider.providerBasis,
    providerEvidence: provider.evidence,
    docNo: docNo.docNo,
    docNoKind: docNo.docNoKind,
    duplicateOfId: docNo.duplicateOfId,
  }
}
