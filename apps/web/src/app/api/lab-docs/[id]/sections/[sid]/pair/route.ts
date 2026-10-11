// ★ cwm-labdoc：POST /api/lab-docs/:id/sections/:sid/pair — 月結單行 ⇄ 成本錄入 人手配對
//
// 2026-10-11 用家拍板：
//  - 系統自動劃唔到（例如兩張 invoice 嘅 $210 + $190 = 成本 $400）→ 人手揀幾行配一筆成本
//  - 系統劃錯 → 「未配對到」拆開；拆開嘅行之後唔再自動劃（可以「恢復自動配對」）
//  - 人手配對一定要啱數（行加埋 = 成本 finalCost，差 ≤ $0.01），唔啱數唔准
//  - 幾行 → 一筆成本；唔支援一行拆去幾筆成本
//
// body：
//  { op: 'PAIR',   lineIds: string[], costCaseId }  — 人手配對
//  { op: 'UNPAIR', lineId }                          — 未配對到：拆開成組（人手或者自動），成組行唔再自動劃
//  { op: 'AUTO',   lineId }                          — 恢復自動配對（取消「未配對到」）
// 配對只係提示，唔影響 OK／DIFF（總數對總數）。做完即刻重新對數。
// 權限：lab_statement；audit：LAB_STATEMENT_PAIR（行 id、成本 id、金額；零病人資料）
// ownership-ok: labdoc 全集團範圍（B16）；line.section=section.document=doc、成本要喺分段範圍（防 IDOR）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { labdocAudit } from '@/lib/labdoc/audit'
import { reconcileSection, costScopeWhere } from '@/lib/labdoc/statement-reconcile'
import { sectionDuplicateBlock } from '@/lib/labdoc/statement-sections'
import { labdocScope, kioskDocGuard } from '@/lib/labdoc/kiosk-scope'

const ID_RE = /^[a-z0-9]{25}$/
const OPS = ['PAIR', 'UNPAIR', 'AUTO'] as const
type Op = (typeof OPS)[number]
const MAX_LINES = 40
const r2 = (n: number) => Math.round(n * 100) / 100

