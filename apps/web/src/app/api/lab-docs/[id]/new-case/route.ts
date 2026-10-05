// ★ cwm-labdoc P2 §7.6：POST /api/lab-docs/:id/new-case — 新增成本（T4 冪等）
//
// 預填（reconcile.prefillNewCase，spec §7.6）：
//   clinicId = invoice 診所（鎖；先確認咗診所先開得）、providerId = invoice 醫生（可改）、
//   labId、category = 'LAB'（鎖死 F-25）、patientCode／patientCodeNorm、
//   patientName = PatientIndex 姓名（冇就 null；唔用 invoice 拼音）、labOrderNo = 分組行 labCaseRef、
//   baseCost = 分組合計（server 由 DB 計）、finalCost = baseCost、
//   orderedAt = orderReceivedDate ?? docDate（可覆蓋）、source = 'MANUAL'、labInvoiceLinked = true
// 員工必揀：itemType。
// 冪等（T4）：write-log.ts（LabDocWriteLog）— 同 key + 同 hash 重放 → 同 response（replayed: true）；
//   同 key 唔同 hash / IN_PROGRESS → 409。
// audit：LAB_DOC_CASE_CREATE（after = 新成本主要欄位；🔴 唔記 patientName）。
// 權限：lab_invoice（§10.2；角色白名單 OWNER/MANAGER）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'
import { deriveCostPeriod } from '@/lib/cost-entry/period-month'
import { acquireWriteLog, completeWriteLog, stableRequestHash } from '@/lib/labdoc/write-log'
import { prefillNewCase } from '@/lib/labdoc/reconcile'
import { assertAuditInputClean } from '@/lib/labdoc/audit'

