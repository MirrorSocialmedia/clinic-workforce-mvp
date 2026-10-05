// ★ cwm-labdoc P2 §7.8：POST /api/lab-docs/:id/groups/:g/save — 儲存分組（配對／忽略／解除＋改價＋到貨）
//
// 所有狀態變化喺同一個 Serializable transaction（防並發；§7.8 頭部規則）：
//   1. version 樂觀鎖（同 header：request version 唔等於 DB → 409「有人改咗」）
//   2. 行動作（行條件寫；0 行 → 409）：
//        MATCH：costCaseId + linkType（預設 MAIN；B7：同一筆成本 MAIN 只可以嚟自一張單 → 400）
//        IGNORE：ignoreReason 必填（≤60）；已 MATCHED 行要先解除配對
//        UNMATCH：只可以對未出月結（lockedByRunId = null）嘅成本（§7.9）
//   3. 到貨確認（§7.7）：已出月結 → 409
//   4. 改價（§7.5 填入／改做）：linkedSum 由 server 重算（DB 已含今次 MATCH 行）；
//      baseCost = linkedSum、discountPct = null（B4）、finalCost = baseCost、PENDING → PRICED；
//      已出月結 → 409
//   5. labInvoiceLinked 重算（§7.8 step 8）；文件狀態重算（§7.8 step 9，reconcile 單一來源）
//   6. audit：LINE_MATCH / LINE_IGNORE / LINE_UNMATCH / LAB_DOC_PRICE_UPDATE / COST_CASE_UPDATE / LAB_DOC_UPDATE
// 冪等（T4）：write-log.ts（LabDocWriteLog）— 同 key 同 hash → replay；唔同 hash / IN_PROGRESS → 409。
// 權限：lab_invoice（§10.2；角色白名單 OWNER/MANAGER）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'
import {
  matchLine,
  unmatchLine,
  assertNoOtherMain,
  computeLinkedSumDb,
  applyPriceUpdate,
  applyReceivedConfirm,
  recalcLabInvoiceLinked,
  recomputeDocStatus,
  LineTakenError,
  MainTakenError,
  PriceLockedError,
  ReceivedMonthLockedError,
  CostInvalidError,
} from '@/lib/labdoc/cost-actions'
import { acquireWriteLog, completeWriteLog, stableRequestHash } from '@/lib/labdoc/write-log'
import { round2 } from '@/lib/labdoc/reconcile'

const DOC_ID_RE = /^[a-z0-9]{25}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const KEY_RE = /^[a-zA-Z0-9:_-]{1,128}$/
// §3.4：NEEDS_REVIEW = 頭部未確認 — 要 §7.1 確認完（→ CONFIRMED）先可以對數
const SAVING = new Set(['CONFIRMED', 'PARTIAL', 'RECONCILED'])
const LINK_TYPES = new Set(['MAIN', 'SUPPLEMENT', 'REDO'])
const ACTIONS = new Set(['MATCH', 'IGNORE', 'UNMATCH'])
const ROUTE_TAG = 'POST /api/lab-docs/:id/groups/:g/save'

interface InLineAction {
  lineId: string
  action: string
  costCaseId: string | null
  linkType: string | null
  ignoreReason: string | null
  receivedAt: string | null | undefined
}

