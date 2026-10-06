// ★ cwm-labdoc P4 CHUNK 1：GET/PUT /api/lab-profiles/:labId — §12.6 Lab 設定（lab_statement）
//
// GET：LabProfile（冇 row → schema 預設值 + exists:false）＋已知收款人（LabAlias kind=PAYEE）。
// PUT：partial update
//   - statementKind（DETAIL | INVOICE_LIST | OUTSTANDING）
//   - statementDocNoSameAsInvoice（月結單單號同 invoice 一樣？）
//   - defaultDocNoKind（INVOICE_NO | CASE_NO）
//   - extractionHint（≤500 字，加入讀單 prompt；null = 清除）
//   - payees（string[]：已知收款人全量清單 — 正規化後與 LabAlias(kind=PAYEE) 對齊）
// 守門：
//   - 400：id 格式／枚舉／hint 超 500／payee 格式／updatedAt 缺失
//   - 404：Lab 唔存在
//   - 409：optimistic lock（updatedAt 唔等 / 無 row 但帶 updatedAt / 並發 create P2002）；
//          PAYEE_ALIAS_CONFLICT（收款人已被另一間 Lab 佔用 — (kind='PAYEE',rawNorm) 全域唯一口徑）
// 審計：LAB_PROFILE_UPDATE（before/after = 四設定欄＋payees 清單；零病人姓名）
// 權限：lab_statement（§10.2「Lab 設定」）— RBAC_MATRIX + RBAC_PERM_OVERRIDES 雙登記
// ownership-ok: LabProfile 係 Lab 維度（全集團）設定，冇 clinicId；Lab 存在性 = 資源驗證
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { labdocAudit } from '@/lib/labdoc/audit'
import { normLabName } from '@/lib/labdoc/identify'

const STATEMENT_KINDS = ['DETAIL', 'INVOICE_LIST', 'OUTSTANDING'] as const
const DOC_NO_KINDS = ['INVOICE_NO', 'CASE_NO'] as const
const HINT_MAX = 500
const PAYEE_MAX = 120
const PAYEE_LIST_MAX = 50
const LAB_ID_RE = /^[a-z0-9]{25}$/

// LabProfile schema 預設值（§3）— GET 冇 row 時回呢套，UI 唔需要特判
const DEFAULTS = {
  statementKind: 'INVOICE_LIST',
  statementDocNoSameAsInvoice: true,
  defaultDocNoKind: 'INVOICE_NO',
  extractionHint: null as string | null,
}

