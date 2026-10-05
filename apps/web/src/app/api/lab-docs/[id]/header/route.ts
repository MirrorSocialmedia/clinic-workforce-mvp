// ★ cwm-labdoc P2 §7.1：PUT /api/lab-docs/:id/header — 確認頭部
// 可改：Lab、診所、醫生、單號、單號類型、日期、出貨日、總數、小計、
//       每組病人編號原文、每行（描述、牙位、數量、單價、金額）、增刪行、行搬去另一個分組、增刪分組。
// 規則：
//   - §7.9 守門：已 MATCHED 行唔可以喺確認時刪走（要先解除配對或標忽略 — §7.8 group save）→ 400
//   - §5.5 擋確認條件未解決 → 400（差 $X／總數空／CHEQUE_PRESENT）
//   - 任何金額或總數同 AI 原值唔同 → manualAmountEdit = true（待處理「人手改數待覆核」）
//   - version 唔等 → 409「呢張單啱啱被 {人} 改咗，請重新載入」（樂觀鎖）
//   - 寫欄位＋行；status 重算（§3.4 reconcile）；alias 學習（§6）；
//     audit LAB_DOC_CONFIRM（before = AI 值、after = 確認值、只記有改嘅欄位；🔴 唔記 patientNameRaw）
// 權限：lab_invoice（§10.2；角色白名單 OWNER/MANAGER）
// P2 範圍 = INVOICE；STATEMENT 對數屬 P3（§8）→ 400。
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'
import { getConfirmCheckResult, computeManualAmountEdit } from '@/lib/labdoc/confirm-checks'
import { learnAliases } from '@/lib/labdoc/alias-learn'
import { recomputeInvoiceDocStatus } from '@/lib/labdoc/reconcile'
import { assertAuditInputClean } from '@/lib/labdoc/audit'
import { normPatientCode } from '@/lib/cost-entry/patient-code'

const DOC_ID_RE = /^[a-z0-9]{25}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_MONEY = 1_000_000
const CONFIRMABLE = new Set(['NEEDS_REVIEW', 'CONFIRMED', 'PARTIAL', 'RECONCILED'])
const DOC_NO_KINDS = new Set(['INVOICE_NO', 'CASE_NO'])

const BAD: unique symbol = Symbol('bad')

function parseDateOpt(v: unknown): Date | null | typeof BAD {
  if (v === null) return null
  if (typeof v === 'string' && DATE_RE.test(v)) {
    const d = new Date(`${v}T00:00:00Z`)
    return Number.isNaN(d.getTime()) ? BAD : d
  }
  return BAD
}

function parseMoneyOpt(v: unknown): number | null | typeof BAD {
  if (v === null) return null
  if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_MONEY) {
    return Math.round(v * 100) / 100
  }
  return BAD
}

function parseMaybeNum(v: unknown): number | null | typeof BAD {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return BAD
}

function parseStrOpt(v: unknown, max: number): string | null | typeof BAD {
  if (v === null) return null
  if (typeof v === 'string' && v.trim().length <= max) return v.trim()
  return BAD
}

interface InLine {
  lineId: string | null
  description: string
  toothRaw: string | null
  qty: number | null
  unitPrice: number | null
  listPrice: number | null
  discountRaw: string | null
  amount: number
}

interface InGroup {
  groupIndex: number
  /** undefined = 未提供（保持現值）；null = 清空；string = 設 */
  patientCodeRaw: string | null | undefined
  patientNameRaw: string | null
  lines: InLine[]
}