function parseActions(raw: unknown): { actions: InLineAction[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'lines 必須係陣列' }
  const out: InLineAction[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) return { error: 'lines 格式錯誤' }
    if (typeof r.lineId !== 'string' || !DOC_ID_RE.test(r.lineId)) return { error: 'lineId 格式錯誤' }
    if (seen.has(r.lineId)) return { error: '同一 lineId 出現兩次' }
    seen.add(r.lineId)
    if (typeof r.action !== 'string' || !ACTIONS.has(r.action)) return { error: 'action 必須係 MATCH / IGNORE / UNMATCH' }
    let costCaseId: string | null = null
    if (r.costCaseId !== undefined && r.costCaseId !== null) {
      if (typeof r.costCaseId !== 'string' || !DOC_ID_RE.test(r.costCaseId)) return { error: 'costCaseId 格式錯誤' }
      costCaseId = r.costCaseId
    }
    let linkType: string | null = null
    if (r.linkType !== undefined && r.linkType !== null) {
      if (typeof r.linkType !== 'string' || !LINK_TYPES.has(r.linkType)) return { error: 'linkType 必須係 MAIN / SUPPLEMENT / REDO' }
      linkType = r.linkType
    }
    let ignoreReason: string | null = null
    if (r.ignoreReason !== undefined && r.ignoreReason !== null) {
      if (typeof r.ignoreReason !== 'string' || r.ignoreReason.trim().length === 0 || r.ignoreReason.trim().length > 60) {
        return { error: 'ignoreReason 必填（1–60 字）' }
      }
      ignoreReason = r.ignoreReason.trim()
    }
    let receivedAt: string | null | undefined
    if (r.receivedAt !== undefined) {
      if (r.receivedAt !== null) {
        if (typeof r.receivedAt !== 'string' || !DATE_RE.test(r.receivedAt)) return { error: 'receivedAt 格式錯誤（YYYY-MM-DD 或 null）' }
        receivedAt = r.receivedAt
      } else {
        receivedAt = null
      }
    }
    // 動作級驗證
    if (r.action === 'MATCH' && costCaseId === null) return { error: 'MATCH 要帶 costCaseId' }
    if (r.action === 'IGNORE' && ignoreReason === null) return { error: 'IGNORE 要帶 ignoreReason（1–60 字）' }
    if (r.action === 'UNMATCH' && costCaseId === null) return { error: 'UNMATCH 要帶 costCaseId（而家連住嗰筆）' }
    out.push({ lineId: r.lineId, action: r.action, costCaseId, linkType, ignoreReason, receivedAt })
  }
  return { actions: out }
}

