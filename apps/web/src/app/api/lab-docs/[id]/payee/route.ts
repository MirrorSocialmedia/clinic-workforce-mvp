// ★ cwm-labdoc P2 CHUNK 5：POST /api/lab-docs/:id/payee — §11 記住收款人／標記可疑
//
// NEW_PAYEE（§9）：payeeIsNew=true（認到 Lab 而 payee 唔喺 PAYEE alias）→ lab_statement：
//   - 「記住」（P2 實作）：upsert LabAlias(PAYEE, rawNorm=normLabName(payeeRaw))＋ doc.payeeIsNew=false
//   - 「標記可疑」：spec 有列但 schema 冇對應欄（P2 禁令：schema 改動報 CEO）→ 400 明示
// 權限：lab_statement（§10.2 記住收款人）
// 版本守衛：optimistic lock（version）— 0 row = 409
// audit：LAB_DOC_PAYEE（sensitive-audit SPEC 已有）
// ownership-ok: labdoc 全集團範圍（B16）；寫入前驗證文件存在＋未 VOID＋scope
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'
import { normLabName } from '@/lib/labdoc/identify'
import { labdocAudit } from '@/lib/labdoc/audit'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }

  let body: { version?: number; action?: string }
  try {
    body = await req.json()
  } catch {
    return jsonNoStore({ error: 'JSON body 缺失' }, { status: 400 })
  }
  const { version, action = 'remember' } = body
  if (action !== 'remember' && action !== 'suspicious') {
    return jsonNoStore({ error: 'action 只接 remember／suspicious' }, { status: 400 })
  }
  if (action === 'suspicious') {
    return jsonNoStore({ error: '「標記可疑」P2 未實作（schema 冇對應欄）— 請聯絡系統管理員' }, { status: 400 })
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return jsonNoStore({ error: 'version 必須係非負整數（optimistic lock）' }, { status: 400 })
  }

  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return jsonNoStore({ error: '冇任何診所範圍' }, { status: 403 })
  }

  const doc = await prisma.labDocument.findUnique({
    where: { id: params.id },
    select: {
      id: true, labId: true, clinicId: true, payeeRaw: true, payeeIsNew: true, status: true, version: true,
    },
  })
  if (!doc || doc.status === 'VOID') {
    return jsonNoStore({ error: '單據唔存在或已作廢' }, { status: 404 })
  }
  if (scope !== null && (!doc.clinicId || !scope.includes(doc.clinicId))) {
    return jsonNoStore({ error: '單據唔喺你嘅範圍' }, { status: 403 })
  }
  if (doc.version !== version) {
    return jsonNoStore({ error: '版本衝突（單據已更新）— 請重讀' }, { status: 409 })
  }
  if (!doc.payeeRaw || doc.payeeRaw.trim() === '') {
    return jsonNoStore({ error: '單據冇 payeeRaw，唔可以記住' }, { status: 400 })
  }
  if (!doc.labId) {
    return jsonNoStore({ error: '未識別 Lab，唔可以把收款人記入某間 Lab（先確認頭部）' }, { status: 400 })
  }

  const rawNorm = normLabName(doc.payeeRaw)
  if (!rawNorm) {
    return jsonNoStore({ error: 'payeeRaw 正規化後為空' }, { status: 400 })
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null

  // (kind, rawNorm) 全域唯一 — 已被另一間 Lab 佔用 = 衝突（需老細決定歸邊間）
  const existing = await prisma.labAlias.findFirst({ where: { kind: 'PAYEE', rawNorm } })
  if (existing && existing.labId !== doc.labId) {
    return jsonNoStore({ error: 'PAYEE_ALIAS_CONFLICT：呢個收款人已記喺另一間 Lab（需老細決定歸邊間）' }, { status: 409 })
  }

  let aliasCreated = false
  if (!existing) {
    await prisma.labAlias.create({
      data: { labId: doc.labId, kind: 'PAYEE', rawNorm, createdBy: session.userId },
    })
    aliasCreated = true
  }

  const upd = await prisma.labDocument.updateMany({
    where: { id: params.id, version, payeeIsNew: true },
    data: { payeeIsNew: false, version: { increment: 1 } },
  })
  if (upd.count === 0) {
    // alias 已寫但 doc 未更新（並發 resolve）— 回滚呢次新建嘅 alias 保持原子口徑
    if (aliasCreated) {
      await prisma.labAlias.deleteMany({ where: { labId: doc.labId, kind: 'PAYEE', rawNorm } }).catch(() => undefined)
    }
    return jsonNoStore({ error: '版本衝突（單據已更新）— 請重讀' }, { status: 409 })
  }

  await labdocAudit({
    action: 'LAB_DOC_PAYEE',
    entity: 'LabDocument',
    entityId: params.id,
    clinicId: doc.clinicId,
    actorId: session.userId,
    ipAddress: ip,
    userAgent: ua,
    notes: aliasCreated ? 'remember' : 'already-alias',
    before: { payeeIsNew: true, payeeRaw: doc.payeeRaw },
    after: { payeeIsNew: false, aliasRawNorm: rawNorm, aliasCreated },
  })
  return NextResponse.json({ ok: true, id: params.id, aliasCreated })
}
