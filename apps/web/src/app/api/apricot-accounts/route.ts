// ★ cwm-apricotacct-20260913 E1：PUT /api/apricot-accounts — 綁定／改綁／標 UNKNOWN
//
// 三道守衛（MD 逐字）：
//   ① kind=PROVIDER 必須有 providerId（且存在）
//   ② kind=CLINIC 可以冇 clinicId（通用帳號 — ★★★ 每間店同一個 ID），有就要存在
//   ③ kind=UNKNOWN 兩個都必須 null
//
// ★ RBAC：OWNER only（config.ts MATRIX，零 RBAC_PERM_OVERRIDES）— 直接影響拆帳
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'

export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const body = await req.json().catch(() => ({} as any))
  const { apricotId, kind, providerId, clinicId, name, note } = body

  // ── 輸入守衛 ──────────────────────────────────────────────────
  if (!apricotId || typeof apricotId !== 'string' || !apricotId.trim()) {
    return jsonNoStore({ error: 'apricotId 必填' }, { status: 400 })
  }
  if (!['PROVIDER', 'CLINIC', 'UNKNOWN'].includes(kind)) {
    return jsonNoStore({ error: 'kind 必須係 PROVIDER / CLINIC / UNKNOWN' }, { status: 400 })
  }
  const pid = providerId || null
  const cid = clinicId || null

  // 守衛①：PROVIDER 必須有 providerId
  if (kind === 'PROVIDER' && !pid) {
    return jsonNoStore({ error: 'PROVIDER 帳號必須綁一位醫生（providerId 必填）' }, { status: 400 })
  }
  // 守衛③：UNKNOWN 兩個都必須 null
  if (kind === 'UNKNOWN' && (pid || cid)) {
    return jsonNoStore({ error: 'UNKNOWN 帳號唔准綁醫生／診所（providerId／clinicId 都要留空）' }, { status: 400 })
  }

  // 存在性驗證（守衛① provider 存在；守衛② clinic 有就要存在）
  if (pid) {
    const p = await prisma.provider.findUnique({ where: { id: pid }, select: { id: true, name: true } })
    if (!p) return jsonNoStore({ error: `醫生 ${pid} 不存在` }, { status: 400 })
  }
  if (cid) {
    const c = await prisma.clinic.findUnique({ where: { id: cid }, select: { id: true, name: true } })
    if (!c) return jsonNoStore({ error: `診所 ${cid} 不存在` }, { status: 400 })
  }

  // 帳號顯示名：PROVIDER 缺省用醫生名／CLINIC 缺省用診所名（唔好让用户為呢個填兩次）
  let accountName = (typeof name === 'string' && name.trim()) || null
  if (!accountName) {
    if (kind === 'PROVIDER' && pid) {
      const p = await prisma.provider.findUnique({ where: { id: pid }, select: { name: true } })
      accountName = p?.name ?? null
    } else if (kind === 'CLINIC' && cid) {
      const c = await prisma.clinic.findUnique({ where: { id: cid }, select: { name: true } })
      accountName = c?.name ?? null
    }
  }
  if (!accountName) {
    // UNKNOWN／未指名 → 照存占位（之後由 sync D1 用 bill payload 嘅名補更好），唔阻操作
    accountName = '（未命名帳號）'
  }

  const existing = await prisma.apricotPractitioner.findUnique({ where: { apricotId: apricotId.trim() } })

  try {
    const record = await prisma.apricotPractitioner.upsert({
      where: { apricotId: apricotId.trim() },
      create: {
        apricotId: apricotId.trim(),
        name: accountName,
        kind,
        providerId: pid,
        clinicId: cid,
        note: (typeof note === 'string' && note.trim()) || null,
      },
      update: {
        name: accountName,
        kind,
        providerId: pid,
        clinicId: cid,
        note: (typeof note === 'string' && note.trim()) || null,
      },
    })

    const { apricotId: boundId, name: boundName } = record

    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: 'APRICOT_ACCOUNT_BIND',
        entity: 'ApricotPractitioner',
        entityId: record.id,
        notes: `${existing ? '改綁' : '綁定'} Apricot 帳號「${boundId}」→ ${kind}${pid ? '（醫生）' : cid ? '（診所）' : ''}`,
        afterJson: JSON.stringify({ apricotId: boundId, kind, providerId: pid, clinicId: cid }),
      },
    }).catch(e => console.error('[apricot-accounts] audit failed', e))

    return jsonNoStore({ ok: true, account: { apricotId: boundId, kind, providerId: pid, clinicId: cid, name: boundName } })
  } catch (e: any) {
    console.error('[apricot-accounts] PUT failed', e)
    return jsonNoStore({ error: '綁定失敗' }, { status: 500 })
  }
}