class ConflictError extends Error {
  constructor(public readonly msg: string) {
    super(msg)
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 解析 payees 欄位 → 正規化清單；返回 { list } 或 { error }。 */
function parsePayees(v: unknown): { list?: string[]; error?: string } {
  if (!Array.isArray(v)) return { error: 'payees 必須係 string[]' }
  if (v.length > PAYEE_LIST_MAX) return { error: `payees 最多 ${PAYEE_LIST_MAX} 項` }
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of v) {
    if (typeof item !== 'string') return { error: 'payees 必須全部係 string' }
    const t = item.trim()
    if (t.length > PAYEE_MAX) return { error: 'payee 單一項超過 120 字' }
    if (t === '') continue
    const n = normLabName(t)
    if (!n) return { error: 'payee 正規化後為空' }
    if (!seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  return { list: out }
}

function shapeProfile(labId: string, labName: string, row: unknown, payees: string[]) {
  const r = isRecord(row) ? row : null
  return {
    labId,
    labName,
    exists: r !== null,
    statementKind: r?.statementKind ?? DEFAULTS.statementKind,
    statementDocNoSameAsInvoice: r?.statementDocNoSameAsInvoice ?? DEFAULTS.statementDocNoSameAsInvoice,
    defaultDocNoKind: r?.defaultDocNoKind ?? DEFAULTS.defaultDocNoKind,
    extractionHint: r?.extractionHint ?? DEFAULTS.extractionHint,
    updatedBy: r?.updatedBy ?? null,
    updatedAt: r ? new Date(r.updatedAt as number | string | Date).toISOString() : null,
    payees,
  }
}

async function GET(req: NextRequest, { params }: { params: { labId: string } }) {
  const { labId } = params
  // 格式檢查喺 auth 前（malformed input fail-fast；RBAC normalizeRoute 對短 id/hyphen id 會 403，咁就唔對）
  if (!LAB_ID_RE.test(labId)) return jsonNoStore({ error: 'labId 格式錯誤' }, { status: 400 })

  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { perms } = auth
  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }

  const lab = await prisma.lab.findUnique({ where: { id: labId }, select: { id: true, name: true } })
  if (!lab) return jsonNoStore({ error: 'Lab 唔存在' }, { status: 404 })

  const [row, payeeRows] = await Promise.all([
    prisma.labProfile.findUnique({ where: { labId } }),
    prisma.labAlias.findMany({
      where: { labId, kind: 'PAYEE' },
      select: { rawNorm: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  return jsonNoStore(shapeProfile(labId, lab.name, row, payeeRows.map((p) => p.rawNorm)))
}

async function PUT(req: NextRequest, { params }: { params: { labId: string } }) {
  const { labId } = params
  // 格式檢查喺 auth 前（同 GET — 見 header route 先例）
  if (!LAB_ID_RE.test(labId)) return jsonNoStore({ error: 'labId 格式錯誤' }, { status: 400 })

  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth
  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return jsonNoStore({ error: 'JSON body 缺失' }, { status: 400 })
  }
  if (!isRecord(body)) return jsonNoStore({ error: 'body 必須係 object' }, { status: 400 })

  // optimistic lock：updatedAt 必填（null = 客戶端睇到冇 row；string = 客戶端快照 ISO）
  if (!('updatedAt' in body)) return jsonNoStore({ error: 'updatedAt 必填（optimistic lock）' }, { status: 400 })
  const expRaw = body.updatedAt
  let exp: Date | null
  if (expRaw === null) {
    exp = null
  } else if (typeof expRaw === 'string') {
    exp = new Date(expRaw)
    if (Number.isNaN(exp.getTime())) return jsonNoStore({ error: 'updatedAt 格式錯誤（要 ISO 8601）' }, { status: 400 })
  } else {
    return jsonNoStore({ error: 'updatedAt 必須係 ISO 8601 string 或 null' }, { status: 400 })
  }

  // 逐欄驗證（key 唔存在 = 唔改）
  const data: {
    statementKind?: string
    statementDocNoSameAsInvoice?: boolean
    defaultDocNoKind?: string
    extractionHint?: string | null
    updatedBy: string
  } = { updatedBy: session.userId }
  if ('statementKind' in body) {
    if (typeof body.statementKind !== 'string' || !(STATEMENT_KINDS as readonly string[]).includes(body.statementKind)) {
      return jsonNoStore({ error: 'statementKind 必須係 DETAIL / INVOICE_LIST / OUTSTANDING' }, { status: 400 })
    }
    data.statementKind = body.statementKind
  }
  if ('statementDocNoSameAsInvoice' in body) {
    if (typeof body.statementDocNoSameAsInvoice !== 'boolean') {
      return jsonNoStore({ error: 'statementDocNoSameAsInvoice 必須係 boolean' }, { status: 400 })
    }
    data.statementDocNoSameAsInvoice = body.statementDocNoSameAsInvoice
  }
  if ('defaultDocNoKind' in body) {
    if (typeof body.defaultDocNoKind !== 'string' || !(DOC_NO_KINDS as readonly string[]).includes(body.defaultDocNoKind)) {
      return jsonNoStore({ error: 'defaultDocNoKind 必須係 INVOICE_NO / CASE_NO' }, { status: 400 })
    }
    data.defaultDocNoKind = body.defaultDocNoKind
  }
  if ('extractionHint' in body) {
    const h = body.extractionHint
    if (h !== null && typeof h !== 'string') return jsonNoStore({ error: 'extractionHint 必須係 string 或 null' }, { status: 400 })
    const ht = typeof h === 'string' ? h.trim() : null
    if (ht !== null && ht.length > HINT_MAX) {
      return jsonNoStore({ error: `extractionHint 超過 ${HINT_MAX} 字` }, { status: 400 })
    }
    data.extractionHint = ht
  }
  let wantPayees: string[] | undefined
  if ('payees' in body) {
    const p = parsePayees(body.payees)
    if (p.error) return jsonNoStore({ error: p.error }, { status: 400 })
    wantPayees = p.list
  }

  const lab = await prisma.lab.findUnique({ where: { id: labId }, select: { id: true, name: true } })
  if (!lab) return jsonNoStore({ error: 'Lab 唔存在' }, { status: 404 })

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null

  type ProfileSnap = {
    statementKind: string
    statementDocNoSameAsInvoice: boolean
    defaultDocNoKind: string
    extractionHint: string | null
    updatedAt: string | null
    payees: string[]
  }
  let result: { before: ProfileSnap; after: ProfileSnap }
  try {
    result = await prisma.$transaction(async (tx) => {
      const row = await tx.labProfile.findUnique({ where: { labId } })
      const existingPayees = await tx.labAlias.findMany({
        where: { labId, kind: 'PAYEE' },
        select: { rawNorm: true },
        orderBy: { createdAt: 'asc' },
      })
      const before: ProfileSnap = row
        ? {
            statementKind: row.statementKind,
            statementDocNoSameAsInvoice: row.statementDocNoSameAsInvoice,
            defaultDocNoKind: row.defaultDocNoKind,
            extractionHint: row.extractionHint,
            updatedAt: new Date(row.updatedAt).toISOString(),
            payees: existingPayees.map((a) => a.rawNorm),
          }
        : { ...DEFAULTS, updatedAt: null, payees: [] }

      if (row) {
        // 客戶端快照同 DB 唔等（或者快照過期）→ 409
        if (!exp || new Date(row.updatedAt).getTime() !== exp.getTime()) {
          throw new ConflictError('版本衝突（設定已更新）— 請重讀')
        }
        const upd = await tx.labProfile.updateMany({
          where: { labId, updatedAt: row.updatedAt },
          data,
        })
        if (upd.count === 0) throw new ConflictError('版本衝突（設定已更新）— 請重讀')
      } else {
        if (exp) throw new ConflictError('版本衝突（設定已建立）— 請重讀')
        try {
          await tx.labProfile.create({
            data: {
              labId,
              statementKind: data.statementKind ?? DEFAULTS.statementKind,
              statementDocNoSameAsInvoice: data.statementDocNoSameAsInvoice ?? DEFAULTS.statementDocNoSameAsInvoice,
              defaultDocNoKind: data.defaultDocNoKind ?? DEFAULTS.defaultDocNoKind,
              extractionHint: data.extractionHint === undefined ? null : data.extractionHint,
              updatedBy: session.userId,
            },
          })
        } catch (e: unknown) {
          // 並發 create：unique(labId) 撞 → 409
          if ((e as { code?: string })?.code === 'P2002') throw new ConflictError('版本衝突（設定已建立）— 請重讀')
          throw e
        }
      }

      // payees 對齊（全量語義：list 入面冇嘅 PAYEE alias 刪除）
      if (wantPayees !== undefined) {
        const cur = new Map(existingPayees.map((a) => [a.rawNorm, a]))
        const wantSet = new Set(wantPayees)
        const toAdd = wantPayees.filter((n) => !cur.has(n))
        if (toAdd.length > 0) {
          const clash = await tx.labAlias.findFirst({
            where: { kind: 'PAYEE', rawNorm: { in: toAdd } },
            select: { rawNorm: true },
          })
          if (clash) {
            throw new ConflictError(`PAYEE_ALIAS_CONFLICT：收款人「${clash.rawNorm}」已記喺另一間 Lab（需老細決定歸邊間）`)
          }
        }
        const toDel = [...cur.keys()].filter((n) => !wantSet.has(n))
        if (toDel.length > 0) {
          await tx.labAlias.deleteMany({ where: { labId, kind: 'PAYEE', rawNorm: { in: toDel } } })
        }
        for (const n of toAdd) {
          await tx.labAlias.create({ data: { labId, kind: 'PAYEE', rawNorm: n, createdBy: session.userId } })
        }
      }

      const finalRow = await tx.labProfile.findUniqueOrThrow({ where: { labId } })
      const finalPayees =
        wantPayees !== undefined ? wantPayees : existingPayees.map((a) => a.rawNorm)
      const after: ProfileSnap = {
        statementKind: finalRow.statementKind,
        statementDocNoSameAsInvoice: finalRow.statementDocNoSameAsInvoice,
        defaultDocNoKind: finalRow.defaultDocNoKind,
        extractionHint: finalRow.extractionHint,
        updatedAt: new Date(finalRow.updatedAt).toISOString(),
        payees: finalPayees,
      }
      return { before, after }
    })
  } catch (e: unknown) {
    if (e instanceof ConflictError) return jsonNoStore({ error: e.msg }, { status: 409 })
    throw e
  }

  await labdocAudit({
    action: 'LAB_PROFILE_UPDATE',
    entity: 'LabProfile',
    entityId: labId,
    actorId: session.userId,
    ipAddress: ip,
    userAgent: ua,
    before: result.before,
    after: result.after,
  })

  return jsonNoStore(
    shapeProfile(labId, lab.name, { ...result.after, updatedAt: new Date(result.after.updatedAt as string), updatedBy: session.userId }, result.after.payees),
  )
}

export { GET, PUT }
