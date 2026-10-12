// ★ cwm-labstmtprog-20261012：GET /api/lab-docs/statement-progress?month=YYYY-MM
//   某月 Lab 月結單逐間診所：已對／對數中／未對＋未收到（有 Lab 成本但冇月結單）—— 計法見 lib/labdoc/statement-progress.ts
//   範圍同 /api/lab-docs（labdocScope：KIOSK = 自己店；有 lab 權限 = 全集團）。純讀，唔出病人資料。
// → { month, clinics: [{ clinicId, clinicName, reconciled, inProgress, open, missingLabs: string[] }], unassigned }
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { labdocScope } from '@/lib/labdoc/kiosk-scope'
import { statementProgress, STATEMENT_EXCLUDED } from '@/lib/labdoc/statement-progress'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  const month = req.nextUrl.searchParams.get('month') ?? ''
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return jsonNoStore({ error: 'month 要 YYYY-MM' }, { status: 400 })

  const scope = await labdocScope(session, perms)
  if (scope !== null && scope.length === 0) return jsonNoStore({ month, clinics: [], unassigned: 0 })

  const statements = await prisma.labDocument.findMany({
    where: { kind: 'STATEMENT', statementMonth: month, status: { notIn: [...STATEMENT_EXCLUDED] } },
    select: { id: true, labId: true, status: true, clinicId: true, uploadClinicId: true, sections: { select: { clinicId: true, status: true } } },
  })
  const costs = await prisma.costCase.findMany({
    where: { category: 'LAB', periodMonth: month, status: { not: 'VOID' }, labId: { not: null }, ...(scope ? { clinicId: { in: scope } } : {}) },
    select: { clinicId: true, labId: true },
    distinct: ['clinicId', 'labId'],
  })
  const r = statementProgress(statements, costs.map(c => ({ clinicId: c.clinicId, labId: c.labId as string })))
  const clinicsOut = scope ? r.clinics.filter(c => scope.includes(c.clinicId)) : r.clinics

  const [clinics, labs] = await Promise.all([
    prisma.clinic.findMany({ where: { id: { in: clinicsOut.map(c => c.clinicId) } }, select: { id: true, name: true, shortName: true } }),
    prisma.lab.findMany({ where: { id: { in: [...new Set(clinicsOut.flatMap(c => c.missingLabIds))] } }, select: { id: true, name: true } }),
  ])
  const clinicName = new Map(clinics.map(c => [c.id, c.name || c.shortName || c.id]))
  const labName = new Map(labs.map(l => [l.id, l.name]))

  return jsonNoStore({
    month,
    clinics: clinicsOut
      .map(c => ({
        clinicId: c.clinicId,
        clinicName: clinicName.get(c.clinicId) ?? c.clinicId,
        reconciled: c.reconciled,
        inProgress: c.inProgress,
        open: c.open,
        missingLabs: c.missingLabIds.map(id => labName.get(id) ?? id).sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.clinicName.localeCompare(b.clinicName, 'zh-HK')),
    // 唔知邊間店嘅單（未分段又冇單頭店／上傳店）—— 只畀全集團範圍睇
    unassigned: scope ? 0 : r.unassigned,
  })
}