const DOC_ID_RE = /^[a-z0-9]{25}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CODE_RE = /^[A-Z]{1,4}\d{1,6}$/
const KEY_RE = /^[a-zA-Z0-9:_-]{1,128}$/
const RECONCILE_READY = new Set(['CONFIRMED', 'PARTIAL', 'RECONCILED'])
const ROUTE_TAG = 'POST /api/lab-docs/:id/new-case'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params
  // 格式檢查喺 auth 前（malformed input fail-fast；同 header route 同一口徑）
  if (!DOC_ID_RE.test(id)) return NextResponse.json({ error: '單據 ID 格式錯誤' }, { status: 400 })

  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return NextResponse.json({ error: '冇任何診所範圍，唔可以新增成本' }, { status: 403 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '請求 body 格式錯誤' }, { status: 400 })
  }
  if (typeof body !== 'object' || body === null) return NextResponse.json({ error: '請求 body 格式錯誤' }, { status: 400 })

  // —— 驗證 ——
  const idempotencyKey: string = body.idempotencyKey
  if (!KEY_RE.test(idempotencyKey ?? '')) {
    return NextResponse.json({ error: 'idempotencyKey 缺失或格式錯誤' }, { status: 400 })
  }
  const patientCodeNormRaw: string = body.patientCodeNorm
  if (typeof patientCodeNormRaw !== 'string' || !CODE_RE.test(patientCodeNormRaw.trim().toUpperCase())) {
    return NextResponse.json({ error: 'patientCodeNorm 缺失或格式錯誤（例 TW007159）' }, { status: 400 })
  }
  const code = patientCodeNormRaw.trim().toUpperCase()
  const groupIndex: number = body.groupIndex
  if (typeof groupIndex !== 'number' || !Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > 99) {
    return NextResponse.json({ error: 'groupIndex 缺失或格式錯誤' }, { status: 400 })
  }
  const itemType: string = body.itemType
  if (typeof itemType !== 'string' || itemType.trim() === '' || itemType.trim().length > 60) {
    return NextResponse.json({ error: 'itemType 必填（≤60 字）' }, { status: 400 })
  }
  let orderedAtOverride: string | null = null
  if (body.orderedAt !== undefined && body.orderedAt !== null) {
    if (typeof body.orderedAt !== 'string' || !DATE_RE.test(body.orderedAt)) {
      return NextResponse.json({ error: 'orderedAt 格式錯誤（要 YYYY-MM-DD）' }, { status: 400 })
    }
    orderedAtOverride = body.orderedAt
  }
  let providerOverride: string | null = null
  if (body.providerId !== undefined && body.providerId !== null) {
    if (typeof body.providerId !== 'string' || !DOC_ID_RE.test(body.providerId)) {
      return NextResponse.json({ error: 'providerId 格式錯誤' }, { status: 400 })
    }
    providerOverride = body.providerId
  }

  // —— 冪等 acquire（T4）——
  const requestHash = stableRequestHash({
    patientCodeNorm: code,
    groupIndex,
    itemType: itemType.trim(),
    orderedAt: orderedAtOverride,
    providerId: providerOverride,
    docId: id,
  })
  const acquired = await acquireWriteLog(idempotencyKey, ROUTE_TAG, requestHash, session.userId)
  if (acquired.kind === 'replay') {
    return NextResponse.json({ ...(acquired.response as object), replayed: true }, { status: 200 })
  }
  if (acquired.kind === 'conflict') {
    return NextResponse.json(
      { error: acquired.reason === 'hash_mismatch' ? 'idempotencyKey 已用过但內容唔同 — 請用新 key' : '同一新增成本請求正在處理中 — 請用新 key' },
      { status: 409 },
    )
  }

  // —— 載入文件（只要呢個分組嘅行）——
  const doc = await prisma.labDocument.findUnique({
    where: { id },
    include: { lines: { where: { groupIndex }, orderBy: { lineIndex: 'asc' } } },
  })
  if (!doc) return NextResponse.json({ error: '單據唔存在' }, { status: 404 })
  if (scope !== null && !(doc.clinicId && scope.includes(doc.clinicId))) {
    return NextResponse.json({ error: '單據唔存在' }, { status: 404 })
  }
  if (!RECONCILE_READY.has(doc.status)) {
    return NextResponse.json({ error: `單據狀態 ${doc.status} 未可以新增成本（要先確認頭部）` }, { status: 400 })
  }
  if (!doc.clinicId) {
    return NextResponse.json({ error: '先要確認 invoice 診所（新增成本需要診所）' }, { status: 400 })
  }
  if (doc.lines.length === 0) {
    return NextResponse.json({ error: '呢個分組冇行' }, { status: 400 })
  }

  // —— 分組 patientCode 一致性 ——
  const groupNorms = [...new Set(doc.lines.map((l) => l.patientCode).filter((c): c is string => !!c))]
  if (groupNorms.length > 0 && !groupNorms.includes(code)) {
    return NextResponse.json({ error: `分組病人編號（${groupNorms[0]}）同請求（${code}）唔符` }, { status: 400 })
  }

  // —— provider（invoice 醫生；可改；必填）——
  const providerId = providerOverride ?? doc.providerId
  if (!providerId) {
    return NextResponse.json({ error: '要選醫生（invoice 未有醫生；必填）' }, { status: 400 })
  }
  const prov = await prisma.provider.findUnique({ where: { id: providerId }, select: { id: true } })
  if (!prov) return NextResponse.json({ error: '醫生唔存在' }, { status: 400 })

  // —— orderedAt（orderReceivedDate ?? docDate；可覆蓋）——
  const orderedAt =
    orderedAtOverride ??
    (doc.orderReceivedDate ? doc.orderReceivedDate.toISOString().slice(0, 10) : doc.docDate ? doc.docDate.toISOString().slice(0, 10) : null)
  if (!orderedAt) {
    return NextResponse.json({ error: '冇落單日期（orderReceivedDate/docDate 都係空）— 請傳 orderedAt' }, { status: 400 })
  }

  // —— 分組合計 + labCaseRef + 系統姓名 ——
  const groupSum = Math.round(doc.lines.reduce((s, l) => s + Number(l.amount || 0), 0) * 100) / 100
  const labCaseRef = doc.lines.find((l) => l.labCaseRef)?.labCaseRef ?? null
  const pi = await prisma.patientIndex.findFirst({ where: { patientCode: code }, select: { patientName: true } })

  try {
    // —— §7.6 預填（reconcile 單一邏輯來源）——
    const prefill = prefillNewCase({
      clinicId: doc.clinicId,
      providerId,
      labId: doc.labId,
      patientCode: code,
      patientCodeNorm: code,
      systemPatientName: pi?.patientName ?? null,
      labCaseRef,
      groupSum,
      orderReceivedDate: new Date(`${orderedAt}T00:00:00Z`),
      docDate: doc.docDate,
      itemType: itemType.trim(),
    })
    const { receivedAt, periodMonth } = deriveCostPeriod('LAB', prefill.orderedAt, null)

    const created = await prisma.costCase.create({
      data: {
        providerId: prefill.providerId,
        clinicId: prefill.clinicId,
        category: prefill.category,
        patientCode: prefill.patientCode,
        patientCodeNorm: prefill.patientCodeNorm,
        patientName: prefill.patientName,
        orderedAt: prefill.orderedAt,
        itemType: prefill.itemType,
        labId: prefill.labId,
        labOrderNo: prefill.labOrderNo,
        baseCost: prefill.baseCost,
        discountPct: null, // B4
        finalCost: prefill.finalCost,
        receivedAt,
        status: prefill.status,
        periodMonth,
        source: prefill.source,
        labInvoiceLinked: true,
        createdBy: session.userId,
      },
    })

    // —— audit LAB_DOC_CASE_CREATE（🔴 唔記 patientName）——
    const afterObj = {
      id: created.id,
      providerId: created.providerId,
      clinicId: created.clinicId,
      category: created.category,
      patientCode: created.patientCode,
      patientCodeNorm: created.patientCodeNorm,
      itemType: created.itemType,
      labId: created.labId,
      labOrderNo: created.labOrderNo,
      baseCost: created.baseCost == null ? null : Number(created.baseCost),
      finalCost: created.finalCost == null ? null : Number(created.finalCost),
      orderedAt: created.orderedAt.toISOString().slice(0, 10),
      source: created.source,
      docId: doc.id,
      groupIndex,
    }
    assertAuditInputClean({ after: afterObj, notes: `經 Lab 單據 ${doc.docNo ?? '(no docNo)'} 新增成本（分組 ${groupIndex}）` })
    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: 'LAB_DOC_CASE_CREATE',
        entity: 'CostCase',
        entityId: created.id,
        clinicId: doc.clinicId,
        beforeJson: null,
        afterJson: JSON.stringify(afterObj),
        notes: `經 Lab 單據 ${doc.docNo ?? '(no docNo)'} 新增成本（分組 ${groupIndex}）`,
      },
    })

    const resp = {
      case: {
        id: created.id,
        providerId: created.providerId,
        clinicId: created.clinicId,
        category: created.category,
        patientCode: created.patientCode,
        patientCodeNorm: created.patientCodeNorm,
        orderedAt: created.orderedAt.toISOString().slice(0, 10),
        itemType: created.itemType,
        labId: created.labId,
        labOrderNo: created.labOrderNo,
        baseCost: created.baseCost == null ? null : Number(created.baseCost),
        discountPct: null,
        finalCost: created.finalCost == null ? null : Number(created.finalCost),
        status: created.status,
        periodMonth: created.periodMonth,
        source: created.source,
        labInvoiceLinked: true,
      },
    }
    await completeWriteLog(idempotencyKey, resp)
    return NextResponse.json(resp, { status: 201 })
  } catch (e: any) {
    // 失敗：key 留 IN_PROGRESS（burn 咗 — write-log decision log：防雙寫；前端換新 key 重試）
    console.error('[labdoc] new-case failed', { docId: id, err: e?.message })
    return NextResponse.json({ error: '新增成本失敗，請重試' }, { status: 500 })
  }
}
