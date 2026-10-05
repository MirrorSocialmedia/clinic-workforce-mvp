/**
 * cwm-labdoc P2 — §6.5 病人配對 + §7.3 候選成本（data layer）
 *
 * route：GET /api/lab-docs/:id/groups/:g/candidates?code=
 *   （code = 員工揀咗「其他前綴」後傳入嘅 patientCodeNorm；唔傳 = 用分組行嘅 patientCode）
 *
 * 純函數部分（排序 §7.3 / 預設 §7.4）喺 reconcile.ts — 本檔只做 DB 撈取＋拼裝。
 *
 * 🔴 注意：CostCase 冇 Prisma provider/clinic relation — 要手動 map（findMany + byId）。
 *
 * §6.5 口徑（逐字）：
 *   - 精確 patientCodeNorm = X → 自動（code 由行 patientCode 嚟；route 層顯示「編號吻合」）。
 *   - 冇 code（行 patientCode null），而 raw 係純數字 → 搵其他前綴同數字：
 *     已知 shortName（純英文字母）+ 補零 6 位 → PatientIndex 攞系統姓名 → 列出俾員工揀，唔自動揀。
 *   - 同時查 PatientIndex.patientCode → 系統姓名（畫面「系統：{姓名}」）。
 */
import { prisma } from '@/lib/prisma'
import { normShortName } from '@/lib/cost-entry/patient-code'
import { rankCandidateIds, defaultGroupSelection, round2 } from './reconcile'

const CODE_RE = /^[A-Z]{1,4}\d{6}$/

export interface CandidateLink {
  docId: string
  docNo: string | null
  linkType: 'MAIN' | 'SUPPLEMENTARY' | 'REDO'
}

export interface CandidateView {
  caseId: string
  itemType: string | null
  itemTypeOther: string | null
  orderedAt: string | null
  providerId: string
  providerName: string | null
  clinicId: string
  clinicName: string | null
  /** null = 未有價 */
  baseCost: number | null
  status: string
  /** status = 'REDO' → 顯示「重做中」 */
  isRedo: boolean
  /** null = 未到貨 */
  receivedAt: string | null
  periodMonth: string | null
  /** true = 已出月結（灰色，得連、唔改價） */
  lockedByRunId: boolean
  /** 已有 MAIN 連結（其他單）— 揀佢要揀補收費／重做（B7） */
  mainLink: CandidateLink | null
  /** 補收費／重做連結（已連咗邊幾張單） */
  otherLinks: CandidateLink[]
}

export interface GroupCandidatesPayload {
  docId: string
  groupIndex: number
  invoiceClinicId: string | null
  invoiceClinicName: string | null
  /** 分組病人編號（patientCodeNorm）；null = 未解析（睇 patientOptions） */
  code: string | null
  codeSource: 'line' | 'override'
  groupSum: number
  lines: Array<{
    lineId: string
    description: string
    amount: number
    isZero: boolean
    patientCode: string | null
    patientCodeRaw: string | null
    status: string
    costCaseId: string | null
  }>
  /** §6.5 其他前綴選項（只有 code 未解析先有內容；唔自動揀） */
  patientOptions: Array<{ code: string; name: string | null; clinicShortName: string | null; clinicName: string | null }>
  /** PatientIndex 系統姓名（null = 無） */
  systemName: string | null
  candidates: CandidateView[]
  defaults: {
    selectedCostCaseId: string | null
    lineActions: Array<{ lineId: string; action: 'MATCH' | 'IGNORE' | 'UNMATCH'; costCaseId: string | null; linkType: 'MAIN' | null }>
    showNewCase: boolean
    showPatientSearch: boolean
  }
}

function dstr(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null
}