function parseGroups(raw: unknown): { groups: InGroup[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'groups 必須係陣列' }
  const seenGroup = new Set<number>()
  const groups: InGroup[] = []
  for (const g of raw) {
    if (typeof g !== 'object' || g === null) return { error: 'groups 格式錯誤' }
    const groupIndex = g.groupIndex
    if (typeof groupIndex !== 'number' || !Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > 99) {
      return { error: 'groupIndex 格式錯誤（0 起整數）' }
    }
    if (seenGroup.has(groupIndex)) return { error: `分組 ${groupIndex} 出現兩次` }
    seenGroup.add(groupIndex)

    let codeRawVal: string | null | undefined
    if (g.patientCodeRaw === undefined) {
      codeRawVal = undefined // 未提供 → 保持現有
    } else {
      const p = parseStrOpt(g.patientCodeRaw, 60)
      if (p === BAD) return { error: 'patientCodeRaw 格式錯誤（≤60 字）' }
      codeRawVal = p
    }
    const pnr = g.patientNameRaw === undefined ? null : parseStrOpt(g.patientNameRaw, 200)
    if (pnr === BAD) return { error: 'patientNameRaw 格式錯誤（≤200 字）' }
    if (!Array.isArray(g.lines)) return { error: `分組 ${groupIndex} 嘅 lines 必須係陣列` }
    const lines: InLine[] = []
    for (const r of g.lines) {
      if (typeof r !== 'object' || r === null) return { error: 'lines 格式錯誤' }
      let lineId: string | null = null
      if (r.lineId !== undefined && r.lineId !== null) {
        if (typeof r.lineId !== 'string' || !DOC_ID_RE.test(r.lineId)) return { error: 'lineId 格式錯誤' }
        lineId = r.lineId
      }
      const description = parseStrOpt(r.description, 200)
      if (description === BAD || !description) return { error: '行描述必填（≤200 字）' }
      const amount = parseMoneyOpt(r.amount)
      if (amount === BAD || amount === null) return { error: '行金額必填（數字，|金額| ≤ 1,000,000）' }
      const toothRaw = parseStrOpt(r.toothRaw, 60)
      const qty = parseMaybeNum(r.qty)
      const unitPrice = parseMoneyOpt(r.unitPrice)
      const listPrice = parseMoneyOpt(r.listPrice)
      const discountRaw = parseStrOpt(r.discountRaw, 40)
      lines.push({
        lineId,
        description,
        toothRaw: toothRaw === BAD ? null : toothRaw,
        qty: qty === BAD ? null : qty,
        unitPrice: unitPrice === BAD ? null : unitPrice,
        listPrice: listPrice === BAD ? null : listPrice,
        discountRaw: discountRaw === BAD ? null : discountRaw,
        amount: amount as number,
      })
    }
    groups.push({ groupIndex, patientCodeRaw: codeRawVal, patientNameRaw: pnr as string | null, lines })
  }
  return { groups }
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params
  // 格式檢查喺 auth 前（malformed input fail-fast；RBAC normalizeRoute 對短 id/hyphen id 會 403，咁就唔對）
  if (!DOC_ID_RE.test(id)) return NextResponse.json({ error: '單據 ID 格式錯誤' }, { status: 400 })

  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return NextResponse.json({ error: '冇任何診所範圍，唔可以改單據' }, { status: 403 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '請求 body 格式錯誤' }, { status: 400 })
  }
  if (typeof body !== 'object' || body === null) return NextResponse.json({ error: '請求 body 格式錯誤' }, { status: 400 })

  // —— version（樂觀鎖；必填）——
  const version = body.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return NextResponse.json({ error: 'version 必填（整數）' }, { status: 400 })
  }
  const pg = parseGroups(body.groups)
  if ('error' in pg) return NextResponse.json({ error: pg.error }, { status: 400 })
  const groups = pg.groups

  // —— 載入文件 ——
  const doc = await prisma.labDocument.findUnique({
    where: { id },
    include: {
      lines: { orderBy: [{ groupIndex: 'asc' }, { lineIndex: 'asc' }] },
      lab: { select: { id: true, name: true, isActive: true } },
    },
  })
  if (!doc || doc.id !== id) return NextResponse.json({ error: '單據唔存在' }, { status: 404 })
  if (scope !== null && !(doc.clinicId && scope.includes(doc.clinicId))) {
    return NextResponse.json({ error: '單據唔存在' }, { status: 404 })
  }
  if (!CONFIRMABLE.has(doc.status)) {
    return NextResponse.json({ error: `單據狀態 ${doc.status} 未可以確認（要先讀單）` }, { status: 400 })
  }
  if (doc.kind !== 'INVOICE') {
    return NextResponse.json({ error: '月結單對數屬 P3 範圍；而家只可以確認 INVOICE' }, { status: 400 })
  }
  const clinicRow = doc.clinicId
    ? await prisma.clinic.findUnique({ where: { id: doc.clinicId }, select: { id: true, name: true, shortName: true } })
    : null

  // —— 欄位解析（未提供 = 保持現值）——
  const opt = (name: string, fn: (v: unknown) => unknown, err: string) => {
    if (body[name] === undefined) return { value: undefined as unknown }
    const p = fn(body[name])
    if (p === BAD) return { error: err }
    return { value: p }
  }
  let docNoKind: string | null | undefined
  if (body.docNoKind !== undefined) {
    if (body.docNoKind === null) docNoKind = null
    else if (typeof body.docNoKind === 'string' && DOC_NO_KINDS.has(body.docNoKind)) docNoKind = body.docNoKind
    else return NextResponse.json({ error: 'docNoKind 格式錯誤（INVOICE_NO / CASE_NO / null）' }, { status: 400 })
  }
  const pDocNo = opt('docNo', (v) => parseStrOpt(v, 120), 'docNo 格式錯誤（≤120 字）')
  if ('error' in pDocNo) return NextResponse.json({ error: pDocNo.error }, { status: 400 })
  const pLabNameRaw = opt('labNameRaw', (v) => parseStrOpt(v, 200), 'labNameRaw 格式錯誤（≤200 字）')
  if ('error' in pLabNameRaw) return NextResponse.json({ error: pLabNameRaw.error }, { status: 400 })
  const pCustomerNoRaw = opt('customerNoRaw', (v) => parseStrOpt(v, 120), 'customerNoRaw 格式錯誤（≤120 字）')
  if ('error' in pCustomerNoRaw) return NextResponse.json({ error: pCustomerNoRaw.error }, { status: 400 })
  const pPayeeRaw = opt('payeeRaw', (v) => parseStrOpt(v, 200), 'payeeRaw 格式錯誤（≤200 字）')
  if ('error' in pPayeeRaw) return NextResponse.json({ error: pPayeeRaw.error }, { status: 400 })
  const pDocDate = opt('docDate', parseDateOpt, 'docDate 格式錯誤（YYYY-MM-DD 或 null）')
  if ('error' in pDocDate) return NextResponse.json({ error: pDocDate.error }, { status: 400 })
  const pDeliveryDate = opt('deliveryDate', parseDateOpt, 'deliveryDate 格式錯誤（YYYY-MM-DD 或 null）')
  if ('error' in pDeliveryDate) return NextResponse.json({ error: pDeliveryDate.error }, { status: 400 })
  const pOrderReceivedDate = opt('orderReceivedDate', parseDateOpt, 'orderReceivedDate 格式錯誤（YYYY-MM-DD 或 null）')
  if ('error' in pOrderReceivedDate) return NextResponse.json({ error: pOrderReceivedDate.error }, { status: 400 })
  const pTotal = opt('total', parseMoneyOpt, 'total 格式錯誤（數字或 null，|金額| ≤ 1,000,000）')
  if ('error' in pTotal) return NextResponse.json({ error: pTotal.error }, { status: 400 })
  const pSubtotal = opt('subtotal', parseMoneyOpt, 'subtotal 格式錯誤（數字或 null，|金額| ≤ 1,000,000）')
  if ('error' in pSubtotal) return NextResponse.json({ error: pSubtotal.error }, { status: 400 })
  const idOpt = (name: string) => {
    if (body[name] === undefined) return { ok: true as const, value: undefined as string | null | undefined }
    if (body[name] === null) return { ok: true as const, value: null as string | null | undefined }
    if (typeof body[name] === 'string' && DOC_ID_RE.test(body[name])) return { ok: true as const, value: body[name] as string }
    return { ok: false as const, error: `${name} 格式錯誤` }
  }
  const pLabId = idOpt('labId')
  if (!pLabId.ok) return NextResponse.json({ error: pLabId.error }, { status: 400 })
  const pClinicId = idOpt('clinicId')
  if (!pClinicId.ok) return NextResponse.json({ error: pClinicId.error }, { status: 400 })
  const pProviderId = idOpt('providerId')
  if (!pProviderId.ok) return NextResponse.json({ error: pProviderId.error }, { status: 400 })
  const labId = pLabId.value
  const clinicId = pClinicId.value
  const providerId = pProviderId.value

  // —— 外鍵驗證 ——
  if (labId !== undefined && labId !== null) {
    const lab = await prisma.lab.findUnique({ where: { id: labId }, select: { id: true } })
    if (!lab) return NextResponse.json({ error: 'Lab 唔存在' }, { status: 400 })
  }
  if (clinicId !== undefined && clinicId !== null) {
    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { id: true } })
    if (!clinic) return NextResponse.json({ error: '診所唔存在' }, { status: 400 })
  }
  if (providerId !== undefined && providerId !== null) {
    const prov = await prisma.provider.findUnique({ where: { id: providerId }, select: { id: true } })
    if (!prov) return NextResponse.json({ error: '醫生唔存在' }, { status: 400 })
  }

  // —— 行 lineId 要屬呢張單 ——
  const byLineId = new Map(doc.lines.map((l: any) => [l.id, l]))
  const requestedIds = new Set<string>()
  for (const g of groups) {
    for (const l of g.lines) {
      if (l.lineId) {
        if (!byLineId.has(l.lineId)) return NextResponse.json({ error: 'lineId 唔屬於呢張單' }, { status: 400 })
        if (requestedIds.has(l.lineId)) return NextResponse.json({ error: '同一 lineId 出現兩次' }, { status: 400 })
        requestedIds.add(l.lineId)
      }
    }
  }

  // —— §7.9 守門：已 MATCHED 行唔可以喺確認時刪走 ——
  const matchedMissing = doc.lines.filter((l: any) => l.status === 'MATCHED' && !requestedIds.has(l.id))
  if (matchedMissing.length > 0) {
    return NextResponse.json(
      { error: `有 ${matchedMissing.length} 條已配對行未交返 — 已配對行唔可以直接刪除（要先解除配對或標「忽略」）` },
      { status: 400 },
    )
  }

  // —— 有效值（未提供 = 現值）——
  const effLabId = labId === undefined ? doc.labId : labId
  const effClinicId = clinicId === undefined ? doc.clinicId : clinicId
  const effProviderId = providerId === undefined ? doc.providerId : providerId
  const effLabNameRaw = pLabNameRaw.value === undefined ? doc.labNameRaw : (pLabNameRaw.value as string | null)
  const effCustomerNoRaw = pCustomerNoRaw.value === undefined ? doc.customerNoRaw : (pCustomerNoRaw.value as string | null)
  const effPayeeRaw = pPayeeRaw.value === undefined ? doc.payeeRaw : (pPayeeRaw.value as string | null)
  const effDocNo = pDocNo.value === undefined ? doc.docNo : (pDocNo.value as string | null)
  const effDocNoKind = docNoKind === undefined ? doc.docNoKind : docNoKind
  const effDocDate: Date | null = pDocDate.value === undefined ? doc.docDate : (pDocDate.value as Date | null)
  const effDeliveryDate: Date | null = pDeliveryDate.value === undefined ? doc.deliveryDate : (pDeliveryDate.value as Date | null)
  const effOrderReceivedDate: Date | null = pOrderReceivedDate.value === undefined ? doc.orderReceivedDate : (pOrderReceivedDate.value as Date | null)
  const effTotal: number | null = pTotal.value === undefined ? (doc.total ? Number(doc.total) : null) : (pTotal.value as number | null)
  const effSubtotal: number | null = pSubtotal.value === undefined ? (doc.subtotal ? Number(doc.subtotal) : null) : (pSubtotal.value as number | null)

  // §6.5：分組 patientCodeRaw → patientCode（用 invoice 診所 shortName）
  const clinicShortName = clinicRow?.shortName ?? null

  // —— §5.5 擋確認檢查（用改後值）——
  const check = getConfirmCheckResult(
    { kind: doc.kind, total: effTotal, subtotal: effSubtotal, docDate: effDocDate, readIssues: doc.readIssues, createdAt: doc.createdAt },
    groups.flatMap((g) => g.lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, amount: l.amount }))),
  )
  if (check.blockers.length > 0) {
    return NextResponse.json({ error: '未可以確認', blockers: check.blockers }, { status: 400 })
  }

  // —— alias 學習需要嘅原文（extractedJson）——
  const ej = (doc.extractedJson as any) ?? null
  const clinicRaw = ej?.billTo?.nameRaw ?? null
  const doctorRaw = ej?.billTo?.doctorRaw ?? null

  try {
    const result = await prisma.$transaction(async (tx: any) => {
      // —— version 樂觀鎖（條件寫；request version 唔等於 DB = 有人改咗）——
      const claim = await tx.labDocument.updateMany({
        where: { id: doc.id, version },
        data: { version: { increment: 1 } },
      })
      if (claim.count === 0) {
        const lastActorId: string | null = doc.confirmedBy ?? doc.uploadedBy
        const actor = lastActorId ? await tx.user.findUnique({ where: { id: lastActorId }, select: { name: true } }) : null
        throw new HeaderClaimError(`呢張單啱啱被 ${actor?.name ?? '其他人'} 改咗，請重新載入`)
      }

      // —— 改咗診所 → 攞新 shortName（patientCode 重算）——
      let shortName = clinicShortName
      if (effClinicId !== doc.clinicId) {
        const c = effClinicId ? await tx.clinic.findUnique({ where: { id: effClinicId }, select: { shortName: true } }) : null
        shortName = c?.shortName ?? null
      }

      // —— 寫行（全替換：改有、加新、刪走；配對狀態由 §7.8 管，確認時只保留）——
      const keptIds = new Set<string>()
      for (const g of groups) {
        // 分組病人編號原文：未提供 → 用該組現有行嘅 patientCodeRaw（保持）
        let codeRaw = g.patientCodeRaw
        if (codeRaw === undefined) {
          const ex = g.lines.filter((l) => l.lineId).map((l) => byLineId.get(l.lineId as string)).find((l) => l?.patientCodeRaw != null)
          codeRaw = ex?.patientCodeRaw ?? null
        }
        for (let lineIndex = 0; lineIndex < g.lines.length; lineIndex++) {
          const l = g.lines[lineIndex]
          const existing = l.lineId ? byLineId.get(l.lineId) : null
          const isMatched = existing?.status === 'MATCHED'
          if (existing) {
            keptIds.add(existing.id)
            await tx.labDocumentLine.update({
              where: { id: existing.id },
              data: {
                groupIndex: g.groupIndex,
                lineIndex,
                description: l.description,
                toothRaw: l.toothRaw,
                qty: l.qty,
                unitPrice: l.unitPrice,
                listPrice: l.listPrice,
                discountRaw: l.discountRaw,
                amount: l.amount,
                isZero: l.amount === 0,
                patientCodeRaw: codeRaw,
                patientCode: normPatientCode(codeRaw, shortName),
                status: isMatched ? 'MATCHED' : existing.status === 'IGNORED' ? 'IGNORED' : 'UNMATCHED',
                ...(g.patientNameRaw != null ? { patientNameRaw: g.patientNameRaw } : {}),
              },
            })
          } else {
            await tx.labDocumentLine.create({
              data: {
                documentId: doc.id,
                groupIndex: g.groupIndex,
                lineIndex,
                description: l.description,
                toothRaw: l.toothRaw,
                qty: l.qty,
                unitPrice: l.unitPrice,
                listPrice: l.listPrice,
                discountRaw: l.discountRaw,
                amount: l.amount,
                isZero: l.amount === 0,
                patientCodeRaw: codeRaw,
                patientCode: normPatientCode(codeRaw, shortName),
                patientNameRaw: g.patientNameRaw,
                status: 'UNMATCHED',
                costCaseId: null,
                linkType: null,
              },
            })
          }
        }
      }
      // 刪走未交返嘅非 MATCHED 行
      const deleteIds = doc.lines.filter((l: any) => !keptIds.has(l.id)).map((l: any) => l.id)
      if (deleteIds.length > 0) {
        await tx.labDocumentLine.deleteMany({ where: { id: { in: deleteIds } } })
      }

      // —— manualAmountEdit（任何金額/總數同 AI 原值唔同；一旦 true 唔會除）——
      const manualAmountEdit =
        doc.manualAmountEdit ||
        computeManualAmountEdit(
          ej,
          {
            total: effTotal,
            subtotal: effSubtotal,
            lines: groups.flatMap((g) => g.lines.map((l, li) => ({ groupIndex: g.groupIndex, lineIndex: li, amount: l.amount }))),
          },
          doc.manualAmountEdit,
        )

      // —— §3.4 狀態重算（reconcile 單一來源；MATCHED 行跟 DB 現狀）——
      const nextStatuses: string[] = []
      for (const g of groups) {
        for (let lineIndex = 0; lineIndex < g.lines.length; lineIndex++) {
          const l = g.lines[lineIndex]
          const existing = l.lineId ? byLineId.get(l.lineId) : null
          nextStatuses.push(existing ? (existing.status === 'MATCHED' ? 'MATCHED' : existing.status === 'IGNORED' ? 'IGNORED' : 'UNMATCHED') : 'UNMATCHED')
        }
      }
      const status = recomputeInvoiceDocStatus(nextStatuses)

      const updated = await tx.labDocument.update({
        where: { id: doc.id },
        data: {
          version: doc.version + 1,
          ...(labId === undefined ? {} : { labId: effLabId }),
          ...(pLabNameRaw.value === undefined ? {} : { labNameRaw: effLabNameRaw }),
          ...(clinicId === undefined ? {} : { clinicId: effClinicId }),
          ...(providerId === undefined ? {} : { providerId: effProviderId }),
          ...(pDocNo.value === undefined ? {} : { docNo: effDocNo }),
          ...(docNoKind === undefined ? {} : { docNoKind: effDocNoKind }),
          ...(pDocDate.value === undefined ? {} : { docDate: effDocDate }),
          ...(pDeliveryDate.value === undefined ? {} : { deliveryDate: effDeliveryDate }),
          ...(pOrderReceivedDate.value === undefined ? {} : { orderReceivedDate: effOrderReceivedDate }),
          ...(pTotal.value === undefined ? {} : { total: effTotal }),
          ...(pSubtotal.value === undefined ? {} : { subtotal: effSubtotal }),
          ...(pCustomerNoRaw.value === undefined ? {} : { customerNoRaw: effCustomerNoRaw }),
          ...(pPayeeRaw.value === undefined ? {} : { payeeRaw: effPayeeRaw }),
          manualAmountEdit,
          status,
          confirmedBy: session.userId,
          confirmedAt: new Date(),
        },
        include: {
          lines: { orderBy: [{ groupIndex: 'asc' }, { lineIndex: 'asc' }] },
          lab: { select: { id: true, name: true, isActive: true } },
        },
      })
      const finalClinic =
        effClinicId !== doc.clinicId
          ? (effClinicId ? await tx.clinic.findUnique({ where: { id: effClinicId }, select: { id: true, name: true, shortName: true } }) : null)
          : clinicRow

      // —— alias 學習（§6；同一 transaction 入面；PII guard fail-closed）——
      const aliasResult = await learnAliases(tx, {
        aiLabId: doc.labId,
        aiLabBasis: doc.labBasis,
        aiClinicId: doc.clinicId,
        aiClinicBasis: doc.clinicBasis,
        aiProviderId: doc.providerId,
        aiProviderBasis: doc.providerBasis,
        labId: effLabId,
        labNameRaw: effLabNameRaw,
        labNameCnRaw: null,
        clinicId: effClinicId,
        providerId: effProviderId,
        customerNoRaw: effCustomerNoRaw,
        clinicRaw,
        doctorRaw,
        actorId: session.userId,
        docId: doc.id,
      })

      // —— audit LAB_DOC_CONFIRM（before = AI 值、after = 確認值、只記有改嘅欄位）——
      const changed: Record<string, { before: unknown; after: unknown }> = {}
      const addChanged = (key: string, aiVal: unknown, after: unknown) => {
        const a = aiVal == null ? null : typeof aiVal === 'number' ? aiVal : String(aiVal)
        const b = after == null ? null : typeof after === 'number' ? after : String(after)
        const same = a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 0.01)
        if (!same) changed[key] = { before: a, after: b }
      }
      addChanged('docNo', ej?.docNoRaw ?? ej?.docNo ?? null, effDocNo)
      addChanged('total', ej?.total ?? null, effTotal)
      addChanged('subtotal', ej?.subtotal ?? null, effSubtotal)
      addChanged('docDate', ej?.date ?? null, effDocDate ? effDocDate.toISOString().slice(0, 10) : null)
      addChanged('deliveryDate', ej?.deliveryDate ?? null, effDeliveryDate ? effDeliveryDate.toISOString().slice(0, 10) : null)
      addChanged('orderReceivedDate', ej?.orderReceivedDate ?? null, effOrderReceivedDate ? effOrderReceivedDate.toISOString().slice(0, 10) : null)
      if (labId !== undefined && labId !== doc.labId) changed['labId'] = { before: doc.labId, after: labId }
      if (clinicId !== undefined && clinicId !== doc.clinicId) changed['clinicId'] = { before: doc.clinicId, after: clinicId }
      if (providerId !== undefined && providerId !== doc.providerId) changed['providerId'] = { before: doc.providerId, after: providerId }

      // 行改動（AI 行 vs 確認行，按 (groupIndex,lineIndex)）
      const aiLineByPos = new Map<string, { description: string | null; qty: number | null; unitPrice: number | null; amount: number | null }>()
      if (Array.isArray(ej?.groups)) {
        ;(ej.groups as any[]).forEach((g, gi) => {
          const gl = Array.isArray(g?.lines) ? g.lines : []
          gl.forEach((l: any, li: number) => {
            aiLineByPos.set(`${gi}:${li}`, {
              description: l?.description ?? null,
              qty: l?.qty == null ? null : Number(l.qty),
              unitPrice: l?.unitPrice == null ? null : Number(l.unitPrice),
              amount: l?.amount == null ? null : Number(l.amount),
            })
          })
        })
      }
      const lineChanges: Array<{ pos: string; before: Record<string, unknown> | null; after: Record<string, unknown> }> = []
      for (const g of groups) {
        for (let li = 0; li < g.lines.length; li++) {
          const l = g.lines[li]
          const al = aiLineByPos.get(`${g.groupIndex}:${li}`)
          const afterObj = { description: l.description, qty: l.qty, unitPrice: l.unitPrice, amount: l.amount }
          if (al) {
            const amtDiff = al.amount != null && Math.abs(al.amount - l.amount) > 0.01
            if (amtDiff || (al.description ?? null) !== l.description || (al.qty ?? null) !== l.qty || (al.unitPrice ?? null) !== l.unitPrice) {
              lineChanges.push({ pos: `${g.groupIndex}:${li}`, before: { ...al }, after: afterObj })
            }
          } else {
            lineChanges.push({ pos: `${g.groupIndex}:${li}`, before: null, after: afterObj })
          }
        }
      }
      if (lineChanges.length > 0) {
        // 每一條：{ pos, before（null = 新增行）, after }
        changed['lines'] = { before: lineChanges, after: lineChanges }
      }

      const beforeObj: Record<string, unknown> = {}
      const afterObj: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(changed)) {
        beforeObj[k] = v.before
        afterObj[k] = v.after
      }
      assertAuditInputClean({ before: beforeObj, after: afterObj, notes: `確認單據 ${doc.docNo ?? '(no docNo)'} → ${status}` })
      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'LAB_DOC_CONFIRM',
          entity: 'LabDocument',
          entityId: doc.id,
          clinicId: effClinicId,
          beforeJson: JSON.stringify(beforeObj),
          afterJson: JSON.stringify(afterObj),
          notes: `確認單據 ${doc.docNo ?? '(no docNo)'} → ${status}`,
        },
      })

      return { updated, finalClinic, aliasResult }
    })

    return jsonNoStore({
      document: {
        id: result.updated.id,
        status: result.updated.status,
        version: result.updated.version,
        labId: result.updated.labId,
        labName: result.updated.lab?.name ?? null,
        clinicId: result.updated.clinicId,
        clinicName: result.finalClinic?.name ?? null,
        providerId: result.updated.providerId,
        docNo: result.updated.docNo,
        docNoKind: result.updated.docNoKind,
        docDate: result.updated.docDate ? result.updated.docDate.toISOString().slice(0, 10) : null,
        deliveryDate: result.updated.deliveryDate ? result.updated.deliveryDate.toISOString().slice(0, 10) : null,
        orderReceivedDate: result.updated.orderReceivedDate ? result.updated.orderReceivedDate.toISOString().slice(0, 10) : null,
        total: result.updated.total ? Number(result.updated.total) : null,
        subtotal: result.updated.subtotal ? Number(result.updated.subtotal) : null,
        manualAmountEdit: result.updated.manualAmountEdit,
        lines: result.updated.lines.map((l: any) => ({
          id: l.id,
          groupIndex: l.groupIndex,
          lineIndex: l.lineIndex,
          description: l.description,
          toothRaw: l.toothRaw,
          qty: l.qty == null ? null : Number(l.qty),
          unitPrice: l.unitPrice == null ? null : Number(l.unitPrice),
          amount: Number(l.amount),
          isZero: l.isZero,
          patientCodeRaw: l.patientCodeRaw,
          patientCode: l.patientCode,
          labCaseRef: l.labCaseRef,
          status: l.status,
          ignoreReason: l.ignoreReason,
          costCaseId: l.costCaseId,
          linkType: l.linkType,
        })),
      },
      warnings: check.warnings,
      aliases: { learned: result.aliasResult.learned },
    })
  } catch (e: any) {
    if (e instanceof HeaderClaimError) {
      return NextResponse.json({ error: e.message }, { status: 409 })
    }
    if (e?.code === 'P2002') {
      return NextResponse.json({ error: '同一 Lab 已經有同一單號嘅未作廢 INVOICE' }, { status: 409 })
    }
    console.error('[labdoc] header confirm failed', { docId: id, err: e?.message })
    return NextResponse.json({ error: '確認失敗，請重試' }, { status: 500 })
  }
}

class HeaderClaimError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HeaderClaimError'
  }
}
