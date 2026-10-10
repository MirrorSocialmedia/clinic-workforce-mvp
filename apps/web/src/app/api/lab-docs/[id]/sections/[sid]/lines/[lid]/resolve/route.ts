// ★ cwm-labdoc P3：POST /api/lab-docs/:id/sections/:sid/lines/:lid/resolve — §8.3 處理差異
//
// body：{ resolution, note?, systemDocumentId?, systemLineId?, costAdjustConfirmed? }
//
// | resolution   | 效果 |
// | INVOICE_WINS | 唔改系統；行入待處理「同 Lab 跟進」（CHUNK 6 STATEMENT_DIFF）直到 followUpClosedAt（close-followup route）
// | STATEMENT_WINS（要原因）| 改系統 invoice 行（qty/unitPrice/amount 有值先改）＋文件 total；
// |              |   行已連成本：未鎖 → 成本由 $X 改做 $linkedSum（要先收到 needsCostPreview，UI 確認後 costAdjustConfirmed=true 重試）；已鎖 → 照改系統、成本入 LOCKED_ADJUST（下期調整）
// |              |   行 result → MATCHED（系統已改到同月結單一致）；audit LAB_STATEMENT_ADJUST（before/after 行＋成本）
// | MANUAL_PAIRED| 人手揀系統 invoice（同段範圍內）＋可指定行 → 再行比較；matchBasis=MANUAL
// | NOT_OURS（要原因）| 唔屬本集團；唔改系統
//
// 權限：lab_statement（§10.2）；audit：LAB_STATEMENT_RESOLVE（全部）＋ LAB_STATEMENT_ADJUST（STATEMENT_WINS）
// ownership-ok: labdoc 全集團範圍（B16）；line.section=section.document=doc（防 IDOR）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'
import { labdocAudit } from '@/lib/labdoc/audit'
import { monthBounds, saveSectionTotals } from '@/lib/labdoc/statement-reconcile'
import { gradeLinePair, type LineType } from '@/lib/labdoc/statement-match'
import { applyPriceUpdate, computeLinkedSumDb, PriceLockedError } from '@/lib/labdoc/cost-actions'
import { round2 } from '@/lib/labdoc/reconcile'
import { sectionDuplicateBlock } from '@/lib/labdoc/statement-sections'

const ID_RE = /^[a-z0-9]{25}$/
const SYSTEM_DOC_STATUSES = ['CONFIRMED', 'PARTIAL', 'RECONCILED']
const RESOLUTIONS = ['INVOICE_WINS', 'STATEMENT_WINS', 'MANUAL_PAIRED', 'NOT_OURS'] as const
type Resolution = (typeof RESOLUTIONS)[number]