function normDigits(raw: string | null): string | null {
  if (raw == null) return null
  const s = String(raw).replace(/[\s#]/g, '').replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).toUpperCase()
  return s === '' ? null : s
}

/**
 * 撈一個分組嘅候選成本。doc 唔存在 → null（route 404）。
 */
export async function getCandidatesForGroup(
  docId: string,
  groupIndex: number,
  opts: { clinicShortName: string | null; codeOverride: string | null },
): Promise<GroupCandidatesPayload | null> {
  const doc = await prisma.labDocument.findUnique({
    where: { id: docId },
    include: { lines: { orderBy: [{ groupIndex: 'asc' }, { lineIndex: 'asc' }] } },
  })
  if (!doc) return null

  const clinic = doc.clinicId
    ? await prisma.clinic.findUnique({ where: { id: doc.clinicId }, select: { id: true, name: true, shortName: true } })
    : null

  const lines = doc.lines.filter((l: any) => l.groupIndex === groupIndex)
  const groupSum = round2(lines.reduce((s: number, l: any) => s + Number(l.amount || 0), 0))

  // —— 病人編號（§6.5）——
  const overrideCode = opts.codeOverride ? String(opts.codeOverride).trim().toUpperCase() : null
  const lineCode: string | null = lines.find((l: any) => l.patientCode)?.patientCode ?? null
  let code: string | null = null
  let codeSource: 'line' | 'override' = 'line'
  if (overrideCode && CODE_RE.test(overrideCode)) {
    code = overrideCode
    codeSource = 'override'
  } else if (lineCode && CODE_RE.test(lineCode)) {
    code = lineCode
  }

  const lineViews = lines.map((l: any) => ({
    lineId: l.id as string,
    description: l.description as string,
    amount: Number(l.amount || 0),
    isZero: !!l.isZero,
    patientCode: (l.patientCode as string | null) ?? null,
    patientCodeRaw: (l.patientCodeRaw as string | null) ?? null,
    status: l.status as string,
    costCaseId: (l.costCaseId as string | null) ?? null,
  }))

  // —— 候選成本（§7.3 SQL 口徑）——
  const cands: CandidateView[] = []
  if (code) {
    const rows = await prisma.costCase.findMany({
      where: {
        patientCodeNorm: code,
        status: { not: 'VOID' },
        // (labId = :labId OR (labId IS NULL AND :labId IS NULL))
        ...(doc.labId ? { labId: doc.labId } : { labId: null }),
      },
      select: {
        id: true,
        itemType: true,
        itemTypeOther: true,
        orderedAt: true,
        providerId: true,
        clinicId: true,
        baseCost: true,
        status: true,
        receivedAt: true,
        periodMonth: true,
        lockedByRunId: true,
      },
    })
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id)
      const [providers, clinics, links] = await Promise.all([
        prisma.provider.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
        prisma.clinic.findMany({ where: { id: { in: rows.map((r) => r.clinicId) } }, select: { id: true, name: true } }),
        prisma.labDocumentLine.findMany({
          where: { costCaseId: { in: ids }, status: 'MATCHED' },
          select: { costCaseId: true, linkType: true, documentId: true },
        }),
      ])
      const provById = new Map(providers.map((p) => [p.id, p.name]))
      const clinById = new Map(clinics.map((c) => [c.id, c.name]))
      const docIds = [...new Set(links.map((l) => l.documentId))]
      const docs = docIds.length > 0 ? await prisma.labDocument.findMany({ where: { id: { in: docIds } }, select: { id: true, docNo: true } }) : []
      const docById = new Map(docs.map((d) => [d.id, d.docNo]))
      const linksByCase = new Map<string, CandidateLink[]>()
      for (const l of links) {
        const lt = (l.linkType as string | null) ?? 'MAIN'
        if (!['MAIN', 'SUPPLEMENTARY', 'REDO'].includes(lt)) continue
        if (l.costCaseId === null) continue
        const arr = linksByCase.get(l.costCaseId) ?? []
        arr.push({ docId: l.documentId, docNo: docById.get(l.documentId) ?? null, linkType: lt as CandidateLink['linkType'] })
        linksByCase.set(l.costCaseId, arr)
      }
      // §7.3 排序（reconcile 單一邏輯來源）
      const ordered = rankCandidateIds(
        rows.map((r) => ({
          id: r.id,
          baseCost: r.baseCost == null ? null : Number(r.baseCost),
          receivedAt: r.receivedAt,
          orderedAt: r.orderedAt,
        })),
        groupSum,
      )
      const byId = new Map(rows.map((r) => [r.id, r]))
      for (const cid of ordered) {
        const r = byId.get(cid)
        if (!r) continue
        const links = linksByCase.get(cid) ?? []
        cands.push({
          caseId: cid,
          itemType: r.itemType,
          itemTypeOther: r.itemTypeOther,
          orderedAt: dstr(r.orderedAt),
          providerId: r.providerId,
          providerName: provById.get(r.providerId) ?? null,
          clinicId: r.clinicId,
          clinicName: clinById.get(r.clinicId) ?? null,
          baseCost: r.baseCost == null ? null : Number(r.baseCost),
          status: r.status,
          isRedo: r.status === 'REDO',
          receivedAt: dstr(r.receivedAt),
          periodMonth: r.periodMonth,
          lockedByRunId: !!r.lockedByRunId,
          mainLink: links.find((l) => l.linkType === 'MAIN') ?? null,
          otherLinks: links.filter((l) => l.linkType !== 'MAIN'),
        })
      }
    }
  }

  // —— §6.5 其他前綴選項（code 未解析、行 raw 純數字先列）——
  let patientOptions: GroupCandidatesPayload['patientOptions'] = []
  if (!code) {
    const rawDigits = normDigits(lines.find((l: any) => l.patientCodeRaw)?.patientCodeRaw ?? null)
    if (rawDigits && /^\d{1,6}$/.test(rawDigits)) {
      const n6 = rawDigits.padStart(6, '0')
      const clinics = await prisma.clinic.findMany({ select: { id: true, name: true, shortName: true } })
      const codes = clinics
        .map((c) => ({ short: normShortName(c.shortName), name: c.name }))
        .filter((c): c is { short: string; name: string } => c.short != null)
        .map((c) => ({ code: `${c.short}${n6}`, short: c.short, name: c.name }))
      if (codes.length > 0) {
        const pi = await prisma.patientIndex.findMany({
          where: { patientCode: { in: codes.map((c) => c.code) } },
          select: { patientCode: true, patientName: true },
        })
        const piByCode = new Map(pi.map((p) => [p.patientCode, p.patientName]))
        patientOptions = codes
          .filter((c) => piByCode.has(c.code))
          .map((c) => ({ code: c.code, name: piByCode.get(c.code) ?? null, clinicShortName: c.short, clinicName: c.name }))
      }
    }
  }

  // —— 系統姓名（§6.5）——
  let systemName: string | null = null
  if (code) {
    const pi = await prisma.patientIndex.findFirst({ where: { patientCode: code }, select: { patientName: true } })
    systemName = pi?.patientName ?? null
  }

  // —— §7.4 預設（reconcile 單一邏輯來源）——
  const defaults = defaultGroupSelection(
    lineViews.map((l) => ({ lineId: l.lineId, amount: l.amount, isZero: l.isZero })),
    cands.map((c) => ({ id: c.caseId, baseCost: c.baseCost, hasMainLink: !!c.mainLink })),
    groupSum,
  )

  return {
    docId,
    groupIndex,
    invoiceClinicId: doc.clinicId,
    invoiceClinicName: clinic?.name ?? null,
    code,
    codeSource,
    groupSum,
    lines: lineViews,
    patientOptions,
    systemName,
    candidates: cands,
    defaults,
  }
}
