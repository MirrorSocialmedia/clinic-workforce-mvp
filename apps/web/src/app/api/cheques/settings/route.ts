// ============================================================
// ★ cwm-chequeprint-20261005：GET /api/cheques/settings — 支票設定（戶口、診所對應、版面、醫生／Lab 抬頭）
//   只限老闆（config.ts RBAC = OWNER，冇 perm override）
// ============================================================
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { handleRoute } from '@/lib/api-guard'
import { formatNo, listLayouts } from '@/lib/cheque-print/server'
import { providerLabel, missingNameZh } from '@/lib/provider-label'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  return handleRoute('cheques-settings', async () => {
    const [layouts, accounts, links, clinics, providers, labs, payees] = await Promise.all([
      listLayouts(),
      prisma.chequeAccount.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
      prisma.chequeAccountClinic.findMany(),
      prisma.clinic.findMany({ select: { id: true, name: true, company: { select: { name: true } } }, orderBy: { name: 'asc' } }),
      prisma.provider.findMany({ where: { isActive: true }, select: { id: true, name: true, nameZh: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      prisma.lab.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      prisma.chequePayee.findMany(),
    ])
    const accountOf = new Map(links.map(l => [l.clinicId, l.accountId]))
    const payee = (kind: string, id: string) => payees.find(p => p.kind === kind && p.refId === id)?.payeeName ?? ''
    return jsonNoStore({
      layouts,
      accounts: accounts.map(a => ({
        id: a.id, label: a.label, bankName: a.bankName, accountLast4: a.accountLast4, layoutId: a.layoutId,
        bookFirstNo: a.bookFirstNo, bookLastNo: a.bookLastNo, nextNo: a.nextNo, noWidth: a.noWidth, isActive: a.isActive,
        nextNoText: a.nextNo != null ? formatNo(a.nextNo, a.noWidth) : null,
        remaining: a.nextNo != null && a.bookLastNo != null ? Math.max(0, a.bookLastNo - a.nextNo + 1) : null,
        clinicIds: links.filter(l => l.accountId === a.id).map(l => l.clinicId),
      })),
      clinics: clinics.map(c => ({ id: c.id, name: c.name, companyName: c.company?.name ?? '', accountId: accountOf.get(c.id) ?? null })),
      // ★ cwm-chequerec-20261005：「Dr.Ho · 何嘉俊」；未填中文全名 → nameZhMissing（UI 黃色提示）
      providers: providers.map(p => ({ id: p.id, name: providerLabel(p), nameZhMissing: missingNameZh(p), payee: payee('PROVIDER', p.id) })),
      labs: labs.map(l => ({ id: l.id, name: l.name, payee: payee('LAB', l.id) })),
    })
  })
}