export async function POST(req: NextRequest, { params }: { params: { id: string; sid: string; lid: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }
  if (![params.id, params.sid, params.lid].every((x) => ID_RE.test(x))) {
    return jsonNoStore({ error: 'ID 格式錯誤' }, { status: 400 })
  }

  let body: {
    resolution?: string
    note?: string | null
    systemDocumentId?: string | null
    systemLineId?: string | null
    costAdjustConfirmed?: boolean
  }
  try {
    body = await req.json()
  } catch {
    return jsonNoStore({ error: 'JSON body 缺失' }, { status: 400 })
  }
  const { resolution, note = null, systemDocumentId = null, systemLineId = null, costAdjustConfirmed = false } = body
  if (!RESOLUTIONS.includes(resolution as Resolution)) {
    return jsonNoStore({ error: 'resolution 必須係 INVOICE_WINS／STATEMENT_WINS／MANUAL_PAIRED／NOT_OURS' }, { status: 400 })
  }
  if (resolution === 'STATEMENT_WINS' && (!note || typeof note !== 'string' || note.trim().length === 0)) {
    return jsonNoStore({ error: 'STATEMENT_WINS 要原因' }, { status: 400 })
  }
  if (resolution === 'NOT_OURS' && (!note || typeof note !== 'string' || note.trim().length === 0)) {
    return jsonNoStore({ error: 'NOT_OURS 要原因' }, { status: 400 })
  }
  if (note && note.length > 200) {
    return jsonNoStore({ error: '原因最多 200 字' }, { status: 400 })
  }

  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return jsonNoStore({ error: '冇任何診所範圍' }, { status: 403 })
  }

  // —— 載入（防 IDOR）——
  const doc = await prisma.labDocument.findUnique({
    where: { id: params.id },
    select: { id: true, kind: true, status: true, labId: true, statementMonth: true, version: true, createdAt: true },
  })
  if (!doc || doc.status === 'VOID' || doc.kind !== 'STATEMENT') {
    return jsonNoStore({ error: '單據唔存在或唔係月結單' }, { status: 404 })
  }
  const section = await prisma.labStatementSection.findFirst({
    where: { id: params.sid, documentId: doc.id },
    select: { id: true, clinicId: true, providerId: true, statedTotal: true, statedCurrent: true, resultJson: true, status: true },
  })
  if (!section) return jsonNoStore({ error: '分段唔屬於呢張單' }, { status: 404 })
  const line = await prisma.labStatementLine.findFirst({
    where: { id: params.lid, sectionId: section.id },
  })
  if (!line) return jsonNoStore({ error: '行唔屬於呢個分段' }, { status: 404 })
  // 改處理（2026-10-10 修）：分段未確認、而之前揀嘅係冇改系統嘅 INVOICE_WINS／NOT_OURS → 准改；
  // STATEMENT_WINS 已改咗系統 invoice／成本 → 唔准（要人手改返 invoice 再 MANUAL_PAIRED）
  if (line.resolution && resolution !== 'MANUAL_PAIRED') {
    const changeable = section.status !== 'CONFIRMED' && (line.resolution === 'INVOICE_WINS' || line.resolution === 'NOT_OURS')
    if (!changeable) {
      return jsonNoStore(
        {
          error:
            section.status === 'CONFIRMED'
              ? '分段已確認 — 唔可以再改處理'
              : '呢行揀咗「月結單為準」並已改咗系統 — 唔可以直接改（可改配 MANUAL_PAIRED）',
        },
        { status: 409 },
      )
    }
  }
  if (section.status === 'CONFIRMED') {
    return jsonNoStore({ error: '分段已確認 — 唔可以再改處理' }, { status: 409 })
  }
  if (doc.status === 'SUPERSEDED') {
    return jsonNoStore({ error: '呢張月結單已被取代 — 請喺新版處理' }, { status: 409 })
  }
  // §8.1：重複分段唔准處理（STATEMENT_WINS 會改系統）— 要先取代舊版
  const dupMsg = await sectionDuplicateBlock(prisma, doc, section)
  if (dupMsg) return jsonNoStore({ error: dupMsg, code: 'SECTION_DUPLICATE' }, { status: 409 })
  if (!doc.statementMonth || !doc.labId) {
    return jsonNoStore({ error: '文件無 statementMonth／labId — 無法處理差異' }, { status: 400 })
  }
  const stmtMonth = doc.statementMonth

  const profile = await prisma.labProfile.findUnique({ where: { labId: doc.labId } })
  const kind = profile?.statementKind === 'DETAIL' || profile?.statementKind === 'OUTSTANDING' ? profile.statementKind : 'INVOICE_LIST'

  // —— MANUAL_PAIRED：驗證目標系統 invoice 喺同段範圍內 ——
  let sysDoc: any = null
  let sysLine: any = null
  if (resolution === 'MANUAL_PAIRED') {
    if (!systemDocumentId) return jsonNoStore({ error: 'MANUAL_PAIRED 要 systemDocumentId' }, { status: 400 })
    sysDoc = await prisma.labDocument.findUnique({
      where: { id: systemDocumentId },
      include: { lines: true },
    })
    const inScope =
      sysDoc &&
      sysDoc.kind === 'INVOICE' &&
      SYSTEM_DOC_STATUSES.includes(sysDoc.status) &&
      sysDoc.labId === doc.labId &&
      section.clinicId !== null &&
      sysDoc.clinicId === section.clinicId &&
      section.providerId !== null &&
      sysDoc.providerId === section.providerId
    if (!inScope) {
      return jsonNoStore({ error: '目標 invoice 唔喺呢個分段範圍內（要同 Lab／診所／醫生、已確認狀態）' }, { status: 400 })
    }
    const { from, to } = monthBounds(stmtMonth)
    if (!sysDoc.docDate || sysDoc.docDate < from || sysDoc.docDate > to) {
      return jsonNoStore({ error: '目標 invoice 日期唔喺分段範圍（月初−45 日～月尾+10 日）' }, { status: 400 })
    }
    if (systemLineId) {
      sysLine = sysDoc.lines.find((l: any) => l.id === systemLineId) ?? null
      if (!sysLine) return jsonNoStore({ error: 'systemLineId 唔屬於目標 invoice' }, { status: 400 })
    }
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null
  const now = new Date()
  const finalLineResult =
    resolution === 'STATEMENT_WINS' ? 'MATCHED' : resolution === 'MANUAL_PAIRED' ? undefined : line.result

  // —— tx：寫系統（STATEMENT_WINS）／寫行／重算 section ——
  const resolveTx = async (tx: any): Promise<any> => {
    let adjustBefore: Record<string, unknown> | null = null
    let adjustAfter: Record<string, unknown> | null = null
    let costPreview: { itemType: string | null; baseCost: number | null; newLinkedSum: number; locked: boolean } | null = null
    let needsCostConfirm = false

    if (resolution === 'STATEMENT_WINS') {
      if (!line.matchedDocumentId) {
        return { fail: { status: 400, error: '行未配對到系統 invoice — 先跑配對或 MANUAL_PAIRED' } as const }
      }
      sysDoc = await tx.labDocument.findUnique({ where: { id: line.matchedDocumentId }, include: { lines: true } })
      if (!sysDoc || sysDoc.kind !== 'INVOICE') {
        return { fail: { status: 400, error: '配對到嘅系統 invoice 已唔存在' } as const }
      }
      let targetLine = line.matchedLineId ? sysDoc.lines.find((l: any) => l.id === line.matchedLineId) : null
      if (line.matchedLineId && !targetLine) {
        return { fail: { status: 400, error: '配對到嘅系統行已唔存在 — 重跑配對' } as const }
      }
      // 單號型／欠款型（整張單配對，冇 matchedLineId）：月結單金額 = 成張 invoice。
      // 要落到某一行先改得（同埋先行到成本鏈）— 只得一行就用嗰行；多行要 systemLineId 揀（2026-10-10 修：
      // 舊做法只改 doc total，行同成本都冇改，invoice 變成 total ≠ Σ 行）。
      const docLevel = !line.matchedLineId
      if (docLevel) {
        const live = (sysDoc.lines as any[]).filter((l) => l.status !== 'IGNORED')
        if (systemLineId) {
          targetLine = (sysDoc.lines as any[]).find((l) => l.id === systemLineId) ?? null
          if (!targetLine) return { fail: { status: 400, error: 'systemLineId 唔屬於配對到嘅 invoice' } as const }
        } else if (live.length === 1) {
          targetLine = live[0]
        } else {
          return {
            fail: {
              status: 400,
              error: `呢張 invoice 有 ${live.length} 行 — 請揀要改邊一行（systemLineId）`,
              code: 'PICK_SYSTEM_LINE',
              lines: live.map((l) => ({ id: l.id, description: l.description, amount: Number(l.amount) })),
            },
          } as const
        }
      }

      const oldLine = targetLine
        ? { qty: numOr0(targetLine.qty), unitPrice: numOr0(targetLine.unitPrice), amount: Number(targetLine.amount) }
        : null
      // 整張單配對：揀中嗰行新額 = 月結單金額 − 其他行（唔計忽略行）
      const othersSum = docLevel
        ? round2((sysDoc.lines as any[]).filter((l) => l.id !== targetLine.id && l.status !== 'IGNORED').reduce((a, l) => a + Number(l.amount), 0))
        : 0
      const newLineAmount = round2(Number(line.amount) - othersSum)
      if (docLevel && newLineAmount < 0) {
        return { fail: { status: 400, error: '月結單金額細過 invoice 其他行合計 — 請用 MANUAL_PAIRED 或人手改 invoice' } as const }
      }
      const newQty = line.qty === null || line.qty === undefined ? null : Number(line.qty)
      let newUnitPrice = line.unitPrice === null || line.unitPrice === undefined ? null : Number(line.unitPrice)
      // 月結單冇單價（單號型）而原行 qty×單價 = 金額 → 單價跟住改，保持行內一致
      if (docLevel && newUnitPrice === null && oldLine && oldLine.qty > 0 && Math.abs(oldLine.qty * oldLine.unitPrice - oldLine.amount) <= 0.01) {
        newUnitPrice = round2(newLineAmount / oldLine.qty)
      }

      // —— 成本鏈（§8.3：行已連成本）——
      let priceUpdateApplied = false
      let costBefore: Record<string, unknown> | null = null
      let costAfter: Record<string, unknown> | null = null
      if (targetLine && targetLine.costCaseId) {
        const cc = await tx.costCase.findUnique({ where: { id: targetLine.costCaseId } })
        if (cc && cc.status !== 'VOID') {
          const locked = cc.lockedByRunId != null
          costBefore = {
            itemType: cc.itemType ?? null,
            baseCost: cc.baseCost == null ? null : Number(cc.baseCost),
            finalCost: cc.finalCost == null ? null : Number(cc.finalCost),
            lockedByRunId: cc.lockedByRunId,
          }
          if (locked) {
            // 已鎖：唔改價；改額後 linkedSum 唔等 → 自動入 LOCKED_ADJUST 待處理（下期調整）
            const lockedSum = round2(
              await computeLinkedSumDb(tx, { costCaseId: cc.id, pendingAmounts: [newLineAmount - (oldLine ? oldLine.amount : 0)] }),
            )
            costPreview = { itemType: cc.itemType ?? null, baseCost: cc.baseCost == null ? null : Number(cc.baseCost), newLinkedSum: lockedSum, locked: true }
          } else {
            // 未鎖：§7.5 改做 $linkedSum（linkedSum = 所有 MATCHED 行 ＋ 今次要連嘅行新額）
            const newLinkedSum = round2(
              await computeLinkedSumDb(tx, {
                costCaseId: cc.id,
                pendingAmounts: [newLineAmount - (oldLine ? oldLine.amount : 0)],
              }),
            )
            const baseCost = cc.baseCost == null ? null : Number(cc.baseCost)
            if (baseCost !== null && Math.abs(baseCost - newLinkedSum) <= 0.01) {
              costPreview = { itemType: cc.itemType ?? null, baseCost, newLinkedSum, locked: false }
            } else if (!costAdjustConfirmed) {
              // 要改價 → 先俾預覽（零寫入），UI 確認後重試
              needsCostConfirm = true
              costPreview = { itemType: cc.itemType ?? null, baseCost, newLinkedSum, locked: false }
            } else {
              await applyPriceUpdate(tx, {
                costCaseId: cc.id,
                newAmount: newLinkedSum,
                docId: sysDoc.id,
                lineIds: [targetLine.id],
                actorId: session.userId,
                clinicId: cc.clinicId,
              })
              priceUpdateApplied = true
              costAfter = { baseCost: newLinkedSum, finalCost: newLinkedSum, discountPct: null }
            }
          }
        }
      }

      if (needsCostConfirm) {
        return { costPreview: costPreview! } as const
      }

      adjustBefore = {
        line: oldLine,
        docTotal: sysDoc.total == null ? null : Number(sysDoc.total),
        cost: costBefore,
      }

      // —— 寫系統 ——
      const oldAmount = targetLine ? Number(targetLine.amount) : 0
      if (targetLine) {
        await tx.labDocumentLine.update({
          where: { id: targetLine.id },
          data: {
            ...(newQty !== null ? { qty: newQty } : {}),
            ...(newUnitPrice !== null ? { unitPrice: newUnitPrice } : {}),
            amount: newLineAmount,
          },
        })
        // 文件 total 跟行差額（有值先）
        if (sysDoc.total !== null && sysDoc.total !== undefined) {
          await tx.labDocument.update({
            where: { id: sysDoc.id },
            data: { total: Number(sysDoc.total) + (newLineAmount - oldAmount) },
          })
        }
      }

      adjustAfter = {
        line: { qty: targetLine ? (newQty ?? numOr0(targetLine.qty)) : null, unitPrice: targetLine ? (newUnitPrice ?? numOr0(targetLine.unitPrice)) : null, amount: targetLine ? newLineAmount : null },
        docTotal: sysDoc.total == null ? null : Number(sysDoc.total) + (newLineAmount - oldAmount),
        cost: priceUpdateApplied ? costAfter : costBefore && costBefore.lockedByRunId ? { ...costBefore, adjustedInNextPeriod: true } : null,
      }
    }

    // —— 寫 statement 行 ——
    let manualResult: string | null = null
    if (resolution === 'MANUAL_PAIRED') {
      // 再行比較
      let result: string
      if (sysLine) {
        result = gradeLinePair(
          {
            id: sysLine.id,
            description: sysLine.description ?? '',
            toothRaw: sysLine.toothRaw ?? null,
            qty: sysLine.qty == null ? null : Number(sysLine.qty),
            unitPrice: sysLine.unitPrice == null ? null : Number(sysLine.unitPrice),
            amount: Number(sysLine.amount),
            patientCode: sysLine.patientCode ?? null,
          },
          {
            id: line.id,
            lineIndex: line.lineIndex,
            lineType: line.lineType as LineType,
            docNo: line.docNo,
            date: line.date,
            patientCode: line.patientCode,
            description: line.description,
            toothRaw: line.toothRaw,
            qty: line.qty == null ? null : Number(line.qty),
            unitPrice: line.unitPrice == null ? null : Number(line.unitPrice),
            amount: Number(line.amount),
            agingBucket: line.agingBucket,
          },
        )
      } else {
        result =
          sysDoc.total == null || Math.abs(Number(sysDoc.total) - Number(line.amount)) <= 0.01 ? 'MATCHED' : 'AMOUNT_DIFF'
      }
      manualResult = result
      await tx.labStatementLine.update({
        where: { id: line.id },
        data: {
          result,
          matchBasis: 'MANUAL',
          matchedDocumentId: sysDoc.id,
          matchedLineId: sysLine ? sysLine.id : null,
          resolution: 'MANUAL_PAIRED',
          resolutionNote: note,
          resolvedBy: session.userId,
          resolvedAt: now,
          followUpClosedAt: null,
          followUpClosedBy: null,
        },
      })
    } else {
      // INVOICE_WINS／STATEMENT_WINS／NOT_OURS
      await tx.labStatementLine.update({
        where: { id: line.id },
        data: {
          ...(resolution === 'STATEMENT_WINS' ? { result: 'MATCHED' } : {}),
          resolution,
          resolutionNote: note,
          resolvedBy: session.userId,
          resolvedAt: now,
          followUpClosedAt: resolution === 'INVOICE_WINS' ? null : line.followUpClosedAt,
          followUpClosedBy: resolution === 'INVOICE_WINS' ? null : line.followUpClosedBy,
        },
      })
    }

    // —— 重算 section 總數（§8.2 口徑）——
    const freshLines = await tx.labStatementLine.findMany({
      where: { sectionId: section.id },
      select: { result: true, matchedDocumentId: true, matchedLineId: true, resolution: true },
    })
    const systemDocs = await tx.labDocument.findMany({
      where: {
        kind: 'INVOICE',
        status: { in: SYSTEM_DOC_STATUSES },
        labId: doc.labId,
        clinicId: section.clinicId,
        providerId: section.providerId,
        docDate: { gte: monthBounds(stmtMonth).from, lte: monthBounds(stmtMonth).to },
      },
      include: { lines: true },
    })
    const sysInvoices = systemDocs.map((d: any) => ({
      id: d.id,
      docNo: d.docNo ?? null,
      docDate: d.docDate ?? null,
      total: d.total == null ? null : Number(d.total),
      lines: (d.lines as any[]).map((l: any) => ({
        id: l.id,
        description: l.description ?? '',
        toothRaw: l.toothRaw ?? null,
        qty: l.qty == null ? null : Number(l.qty),
        unitPrice: l.unitPrice == null ? null : Number(l.unitPrice),
        amount: Number(l.amount),
        patientCode: l.patientCode ?? null,
      })),
    }))
    const prevJson = (section.resultJson ?? {}) as any
    const saved = await saveSectionTotals(tx, {
      sectionId: section.id,
      documentId: doc.id,
      finalLines: freshLines,
      systemInvoices: sysInvoices,
      statedTotal: section.statedTotal == null ? null : Number(section.statedTotal),
      statedCurrent: section.statedCurrent == null ? null : Number(section.statedCurrent),
      useCurrent: kind === 'OUTSTANDING',
      source: `resolve:${resolution}`,
      virtualLines: prevJson.virtualLines ?? [],
      notOnStatement: prevJson.notOnStatement ?? [],
    })
    if (!saved) return { fail: { status: 404, error: '分段已唔存在' } } as const

    return {
      saved,
      adjustBefore,
      adjustAfter,
      costPreview,
      lineResult: manualResult,
    }
  }
  let txResult: any
  try {
  txResult = await prisma.$transaction(async (tx: any) => {
    const r = await resolveTx(tx)
    if ('fail' in r) throw new ResolveFail(r.fail) // fail 一定 rollback（唔好 commit 咗一半）
    return r
  }, { timeout: 60_000 })
  } catch (e) {
    if (e instanceof ResolveFail) {
      const { status, ...rest } = e.fail
      return jsonNoStore(rest, { status })
    }
    if (e instanceof PriceLockedError) {
      return jsonNoStore({ error: '成本已出月結 — 唔可以改價（要喺月結單期內處理）' }, { status: 409 })
    }
    throw e
  }

  if ('fail' in txResult) {
    return jsonNoStore({ error: txResult.fail.error }, { status: txResult.fail.status })
  }
  if ('costPreview' in txResult && !('saved' in txResult)) {
    // 零寫入：成本改價預覽（UI 顯示「成本 {項目} 會由 $X 改做 $Y」，確認後 costAdjustConfirmed=true 重試）
    // ok:false — 呢個只係預覽，未寫（前端唔好當成功）
    return NextResponse.json({ ok: false, needsCostConfirm: true, costPreview: txResult.costPreview })
  }

  // —— audit（tx 後）——
  try {
    if (txResult.adjustBefore) {
      await labdocAudit({
        action: 'LAB_STATEMENT_ADJUST',
        entity: 'LabStatementLine',
        entityId: line.id,
        clinicId: section.clinicId,
        actorId: session.userId,
        ipAddress: ip,
        userAgent: ua,
        notes: `STATEMENT_WINS（doc ${doc.id}）：${note}`,
        before: txResult.adjustBefore,
        after: txResult.adjustAfter,
      })
    }
    await labdocAudit({
      action: 'LAB_STATEMENT_RESOLVE',
      entity: 'LabStatementLine',
      entityId: line.id,
      clinicId: section.clinicId,
      actorId: session.userId,
      ipAddress: ip,
      userAgent: ua,
      notes: `${resolution}（doc ${doc.id}）${note ? `：${note}` : ''}`,
      after: { resolution, result: resolution === 'MANUAL_PAIRED' ? (txResult.lineResult ?? null) : finalLineResult },
    })
  } catch (e) {
    console.error('[labdoc] resolve audit failed', e)
  }

  return NextResponse.json({
    ok: true,
    line: {
      id: line.id,
      result: resolution === 'MANUAL_PAIRED' ? (txResult.lineResult ?? null) : finalLineResult,
      resolution,
    },
    section: { id: section.id, status: txResult.saved.status, systemTotal: txResult.saved.systemTotal },
    ...(txResult.costPreview ? { costPreview: txResult.costPreview } : {}),
  })
}

class ResolveFail extends Error {
  constructor(public fail: { status: number; error: string; [k: string]: unknown }) {
    super(fail.error)
  }
}

function numOr0(v: unknown): number {
  return v == null ? 0 : Number(v)
}
