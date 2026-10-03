// ★ cwm-datasource-20261003：PUT /api/apricot-sources/clinic — 店嘅資料來源歸屬／病人編號前綴（OWNER only）
//   { clinicId, account?, patientCodePrefix? }（冇傳嘅欄唔郁）
//   ⚠️ 改歸屬會影響收款同步、預約、醫生月結用邊套憑證 —— 前端要確認；必定審計。
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { isKnownSource } from '@/lib/apricot/sources'
import { parsePrefixList } from '@/lib/apricot/source-pure'
import { normalizeApricotAccount } from '@/lib/apricot/account'

export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('apricot-sources/clinic', async () => {
    const body = await req.json().catch(() => ({} as any))
    if (typeof body.clinicId !== 'string') return jsonNoStore({ error: 'clinicId 必填' }, { status: 400 })
    const clinic = await prisma.clinic.findUnique({
      where: { id: body.clinicId },
      select: { id: true, name: true, apricotAccount: true, patientCodePrefix: true },
    })
    if (!clinic) return jsonNoStore({ error: '搵唔到診所' }, { status: 404 })

    const data: { apricotAccount?: string; patientCodePrefix?: string | null } = {}
    if (body.account !== undefined) {
      const account = normalizeApricotAccount(body.account)
      if (typeof body.account !== 'string' || !(await isKnownSource(account))) {
        return jsonNoStore({ error: '搵唔到呢個資料來源' }, { status: 400 })
      }
      data.apricotAccount = account
    }
    if (body.patientCodePrefix !== undefined) {
      const raw = typeof body.patientCodePrefix === 'string' ? body.patientCodePrefix : ''
      const list = parsePrefixList(raw)
      if (raw.trim() && list.length === 0) return jsonNoStore({ error: '前綴只可以係英文字母（例：TW 或 TKW,TK）' }, { status: 400 })
      data.patientCodePrefix = list.length ? list.join(',') : null
    }
    if (!Object.keys(data).length) return jsonNoStore({ error: '冇嘢要改' }, { status: 400 })

    await prisma.clinic.update({ where: { id: clinic.id }, data })
    await prisma.auditLog.create({
      data: {
        actorId: session.userId, action: 'APRICOT_SOURCE_UPDATE', entity: 'Clinic', entityId: clinic.id,
        notes: `「${clinic.name}」資料來源設定${data.apricotAccount && data.apricotAccount !== clinic.apricotAccount ? '（⚠️ 改咗來源歸屬）' : ''}`,
        beforeJson: JSON.stringify({ apricotAccount: clinic.apricotAccount, patientCodePrefix: clinic.patientCodePrefix }),
        afterJson: JSON.stringify(data),
      },
    })
    return jsonNoStore({ ok: true })
  })
}