export async function POST(req: NextRequest, { params }: { params: { id: string; g: string } }) {
  const { id, g } = params
  if (!DOC_ID_RE.test(id)) return NextResponse.json({ error: '單據 ID 格式錯誤' }, { status: 400 })
  const groupIndex = Number(g)
  if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > 10) {
    return NextResponse.json({ error: '分組編號格式錯誤' }, { status: 400 })
  }

  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return NextResponse.json({ error: '冇任何診所範圍，唔可以儲存對數' }, { status: 403 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '請求 body 格式錯誤' }, { status: 400 })
  }
  if (typeof body !== 'object' || body === null) return NextResponse.json({ error: '請求 body 格式錯誤' }, { status: 400 })

  const version = body.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return NextResponse.json({ error: 'version 必填（整數）' }, { status: 400 })
  }
  const idempotencyKey: string = body.idempotencyKey
  if (!KEY_RE.test(idempotencyKey ?? '')) {
    return NextResponse.json({ error: 'idempotencyKey 缺失或格式錯誤' }, { status: 400 })
  }
  const pa = parseActions(body.lines)
  if ('error' in pa) return NextResponse.json({ error: pa.error }, { status: 400 })
  const actions = pa.actions
  if (actions.length === 0) return NextResponse.json({ error: '冇任何動作要儲存（lines 至少 1 條）' }, { status: 400 })
  let priceUpdates: Array<{ costCaseId: string }> = []
  if (body.priceUpdates !== undefined) {
    if (!Array.isArray(body.priceUpdates)) return NextResponse.json({ error: 'priceUpdates 必須係陣列' }, { status: 400 })
    const seen = new Set<string>()
    for (const p of body.priceUpdates) {
      if (typeof p !== 'object' || p === null || typeof p.costCaseId !== 'string' || !DOC_ID_RE.test(p.costCaseId)) {
        return NextResponse.json({ error: 'priceUpdates 格式錯誤' }, { status: 400 })
      }
      if (seen.has(p.costCaseId)) return NextResponse.json({ error: 'priceUpdates 同一成本出現兩次' }, { status: 400 })
      seen.add(p.costCaseId)
      priceUpdates.push({ costCaseId: p.costCaseId })
    }
  }

  // —— 載入文件 ——
  const doc = await prisma.labDocument.findUnique({ where: { id }, include: { lines: { where: { groupIndex } } } })
  if (!doc || doc.id !== id) return NextResponse.json({ error: '單據唔存在' }, { status: 404 })
  if (scope !== null && !(doc.clinicId && scope.includes(doc.clinicId))) {
    return NextResponse.json({ error: '單據唔存在' }, { status: 404 })
  }
  if (doc.kind !== 'INVOICE') {
    return NextResponse.json({ error: '月結單對數屬 P3 範圍；而家只可以對 INVOICE' }, { status: 400 })
  }
  if (!SAVING.has(doc.status)) {
    return NextResponse.json({ error: `單據狀態 ${doc.status} 未可以對數（要先確認頭部）` }, { status: 400 })
  }
  const byLineId = new Map(doc.lines.map((l: any) => [l.id, l]))
  for (const a of actions) {
    if (!byLineId.has(a.lineId)) return NextResponse.json({ error: `lineId 唔屬於分組 ${groupIndex}` }, { status: 400 })
  }
  // §7.8 step 2 / T12：分組病人編號（行可能冇 code — null = 唔校驗）；
  // 成本引用（MATCH/UNMATCH/改價/到貨）入 transaction 逐個 guard（同 Lab＋patientCodeNorm＋scope）。
  const groupPatientCode: string | null =
    (doc.lines as any[]).map((l) => l.patientCode).find((pc) => pc !== null && pc !== undefined) ?? null

  // —— 冪等 acquire（T4）——
  const requestHash = stableRequestHash({
    docId: id,
    groupIndex,
    version,
    lines: actions.map((a) => ({
      lineId: a.lineId,
      action: a.action,
      costCaseId: a.costCaseId,
      linkType: a.linkType,
      ignoreReason: a.ignoreReason,
      receivedAt: a.receivedAt,
    })),
    priceUpdates: priceUpdates.map((p) => p.costCaseId),
  })
  const acquired = await acquireWriteLog(idempotencyKey, ROUTE_TAG, requestHash, session.userId)
  if (acquired.kind === 'replay') {
    return NextResponse.json({ ...(acquired.response as object), replayed: true }, { status: 200 })
  }
  if (acquired.kind === 'conflict') {
    return NextResponse.json(
      { error: acquired.reason === 'hash_mismatch' ? 'idempotencyKey 已用过但內容唔同 — 請用新 key' : '同一儲存請求正在處理中 — 請用新 key' },
      { status: 409 },
    )
  }

  try {
    const runTx = async (tx: any) => {
        // —— version 樂觀鎖 ——
        const claim = await tx.labDocument.updateMany({
          where: { id: doc.id, version },
          data: { version: { increment: 1 } },
        })
        if (claim.count === 0) {
          const lastActorId: string | null = doc.confirmedBy ?? doc.uploadedBy
          const actor = lastActorId ? await tx.user.findUnique({ where: { id: lastActorId }, select: { name: true } }) : null
          throw new SaveClaimError(`呢張單啱啱被 ${actor?.name ?? '其他人'} 改咗，請重新載入`)
        }

        // §7.8 step 2 / T12（IDOR）：引用嘅成本必須同呢張單 Lab＋patientCodeNorm 匹配＋喺用戶 scope
        const guardCost = async (ccId: string, patientCode: string | null): Promise<string | null> => {
          const cc = await tx.costCase.findUnique({
            where: { id: ccId },
            select: { id: true, status: true, labId: true, clinicId: true, patientCodeNorm: true },
          })
          if (!cc) return '成本唔存在'
          if (cc.status === 'VOID') return '成本已作廢，唔可以再連'
          if (doc.labId !== null && cc.labId !== doc.labId) return '成本唔屬於呢張單嘅 Lab — 唔可以配對'
          if (patientCode !== null && cc.patientCodeNorm !== patientCode) return '病人編號同分組唔匹配 — 請重新揀成本'
          if (scope !== null && !(cc.clinicId && scope.includes(cc.clinicId))) return '成本唔喺你嘅診所範圍'
          return null
        }

        const touchedCosts: string[] = []
        const savedLines: Array<{ lineId: string; status: string; costCaseId: string | null; linkType: string | null }> = []

        // —— 行動作 ——
        for (const a of actions) {
          const line = byLineId.get(a.lineId)!
          if (a.action === 'MATCH') {
            // T12：同 Lab＋patientCodeNorm 匹配＋scope（fail → 400，零寫入）
            const gerr = await guardCost(a.costCaseId as string, (line.patientCode as string | null | undefined) ?? null)
            if (gerr) return { fail: { status: 400, error: gerr } }
            const lt: 'MAIN' | 'SUPPLEMENT' | 'REDO' = (a.linkType ?? 'MAIN') as 'MAIN' | 'SUPPLEMENT' | 'REDO'
            if (lt === 'MAIN') await assertNoOtherMain(tx, { costCaseId: a.costCaseId as string, docId: doc.id })
            await matchLine(tx, { lineId: a.lineId, costCaseId: a.costCaseId as string, linkType: lt, actorId: session.userId })
            await tx.auditLog.create({
              data: {
                actorId: session.userId,
                action: 'LAB_DOC_LINE_MATCH',
                entity: 'LabDocument',
                entityId: doc.id,
                clinicId: doc.clinicId,
                beforeJson: JSON.stringify({ lineId: a.lineId, status: line.status, costCaseId: line.costCaseId }),
                afterJson: JSON.stringify({ lineId: a.lineId, status: 'MATCHED', costCaseId: a.costCaseId, linkType: lt }),
                notes: `配對行 → 成本（分組 ${groupIndex}，${lt}）`,
              },
            })
            touchedCosts.push(a.costCaseId as string)
            savedLines.push({ lineId: a.lineId, status: 'MATCHED', costCaseId: a.costCaseId as string, linkType: lt })
          } else if (a.action === 'IGNORE') {
            if (line.status === 'MATCHED') {
              return { fail: { status: 409, error: '行而家連緊成本 — 要先解除配對（UNMATCH）先可以標忽略' } }
            }
            const r = await tx.labDocumentLine.updateMany({
              where: { id: a.lineId, status: { in: ['UNMATCHED', 'IGNORED'] } },
              data: { status: 'IGNORED', ignoreReason: a.ignoreReason, costCaseId: null, linkType: null, matchedBy: null, matchedAt: null },
            })
            if (r.count === 0) return { fail: { status: 409, error: '行狀態啱啱被改咗 — 請重新載入再試' } }
            await tx.auditLog.create({
              data: {
                actorId: session.userId,
                action: 'LAB_DOC_LINE_IGNORE',
                entity: 'LabDocument',
                entityId: doc.id,
                clinicId: doc.clinicId,
                beforeJson: JSON.stringify({ lineId: a.lineId, status: line.status }),
                afterJson: JSON.stringify({ lineId: a.lineId, status: 'IGNORED', ignoreReason: a.ignoreReason }),
                notes: `忽略行（分組 ${groupIndex}）`,
              },
            })
            savedLines.push({ lineId: a.lineId, status: 'IGNORED', costCaseId: null, linkType: null })
          } else {
            // UNMATCH
            const cc = await tx.costCase.findUnique({
              where: { id: a.costCaseId as string },
              select: { id: true, lockedByRunId: true, status: true, labId: true, clinicId: true },
            })
            if (!cc) return { fail: { status: 400, error: '成本唔存在' } }
            if (cc.status === 'VOID') return { fail: { status: 400, error: '成本已作廢' } }
            // T12：同 Lab＋scope（行已經連住呢筆成本 — 唔重校病人）
            if (doc.labId !== null && cc.labId !== doc.labId) {
              return { fail: { status: 400, error: '成本唔屬於呢張單嘅 Lab — 唔可以解除配對' } }
            }
            if (scope !== null && !(cc.clinicId && scope.includes(cc.clinicId))) {
              return { fail: { status: 400, error: '成本唔喺你嘅診所範圍' } }
            }
            if (cc.lockedByRunId != null) {
              return { fail: { status: 409, error: '成本已出月結 — 唔可以解除配對（要喺月結單期內處理）' } }
            }
            if (line.status !== 'MATCHED' || line.costCaseId !== cc.id) {
              return { fail: { status: 409, error: '行而家唔係連緊呢筆成本 — 請重新載入再試' } }
            }
            await unmatchLine(tx, { lineId: a.lineId, expectedCostCaseId: cc.id, actorId: session.userId })
            await tx.auditLog.create({
              data: {
                actorId: session.userId,
                action: 'LAB_DOC_LINE_UNMATCH',
                entity: 'LabDocument',
                entityId: doc.id,
                clinicId: doc.clinicId,
                beforeJson: JSON.stringify({ lineId: a.lineId, status: 'MATCHED', costCaseId: cc.id }),
                afterJson: JSON.stringify({ lineId: a.lineId, status: 'UNMATCHED' }),
                notes: `解除配對（分組 ${groupIndex}）`,
              },
            })
            savedLines.push({ lineId: a.lineId, status: 'UNMATCHED', costCaseId: null, linkType: null })
          }
          // 到貨確認（行級；同成本只算一次）
          if (a.receivedAt !== undefined && a.costCaseId) {
            touchedCosts.push(a.costCaseId)
          }
        }

        // —— 到貨確認（§7.7；去重）——
        const recvMap = new Map<string, string | null>()
        const recvPatient = new Map<string, string | null>()
        for (const a of actions) {
          if (a.receivedAt !== undefined && a.costCaseId) {
            if (recvMap.has(a.costCaseId) && recvMap.get(a.costCaseId) !== a.receivedAt) {
              return { fail: { status: 400, error: '同一成本收到兩個唔同到貨日' } }
            }
            recvMap.set(a.costCaseId, a.receivedAt)
            if (!recvPatient.has(a.costCaseId)) {
              recvPatient.set(a.costCaseId, (byLineId.get(a.lineId)?.patientCode as string | null | undefined) ?? groupPatientCode)
            }
          }
        }
        for (const [costCaseId, receivedAt] of recvMap) {
          // T12：到貨確認嘅成本都要過同 Lab／病人／scope
          const gerr = await guardCost(costCaseId, recvPatient.get(costCaseId) ?? null)
          if (gerr) return { fail: { status: 400, error: `到貨確認：${gerr}` } }
          await applyReceivedConfirm(tx, {
            costCaseId,
            receivedAt: receivedAt ? new Date(`${receivedAt}T00:00:00Z`) : null,
            actorId: session.userId,
            docId: doc.id,
          })
        }

        // —— 改價（§7.5；linkedSum 由 DB 重算，已含今次 MATCH 行）——
        for (const p of priceUpdates) {
          const cc = await tx.costCase.findUnique({
            where: { id: p.costCaseId },
            select: { id: true, lockedByRunId: true, status: true, clinicId: true, labId: true, patientCodeNorm: true },
          })
          if (!cc) return { fail: { status: 400, error: '改價：成本唔存在' } }
          if (cc.status === 'VOID') return { fail: { status: 400, error: '改價：成本已作廢' } }
          // T12：改價都限呢張單 Lab＋呢個分組病人＋scope
          if (doc.labId !== null && cc.labId !== doc.labId) {
            return { fail: { status: 400, error: '改價：成本唔屬於呢張單嘅 Lab' } }
          }
          if (groupPatientCode !== null && cc.patientCodeNorm !== groupPatientCode) {
            return { fail: { status: 400, error: '改價：病人編號同分組唔匹配' } }
          }
          if (scope !== null && !(cc.clinicId && scope.includes(cc.clinicId))) {
            return { fail: { status: 400, error: '改價：成本唔喺你嘅診所範圍' } }
          }
          if (cc.lockedByRunId != null) {
            return { fail: { status: 409, error: '成本已出月結 — 唔可以改價（要喺月結單期內處理）' } }
          }
          const linkedSum = round2(await computeLinkedSumDb(tx, { costCaseId: cc.id, pendingAmounts: [] }))
          const lineIds = (await tx.labDocumentLine.findMany({
            where: { costCaseId: cc.id, status: 'MATCHED', documentId: doc.id },
            select: { id: true },
          })) as Array<{ id: string }>
          await applyPriceUpdate(tx, {
            costCaseId: cc.id,
            newAmount: linkedSum,
            docId: doc.id,
            lineIds: lineIds.map((l) => l.id),
            actorId: session.userId,
            clinicId: cc.clinicId,
          })
          touchedCosts.push(cc.id)
        }

        // —— labInvoiceLinked 重算（step 8）＋ 文件狀態重算（step 9）——
        await recalcLabInvoiceLinked(tx, touchedCosts)
        const status = await recomputeDocStatus(tx, { docId: doc.id, actorId: session.userId })
        await tx.labDocument.update({ where: { id: doc.id }, data: { version: doc.version + 1 } })

        return { ok: { status, savedLines } }
    }
    // §7.8：撞 serialization error 重試 2 次（Prisma P2010 + PGSQL 40001 — 2026-10-05 實測）
    let result: any
    for (let serAttempt = 0; ; serAttempt++) {
      try {
        result = await prisma.$transaction(runTx, { isolationLevel: 'Serializable', timeout: 60_000 })
        break
      } catch (e: any) {
        const isSerialization = e?.code === 'P2010' && e?.meta?.code === '40001'
        if (isSerialization && serAttempt < 2) continue
        throw e
      }
    }

    if ('fail' in result) {
      return NextResponse.json({ error: (result as any).fail.error }, { status: (result as any).fail.status })
    }
    const { status, savedLines } = (result as any).ok
    const resp = {
      docId: doc.id,
      groupIndex,
      version: doc.version + 1,
      status,
      lines: savedLines,
    }
    await completeWriteLog(idempotencyKey, resp)
    return jsonNoStore(resp)
  } catch (e: any) {
    if (e instanceof SaveClaimError) return NextResponse.json({ error: e.message }, { status: 409 })
    if (e instanceof LineTakenError) {
      return NextResponse.json({ error: '行已連咗其他成本（同時被改）— 請重新載入再試' }, { status: 409 })
    }
    if (e instanceof MainTakenError) {
      return NextResponse.json({ error: `呢筆成本嘅主單已經係 ${e.message.split(':')[1] ?? '其他單'} — 補收費／重做先可以連佢` }, { status: 400 })
    }
    if (e instanceof PriceLockedError) {
      return NextResponse.json({ error: '成本已出月結 — 唔可以改價／到貨日' }, { status: 409 })
    }
    if (e instanceof ReceivedMonthLockedError) {
      // §7.7/T3：到貨日落喺已 LOCKED 月（醫生×診所×月）
      return NextResponse.json({ error: `${e.message.split(':')[1]} 已出月結，唔可以填呢個到貨日` }, { status: 409 })
    }
    if (e instanceof CostInvalidError) return NextResponse.json({ error: e.message }, { status: 400 })
    console.error('[labdoc] group save failed', { docId: id, groupIndex, err: e?.message })
    return NextResponse.json({ error: '儲存失敗，請重試' }, { status: 500 })
  }
}

class SaveClaimError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SaveClaimError'
  }
}
