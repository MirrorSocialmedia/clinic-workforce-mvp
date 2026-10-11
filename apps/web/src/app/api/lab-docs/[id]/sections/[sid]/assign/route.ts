// ★ cwm-labdoc P3：POST /api/lab-docs/:id/sections/:sid/assign — §8.1 揀分段診所／醫生（可「記住」）
//
// NEEDS_ASSIGN 分段：經理揀診所／醫生（下拉）。body：
//   { clinicId?, providerId?, rememberClinic?, rememberProvider?, overwrite?, version }
// - 只寫傳入嘅邊（clinic／provider 可以分開揀）
// - 「記住」（§6.2.7／§6.3.4，alias 學習）：
//   - clinic：customerNoRaw＋labId → upsert LabCustomerNo；clinicRaw → upsert ClinicNameAlias
//   - provider：doctorRaw → upsert ProviderNameAlias
//   - 已存在 alias 指向唔同目標 → 409 ALIAS_CONFLICT（UI 確認後 overwrite=true 重試）
// - 兩邊齊 → 分段 PENDING；全部分段齊 → 文件 NEEDS_REVIEW → IN_PROGRESS（§3.4）
// - 改返（已指派嘅診所／醫生換第二個）→ 舊配對＋差異處理清走再自動重新配對
// - { unassign: true, version } → 解除指派：診所／醫生清空、分段 NEEDS_ASSIGN、文件 IN_PROGRESS → NEEDS_REVIEW
// - 已確認分段唔改；有行「以月結單為準」改咗系統 → 擋（statement-reset.ts）
// 權限：lab_statement（§10.2：月結單分段識別）
// 版本守衛：doc.version optimistic lock
// audit：LAB_STATEMENT_SECTION_ASSIGN（SPEC）＋ alias 寫入 LAB_ALIAS_LEARN（SPEC）
// ownership-ok: labdoc 全集團範圍（B16）；section 必屬呢個 doc（防 IDOR）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'
import { normClinicName, normCustomerNo, normDoctor } from '@/lib/labdoc/identify'
import { labdocAudit } from '@/lib/labdoc/audit'
import { autoReconcileIfReady } from '@/lib/labdoc/statement-reconcile'
import { resetSectionMatching, sectionsWithSystemChange, SYSTEM_CHANGE_BLOCK_MSG } from '@/lib/labdoc/statement-reset'

const SECTION_ID_RE = /^[a-z0-9]{25}$/
const DOC_ID_RE = /^[a-z0-9]{25}$/

