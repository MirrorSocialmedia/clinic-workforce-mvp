/**
 * POST /api/sp-subsidies/scan — Auto-detect SP subsidies (OWNER / provider_payout)
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { handleRoute } from '@/lib/api-guard'
import { scanSpSubsidies } from '@/lib/payout/engine'
import { prisma } from '@/lib/prisma'
import { SP_SCAN_AUDIT, scanAuditEntityId } from '@/lib/payout/sp-review'
import { payoutClinicGuard } from '@/lib/payout/kiosk-scope'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  return handleRoute('sp-subsidies/scan', async () => {
    const { periodMonth, clinicId } = await req.json().catch(() => ({}))
    if (!periodMonth) return NextResponse.json({ error: 'periodMonth required' }, { status: 400 })
    // ★ cwm-kioskpayout-20261010：店舖帳號一定要指定自己店（唔指定 = 掃晒全部店）
    const denied = payoutClinicGuard(auth.session!, clinicId)
    if (denied) return denied
    const r = await scanSpSubsidies(periodMonth, clinicId)
    // ★ cwm-sppreview-20261006：記低「呢個月掃描過」—— 月結預覽靠佢分「未掃描」同「掃咗但真係冇」
    await prisma.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: SP_SCAN_AUDIT,
        entity: 'SpSubsidyScan',
        entityId: scanAuditEntityId(periodMonth, clinicId),
        notes: `掃描 2人SP：${periodMonth}${clinicId ? '（指定診所）' : '（全部診所）'} 新增 ${r.created}、更新 ${r.updated}、失敗 ${r.failed.length}`,
        afterJson: JSON.stringify({ periodMonth, clinicId: clinicId ?? null, created: r.created, updated: r.updated, failed: r.failed.length, skippedLocked: r.skippedLocked }),
      },
    }).catch((e: any) => console.error('[sp-subsidies] scan audit failed', e))
    return NextResponse.json({
      candidates: r.candidates,
      count: r.candidates.length,
      skippedLocked: r.skippedLocked,
      created: r.created,
      updated: r.updated,
      failed: r.failed,
    })
  })
}
