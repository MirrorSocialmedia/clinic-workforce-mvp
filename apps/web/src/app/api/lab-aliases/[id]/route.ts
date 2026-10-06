// ★ cwm-labdoc P4 CHUNK 2：DELETE /api/lab-aliases/:id — §11 alias 刪除（lab_statement）
//
// 四種 alias 表統一口徑：?type=LabAlias|LabCustomerNo|ClinicNameAlias|ProviderNameAlias（必填 —
// cuid 跨四表，唔帶 type 無法定位）。只刪（§11「只刪」；alias 重記 = P2 assign「記住」已有）。
// audit：LAB_ALIAS_DELETE（before = 該 row 快照 — alias 值係 Lab／診所／醫生／收款人名，零病人姓名）
// 權限：lab_statement（§10.2「alias 管理」）— RBAC_MATRIX + RBAC_PERM_OVERRIDES 雙登記
// ownership-ok: alias 係 Lab／診所／醫生維度（全集團），冇病人數據
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { labdocAudit } from '@/lib/labdoc/audit'
import { ALIAS_TYPES, type AliasType } from '@/lib/labdoc/alias-types'

const ID_RE = /^[a-z0-9]{25}$/

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params
  // 格式檢查喺 auth 前（malformed input fail-fast — normalizeRoute 對短 id/hyphen id 會 403，唔對）
  if (!ID_RE.test(id)) return jsonNoStore({ error: 'id 格式錯誤' }, { status: 400 })

  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth
  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }

  const type = req.nextUrl.searchParams.get('type') ?? ''
  if (!(ALIAS_TYPES as readonly string[]).includes(type)) {
    return jsonNoStore({ error: `type 必填，必須係 ${ALIAS_TYPES.join(' / ')}` }, { status: 400 })
  }
  const aliasType = type as AliasType

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const ua = req.headers.get('user-agent') ?? null

  // 逐 type 定位 + 刪（各表 id 空間獨立；同一 type 內 id 唯一）
  let before: Record<string, unknown> | null

  if (aliasType === 'LabAlias') {
    const row = await prisma.labAlias.findUnique({
      where: { id },
      include: { lab: { select: { id: true, name: true } } },
    })
    if (!row) return jsonNoStore({ error: 'alias 唔存在' }, { status: 404 })
    before = { labId: row.labId, labName: row.lab.name, kind: row.kind, rawNorm: row.rawNorm, createdBy: row.createdBy }
    await prisma.labAlias.delete({ where: { id } })
  } else if (aliasType === 'LabCustomerNo') {
    const row = await prisma.labCustomerNo.findUnique({ where: { id } })
    if (!row) return jsonNoStore({ error: '客戶編號 唔存在' }, { status: 404 })
    before = {
      labId: row.labId,
      customerNo: row.customerNo,
      clinicId: row.clinicId,
      providerId: row.providerId,
      createdBy: row.createdBy,
    }
    await prisma.labCustomerNo.delete({ where: { id } })
  } else if (aliasType === 'ClinicNameAlias') {
    const row = await prisma.clinicNameAlias.findUnique({ where: { id } })
    if (!row) return jsonNoStore({ error: '診所別名 唔存在' }, { status: 404 })
    before = { clinicId: row.clinicId, rawNorm: row.rawNorm, createdBy: row.createdBy }
    await prisma.clinicNameAlias.delete({ where: { id } })
  } else {
    const row = await prisma.providerNameAlias.findUnique({ where: { id } })
    if (!row) return jsonNoStore({ error: '醫生別名 唔存在' }, { status: 404 })
    before = { providerId: row.providerId, rawNorm: row.rawNorm, createdBy: row.createdBy }
    await prisma.providerNameAlias.delete({ where: { id } })
  }

  await labdocAudit({
    action: 'LAB_ALIAS_DELETE',
    entity: aliasType,
    entityId: id,
    actorId: session.userId,
    ipAddress: ip,
    userAgent: ua,
    before,
  })

  return jsonNoStore({ ok: true, type: aliasType, id })
}
