// ============================================================
// ★ cwm-chequetpl-20261004：/api/cheque-sheet-payers — 出糧總表「出糧診所」同組內次序（OWNER only）
//   GET 在職員工（＋已有設定嘅人）＋所屬診所＋出糧診所＋次序；全部診所（揀出糧診所用）
//   PUT { items: [{ employeeId, payerClinicId|null, sortOrder|null }] } —— 成批覆寫
//   ⚠️ 只影響出糧總表分組；計糧、排更、所屬診所全部唔郁
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { employedFromWhere } from '@/lib/employment-scope'
import { toHKDateStr, addDaysStr } from '@/lib/hk-date'

/** 上兩個月嘅 1 號（HK）—— 即包今個月＋之前兩個計糧月 */
function recentMonthsStart(): Date {
  const [y, m] = toHKDateStr(new Date()).split('-').map(Number)
  const t = (y * 12 + (m - 1)) - 2
  return new Date(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01T00:00:00+08:00`)
}

const placeTitle = (c: { name: string; company: { name: string } | null } | null) =>
  c ? `${c.company?.name ?? '全部診所'} · ${c.name}` : '（冇所屬診所）'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  return handleRoute('cheque-sheet-payers', async () => {
    const payers = await prisma.chequeSheetPayer.findMany()
    const [employees, clinics] = await Promise.all([
      prisma.employee.findMany({
        // ★ cwm-chequeexcl-20261004 fix：近 3 個計糧月內仲有返工嘅已離職員工都要列（當月出糧總表照有佢哋，
        //   支票模版要揀得）；之前只列在職 → 已離職嘅人揀唔到
        where: { OR: [employedFromWhere(recentMonthsStart()), { id: { in: payers.map(p => p.employeeId) } }] },
        select: {
          id: true, status: true, homeClinicId: true, joinDate: true, leaveDate: true, resignedAt: true,
          user: { select: { name: true, fullName: true } },
          homeClinic: { select: { name: true, company: { select: { name: true } } } },
        },
      }),
      prisma.clinic.findMany({ select: { id: true, name: true, company: { select: { name: true } } } }),
    ])
    const byEmp = new Map(payers.map(p => [p.employeeId, p]))
    return jsonNoStore({
      clinics: clinics
        .map(c => ({ id: c.id, title: placeTitle(c) }))
        .sort((a, b) => a.title.localeCompare(b.title, 'zh-HK')),
      employees: employees.map(e => {
        const p = byEmp.get(e.id)
        return {
          id: e.id,
          name: e.user?.name ?? '',
          resigned: e.status === 'RESIGNED',
          // 最後工作日（leaveDate；舊數據冇就 resignedAt − 1 日）
          lastDay: e.status === 'RESIGNED'
            ? (e.leaveDate ? toHKDateStr(e.leaveDate) : e.resignedAt ? addDaysStr(toHKDateStr(e.resignedAt), -1) : null)
            : null,
          joinDate: e.joinDate, // ★ cwm-chequeexcl-20261004：模版設定頁試用期提示用
          homeClinicId: e.homeClinicId,
          homeTitle: placeTitle(e.homeClinic as any),
          payerClinicId: p?.payerClinicId ?? null,
          sortOrder: p?.sortOrder ?? null,
        }
      }),
    })
  })
}

export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  return handleRoute('cheque-sheet-payers', async () => {
    const body = await req.json().catch(() => ({} as any))
    const items: any[] = Array.isArray(body.items) ? body.items.slice(0, 2000) : []
    const empIds = items.map(i => i?.employeeId).filter((x): x is string => typeof x === 'string')
    const clinicIds = new Set((await prisma.clinic.findMany({ select: { id: true } })).map(c => c.id))
    const validEmp = new Set((await prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, homeClinicId: true } })).map(e => e.id))
    const clean = items.flatMap(i => {
      if (!validEmp.has(i?.employeeId)) return []
      const payerClinicId = typeof i.payerClinicId === 'string' && clinicIds.has(i.payerClinicId) ? i.payerClinicId : null
      const sortOrder = Number.isInteger(i.sortOrder) && i.sortOrder >= 0 && i.sortOrder < 100000 ? i.sortOrder : null
      return [{ employeeId: i.employeeId as string, payerClinicId, sortOrder }]
    })
    await prisma.$transaction(clean.map(c => (c.payerClinicId === null && c.sortOrder === null
      ? prisma.chequeSheetPayer.deleteMany({ where: { employeeId: c.employeeId } })
      : prisma.chequeSheetPayer.upsert({
        where: { employeeId: c.employeeId },
        update: { payerClinicId: c.payerClinicId, sortOrder: c.sortOrder },
        create: c,
      }))))
    const moved = clean.filter(c => c.payerClinicId).length
    await prisma.auditLog.create({
      data: {
        actorId: session.userId, action: 'CHEQUE_SHEET_PAYER_UPDATE', entity: 'ChequeSheetPayer', entityId: 'batch',
        notes: `出糧總表出糧診所／次序：${clean.length} 人（${moved} 人改咗出糧診所）`,
        afterJson: JSON.stringify(clean),
      },
    })
    return jsonNoStore({ ok: true, saved: clean.length })
  })
}