export async function POST(req: NextRequest, { params }: { params: { id: string; sid: string } }) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }
  if (!DOC_ID_RE.test(params.id) || !SECTION_ID_RE.test(params.sid)) {
    return jsonNoStore({ error: 'ID 格式錯誤' }, { status: 400 })
  }

  let body: {
    clinicId?: string | null
    providerId?: string | null
    rememberClinic?: boolean
    rememberProvider?: boolean
    overwrite?: boolean
    unassign?: boolean
    version?: number
  }
  try {
    body = await req.json()
  } catch {
    return jsonNoStore({ error: 'JSON body 缺失' }, { status: 400 })
  }
  const { clinicId = null, providerId = null, rememberClinic = false, rememberProvider = false, overwrite = false, unassign = false, version } = body
  if (!unassign && clinicId === null && providerId === null) {
    return jsonNoStore({ error: 'clinicId／providerId 至少要傳一個' }, { status: 400 })
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
    select: { id: true, kind: true, status: true, version: true, clinicId: true, labId: true, sections: { select: { id: true } } },
  })
  if (!doc || doc.status === 'VOID') {
    return jsonNoStore({ error: '單據唔存在或已作廢' }, { status: 404 })
  }
  if (doc.kind !== 'STATEMENT') {
    return jsonNoStore({ error: '呢張單唔係月結單' }, { status: 400 })
  }
  const section = await prisma.labStatementSection.findFirst({
    where: { id: params.sid, documentId: doc.id },
    include: { document: { select: { clinicId: true } } },
  })
  if (!section) {
    return jsonNoStore({ error: '分段唔存在' }, { status: 404 })
  }
  if (section.status === 'CONFIRMED') {
    return jsonNoStore({ error: '分段已確認，唔可以再指派（要重新配對先）' }, { status: 409 })
  }
  if (doc.version !== version) {
    return jsonNoStore({ error: '版本衝突（單據已更新）— 請重讀' }, { status: 409 })
  }
  const newClinicId = clinicId !== null ? clinicId : section.clinicId
  if (scope !== null && newClinicId && !scope.includes(newClinicId)) {
    return jsonNoStore({ error: '診所唔喺你嘅範圍' }, { status: 403 })
  }
  if (scope !== null && unassign && section.clinicId && !scope.includes(section.clinicId)) {
    return jsonNoStore({ error: '診所唔喺你嘅範圍' }, { status: 403 })
  }
  // 改返／解除：舊配對基於舊診所／醫生 → 要清；「以月結單為準」改過系統嘅還原唔到 → 擋
  const clinicChanged = clinicId !== null && section.clinicId !== null && clinicId !== section.clinicId
  const providerChanged = providerId !== null && section.providerId !== null && providerId !== section.providerId
  const resetMatching = unassign || clinicChanged || providerChanged
  if (resetMatching && (await sectionsWithSystemChange(prisma, [section.id])) > 0) {
    return jsonNoStore({ error: SYSTEM_CHANGE_BLOCK_MSG }, { status: 409 })
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null

  // —— 解除指派 ——
  if (unassign) {
    const before = { clinicId: section.clinicId, providerId: section.providerId, status: section.status }
    const docStatus = await prisma.$transaction(async (tx: any) => {
      await resetSectionMatching(tx, [section.id])
      const s = await tx.labStatementSection.updateMany({
        where: { id: params.sid, documentId: doc.id, status: { not: 'CONFIRMED' } },
        data: { clinicId: null, providerId: null, clinicBasis: null, providerBasis: null, status: 'NEEDS_ASSIGN' },
      })
      if (s.count === 0) throw new Error('VERSION')
      const documentStatus = doc.status === 'IN_PROGRESS' ? 'NEEDS_REVIEW' : doc.status
      const d = await tx.labDocument.updateMany({
        where: { id: doc.id, version },
        data: { status: documentStatus, version: { increment: 1 } },
      })
      if (d.count === 0) throw new Error('VERSION')
      return documentStatus
    }, { timeout: 30_000 }).catch((e: Error) => {
      if (e.message === 'VERSION') return null
      throw e
    })
    if (docStatus === null) {
      return jsonNoStore({ error: '版本衝突（單據已更新）— 請重讀' }, { status: 409 })
    }
    await labdocAudit({
      action: 'LAB_STATEMENT_SECTION_ASSIGN',
      entity: 'LabStatementSection',
      entityId: params.sid,
      clinicId: section.clinicId,
      actorId: session.userId,
      ipAddress: ip,
      userAgent: ua,
      notes: `unassign section ${section.sectionIndex}（doc ${doc.id}）`,
      before,
      after: { clinicId: null, providerId: null, status: 'NEEDS_ASSIGN', documentStatus: docStatus, matchingReset: true },
    })
    return NextResponse.json({ ok: true, id: params.sid, clinicId: null, providerId: null, status: 'NEEDS_ASSIGN', documentStatus: docStatus, aliasesWritten: [] })
  }
  const aliasesWritten: Array<{ type: string; rawNorm: string; targetId: string; prevTargetId: string | null }> = []

  // —— alias 學習（§6.2.7／§6.3.4）——
  if (rememberClinic && clinicId !== null) {
    // 1) customerNo → LabCustomerNo（同 Lab 冪等 upsert）
    if (section.customerNoRaw && doc.labId) {
      const key = normCustomerNo(section.customerNoRaw)
      if (key) {
        const existing = await prisma.labCustomerNo.findUnique({ where: { labId_customerNo: { labId: doc.labId, customerNo: key } } })
        if (existing && (existing.clinicId !== clinicId || (existing.providerId ?? null) !== (providerId ?? null))) {
          if (!overwrite) {
            return jsonNoStore({
              error: 'ALIAS_CONFLICT',
              conflict: { type: 'LabCustomerNo', raw: section.customerNoRaw, prevTargetId: existing.clinicId },
              message: `以後「${section.customerNoRaw}」都當係新診所？`,
            }, { status: 409 })
          }
          await prisma.labCustomerNo.update({ where: { id: existing.id }, data: { clinicId, providerId: providerId ?? existing.providerId } })
          aliasesWritten.push({ type: 'LabCustomerNo', rawNorm: key, targetId: clinicId, prevTargetId: existing.clinicId })
        } else if (!existing) {
          await prisma.labCustomerNo.create({ data: { labId: doc.labId, customerNo: key, clinicId, providerId: providerId ?? null, createdBy: session.userId } })
          aliasesWritten.push({ type: 'LabCustomerNo', rawNorm: key, targetId: clinicId, prevTargetId: null })
        }
      }
    }
    // 2) clinicRaw → ClinicNameAlias（rawNorm 全庫 unique）
    if (section.clinicRaw && section.clinicRaw.trim() !== '') {
      const rawNorm = normClinicName(section.clinicRaw)
      if (rawNorm) {
        const existing = await prisma.clinicNameAlias.findUnique({ where: { rawNorm } })
        if (existing && existing.clinicId !== clinicId) {
          if (!overwrite) {
            return jsonNoStore({
              error: 'ALIAS_CONFLICT',
              conflict: { type: 'ClinicNameAlias', raw: section.clinicRaw, prevTargetId: existing.clinicId },
              message: `以後「${section.clinicRaw}」都當係新診所？`,
            }, { status: 409 })
          }
          await prisma.clinicNameAlias.update({ where: { id: existing.id }, data: { clinicId } })
          aliasesWritten.push({ type: 'ClinicNameAlias', rawNorm, targetId: clinicId, prevTargetId: existing.clinicId })
        } else if (!existing) {
          await prisma.clinicNameAlias.create({ data: { rawNorm, clinicId, createdBy: session.userId } })
          aliasesWritten.push({ type: 'ClinicNameAlias', rawNorm, targetId: clinicId, prevTargetId: null })
        }
      }
    }
  }
  if (rememberProvider && providerId !== null) {
    if (section.doctorRaw && section.doctorRaw.trim() !== '') {
      const rawNorm = normDoctor(section.doctorRaw)
      if (rawNorm) {
        const existing = await prisma.providerNameAlias.findUnique({ where: { rawNorm } })
        if (existing && existing.providerId !== providerId) {
          if (!overwrite) {
            return jsonNoStore({
              error: 'ALIAS_CONFLICT',
              conflict: { type: 'ProviderNameAlias', raw: section.doctorRaw, prevTargetId: existing.providerId },
              message: `以後「${section.doctorRaw}」都當係新醫生？`,
            }, { status: 409 })
          }
          await prisma.providerNameAlias.update({ where: { id: existing.id }, data: { providerId } })
          aliasesWritten.push({ type: 'ProviderNameAlias', rawNorm, targetId: providerId, prevTargetId: existing.providerId })
        } else if (!existing) {
          await prisma.providerNameAlias.create({ data: { rawNorm, providerId, createdBy: session.userId } })
          aliasesWritten.push({ type: 'ProviderNameAlias', rawNorm, targetId: providerId, prevTargetId: null })
        }
      }
    }
  }

  // —— 寫分段（optimistic lock 喺 doc 級）——
  const finalClinic = clinicId !== null ? clinicId : section.clinicId
  const finalProvider = providerId !== null ? providerId : section.providerId
  const complete = finalClinic !== null && finalProvider !== null
  const upd = await prisma.$transaction(async (tx: any) => {
    if (resetMatching) await resetSectionMatching(tx, [params.sid])
    const s = await tx.labStatementSection.updateMany({
      where: { id: params.sid, documentId: doc.id, status: { not: 'CONFIRMED' } },
      data: {
        ...(clinicId !== null ? { clinicId, clinicBasis: 'MANUAL' } : {}),
        ...(providerId !== null ? { providerId, providerBasis: 'MANUAL' } : {}),
        status: complete ? 'PENDING' : section.status,
      },
    })
    if (s.count === 0) throw new Error('VERSION')
    // §3.4：全部分段識別齊 → 文件 NEEDS_REVIEW → IN_PROGRESS
    let documentStatus = doc.status
    if (doc.status === 'NEEDS_REVIEW') {
      const all = await tx.labStatementSection.findMany({ where: { documentId: doc.id }, select: { clinicId: true, providerId: true } })
      if (all.length > 0 && all.every((x: any) => x.clinicId && x.providerId)) {
        documentStatus = 'IN_PROGRESS'
      }
    }
    const d = await tx.labDocument.updateMany({
      where: { id: doc.id, version },
      data: { status: documentStatus, version: { increment: 1 } },
    })
    // 版本唔啱 → throw 令成個 tx（包括清配對）rollback
    if (d.count === 0) throw new Error('VERSION')
    return documentStatus
  }, { timeout: 30_000 }).catch((e: Error) => {
    if (e.message === 'VERSION') return null
    throw e
  })

  if (upd === null) {
    return jsonNoStore({ error: '版本衝突（單據已更新）— 請重讀' }, { status: 409 })
  }

  const before = { clinicId: section.clinicId, providerId: section.providerId, status: section.status }
  await labdocAudit({
    action: 'LAB_STATEMENT_SECTION_ASSIGN',
    entity: 'LabStatementSection',
    entityId: params.sid,
    clinicId: finalClinic,
    actorId: session.userId,
    ipAddress: ip,
    userAgent: ua,
    notes: `assign section ${section.sectionIndex}（doc ${doc.id}）`,
    before,
    after: { clinicId: finalClinic, providerId: finalProvider, status: complete ? 'PENDING' : section.status, documentStatus: upd, ...(resetMatching ? { matchingReset: true } : {}) },
  })
  for (const a of aliasesWritten) {
    await labdocAudit({
      action: 'LAB_ALIAS_LEARN',
      entity: 'LabAlias',
      entityId: a.targetId,
      clinicId: finalClinic,
      actorId: session.userId,
      ipAddress: ip,
      userAgent: ua,
      notes: a.type,
      after: { type: a.type, rawNorm: a.rawNorm, targetId: a.targetId, prevTargetId: a.prevTargetId },
    })
  }
  // ★ P3 §8.1：指派後分段齊（Lab＋診所＋醫生）→ 自動 reconcile（best-effort；失敗留 PENDING）
  if (complete) {
    await autoReconcileIfReady(prisma, params.sid, session.userId, 'auto', '[labdoc:assign]')
  }
  return NextResponse.json({ ok: true, id: params.sid, clinicId: finalClinic, providerId: finalProvider, status: complete ? 'PENDING' : section.status, documentStatus: upd, aliasesWritten })
}