export async function POST(req: NextRequest, { params }: { params: { id: string; sid: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth
  // ★ KIOSK 只可以處理自己店嘅單（kiosk-scope.ts）
  const kioskDeny = await kioskDocGuard(session, params.id)
  if (kioskDeny) return kioskDeny

  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }
  if (!ID_RE.test(params.id) || !ID_RE.test(params.sid)) {
    return jsonNoStore({ error: 'ID 格式錯誤' }, { status: 400 })
  }

  let body: { op?: string; lineIds?: unknown; lineId?: unknown; costCaseId?: unknown }
  try {
    body = await req.json()
  } catch {
    return jsonNoStore({ error: 'JSON body 缺失' }, { status: 400 })
  }
  const op = body.op as Op
  if (!OPS.includes(op)) return jsonNoStore({ error: 'op 必須係 PAIR／UNPAIR／AUTO' }, { status: 400 })

  let lineIds: string[]
  if (op === 'PAIR') {
    if (!Array.isArray(body.lineIds) || body.lineIds.length === 0 || body.lineIds.length > MAX_LINES) {
      return jsonNoStore({ error: `要揀 1–${MAX_LINES} 行` }, { status: 400 })
    }
    lineIds = [...new Set(body.lineIds as unknown[])].filter((x): x is string => typeof x === 'string' && ID_RE.test(x))
    if (lineIds.length !== body.lineIds.length) return jsonNoStore({ error: '行 ID 格式錯誤或者重複' }, { status: 400 })
    if (typeof body.costCaseId !== 'string' || body.costCaseId.length === 0 || body.costCaseId.length > 40) {
      return jsonNoStore({ error: '要揀一筆成本' }, { status: 400 })
    }
  } else {
    if (typeof body.lineId !== 'string' || !ID_RE.test(body.lineId)) return jsonNoStore({ error: '行 ID 格式錯誤' }, { status: 400 })
    lineIds = [body.lineId]
  }

  const scope = await labdocScope(session, perms)
  if (scope !== null && scope.length === 0) {
    return jsonNoStore({ error: '冇任何診所範圍' }, { status: 403 })
  }

  // —— 載入（防 IDOR）——
  const doc = await prisma.labDocument.findUnique({
    where: { id: params.id },
    select: { id: true, kind: true, status: true, labId: true, statementMonth: true, createdAt: true },
  })
  if (!doc || doc.status === 'VOID' || doc.kind !== 'STATEMENT') {
    return jsonNoStore({ error: '單據唔存在或唔係月結單' }, { status: 404 })
  }
  if (doc.status === 'SUPERSEDED') {
    return jsonNoStore({ error: '呢張月結單已被取代 — 請喺新版處理' }, { status: 409 })
  }
  const section = await prisma.labStatementSection.findFirst({
    where: { id: params.sid, documentId: doc.id },
    select: { id: true, clinicId: true, providerId: true, status: true, sectionIndex: true, resultJson: true },
  })
  if (!section) return jsonNoStore({ error: '分段唔屬於呢張單' }, { status: 404 })
  if (section.status === 'CONFIRMED') {
    return jsonNoStore({ error: '分段已確認 — 唔可以再改' }, { status: 409 })
  }
  if (scope !== null && section.clinicId && !scope.includes(section.clinicId)) {
    return jsonNoStore({ error: '診所唔喺你嘅範圍' }, { status: 403 })
  }
  const dupMsg = await sectionDuplicateBlock(prisma, doc, section)
  if (dupMsg) return jsonNoStore({ error: dupMsg, code: 'SECTION_DUPLICATE' }, { status: 409 })

  const lines = await prisma.labStatementLine.findMany({
    where: { id: { in: lineIds }, sectionId: section.id },
    select: { id: true, amount: true, result: true, resolution: true, pairMode: true, pairCostCaseId: true },
  })
  if (lines.length !== lineIds.length) return jsonNoStore({ error: '行唔屬於呢個分段' }, { status: 404 })

  let targetIds: string[] = []
  let data: { pairMode: string | null; pairCostCaseId: string | null }
  let after: Record<string, unknown>

  if (op === 'PAIR') {
    if (!section.clinicId || !section.providerId || !doc.labId || !doc.statementMonth) {
      return jsonNoStore({ error: '分段未揀齊 Lab／月份／診所／醫生' }, { status: 400 })
    }
    for (const l of lines) {
      if (l.resolution) return jsonNoStore({ error: '有行已經標咗（備貨／唔關我哋事）— 取消標記先' }, { status: 409 })
      if (l.pairMode === 'MANUAL') return jsonNoStore({ error: '有行已經人手配對咗 — 撳「未配對到」拆開先' }, { status: 409 })
      // 要計嘅行（重新對數後 MATCHED／UNPAIRED；$0、付款、舊欠係 NOT_APPLICABLE）
      if (l.result !== 'MATCHED' && l.result !== 'UNPAIRED') return jsonNoStore({ error: '有行唔計入對數（$0／付款／舊欠）— 唔可以配對' }, { status: 400 })
    }
    const costCaseId = body.costCaseId as string
    const cost = await prisma.costCase.findFirst({
      where: { id: costCaseId, ...costScopeWhere({ labId: doc.labId, clinicId: section.clinicId, providerId: section.providerId, month: doc.statementMonth }) },
      select: { id: true, finalCost: true },
    })
    if (!cost) return jsonNoStore({ error: '成本唔喺呢段範圍（同 Lab、同診所、同醫生、同月）' }, { status: 404 })
    if (cost.finalCost == null) return jsonNoStore({ error: '呢筆成本未有價 — 去成本錄入入咗價先' }, { status: 400 })
    const taken = await prisma.labStatementLine.count({
      where: { sectionId: section.id, pairMode: 'MANUAL', pairCostCaseId: cost.id },
    })
    if (taken > 0) return jsonNoStore({ error: '呢筆成本已經人手配對咗其他行 — 拆開先' }, { status: 409 })
    const linesSum = r2(lines.reduce((s, l) => s + Number(l.amount), 0))
    const costAmt = r2(Number(cost.finalCost))
    if (Math.abs(linesSum - costAmt) > 0.01) {
      return jsonNoStore({ error: `唔啱數：揀咗嘅行加埋 $${linesSum}，成本 $${costAmt} — 唔可以配對`, code: 'AMOUNT_MISMATCH' }, { status: 400 })
    }
    targetIds = lines.map((l) => l.id)
    data = { pairMode: 'MANUAL', pairCostCaseId: cost.id }
    after = { op, lineIds: targetIds, costCaseId: cost.id, amount: costAmt }
  } else if (op === 'UNPAIR') {
    const line = lines[0]
    if (line.pairMode === 'MANUAL' && line.pairCostCaseId) {
      // 人手配對：成組（同一筆成本）一齊拆
      const group = await prisma.labStatementLine.findMany({
        where: { sectionId: section.id, pairMode: 'MANUAL', pairCostCaseId: line.pairCostCaseId },
        select: { id: true },
      })
      targetIds = group.map((g) => g.id)
    } else {
      // 自動劃埋：成組（上次對數嘅 pairs）一齊拆；唔喺任何組 → 淨係呢行
      const pairs = (((section.resultJson as any)?.pairs ?? []) as Array<{ costCaseId: string; lineIds: string[] }>)
      const hit = pairs.find((p) => Array.isArray(p.lineIds) && p.lineIds.includes(line.id))
      const ids = hit ? hit.lineIds.filter((x) => typeof x === 'string') : [line.id]
      const own = await prisma.labStatementLine.findMany({ where: { id: { in: ids }, sectionId: section.id }, select: { id: true } })
      targetIds = own.map((g) => g.id)
    }
    data = { pairMode: 'NONE', pairCostCaseId: null }
    after = { op, lineIds: targetIds, fromCostCaseId: line.pairCostCaseId ?? null }
  } else {
    const line = lines[0]
    if (line.pairMode !== 'NONE') return jsonNoStore({ error: '呢行冇標「未配對到」' }, { status: 409 })
    targetIds = [line.id]
    data = { pairMode: null, pairCostCaseId: null }
    after = { op, lineIds: targetIds }
  }

  await prisma.labStatementLine.updateMany({ where: { id: { in: targetIds }, sectionId: section.id }, data })

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null
  await labdocAudit({
    action: 'LAB_STATEMENT_PAIR',
    entity: 'LabStatementSection',
    entityId: section.id,
    clinicId: section.clinicId,
    actorId: session.userId,
    ipAddress: ip,
    userAgent: ua,
    notes: `${op}：${targetIds.length} 行（doc ${doc.id}，段 ${section.sectionIndex}）`,
    after,
  })

  const r = await reconcileSection(prisma, { sectionId: section.id, actorId: session.userId, source: 'manual', ipAddress: ip, userAgent: ua })
  return NextResponse.json({
    ok: true,
    op,
    updated: targetIds.length,
    reconcile: r.ok ? { status: r.sectionStatus, statementTotal: r.statementTotal, costTotal: r.costTotal, diff: r.diff } : { error: r.message, code: r.code },
  })
}
