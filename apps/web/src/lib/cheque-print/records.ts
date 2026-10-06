// ============================================================
// ★ cwm-chequerec-20261005：支票紀錄 —— 由 Cheque 表讀（每張印過嘅票，連作廢）
//   對應人逐類別批量反查：計糧 → 員工花名；醫生月結 → 「Dr.Ho · 何嘉俊」；Lab → Lab 名
//   只限老闆（config.ts RBAC = OWNER）
// ============================================================
import { prisma } from '@/lib/prisma'
import { providerLabel } from '@/lib/provider-label'
import { MAX_ROWS, type ChequeKind, type ChequeRecord, type RecordFilters } from './records-build'

export async function loadChequeRecords(f: RecordFilters): Promise<{ rows: ChequeRecord[]; truncated: boolean }> {
  const where: any = { periodMonth: { gte: f.from, lte: f.to } }
  if (f.accountId) where.accountId = f.accountId
  if (f.kind) where.sourceType = f.kind
  if (f.status) where.status = f.status
  if (f.q) where.OR = [{ payeeName: { contains: f.q, mode: 'insensitive' } }, { chequeNo: { contains: f.q } }]

  const cheques = await prisma.cheque.findMany({
    where,
    orderBy: [{ periodMonth: 'desc' }, { accountId: 'asc' }, { chequeNo: 'asc' }],
    take: MAX_ROWS + 1,
  })
  const truncated = cheques.length > MAX_ROWS
  const list = truncated ? cheques.slice(0, MAX_ROWS) : cheques

  const idsOf = (kind: ChequeKind) => list.filter(c => c.sourceType === kind).map(c => c.sourceId)
  const [accounts, clinics, items, runs, labAmounts, users] = await Promise.all([
    prisma.chequeAccount.findMany({ select: { id: true, label: true, accountLast4: true } }),
    prisma.clinic.findMany({ select: { id: true, name: true } }),
    prisma.payrollItem.findMany({ where: { id: { in: idsOf('PAYROLL_ITEM') } }, select: { id: true, employee: { select: { user: { select: { name: true } } } } } }),
    prisma.payoutRun.findMany({ where: { id: { in: idsOf('PAYOUT_RUN') } }, select: { id: true, providerId: true } }),
    prisma.labChequeAmount.findMany({ where: { id: { in: idsOf('LAB_AMOUNT') } }, select: { id: true, labId: true } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(list.map(c => c.printedBy))] } }, select: { id: true, name: true } }),
  ])
  const [providers, labs] = await Promise.all([
    runs.length ? prisma.provider.findMany({ where: { id: { in: [...new Set(runs.map(r => r.providerId))] } }, select: { id: true, name: true, nameZh: true } }) : Promise.resolve([]),
    labAmounts.length ? prisma.lab.findMany({ where: { id: { in: [...new Set(labAmounts.map(a => a.labId))] } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ])

  const accountLabel = new Map(accounts.map(a => [a.id, a.accountLast4 ? `${a.label} · ****${a.accountLast4}` : a.label]))
  const clinicName = new Map(clinics.map(c => [c.id, c.name]))
  const empName = new Map(items.map(i => [i.id, i.employee?.user?.name ?? '']))
  const provLabel = new Map(providers.map(p => [p.id, providerLabel(p)]))
  const runProvider = new Map(runs.map(r => [r.id, provLabel.get(r.providerId) ?? '']))
  const labName = new Map(labs.map(l => [l.id, l.name]))
  const labOf = new Map(labAmounts.map(a => [a.id, labName.get(a.labId) ?? '']))
  const userName = new Map(users.map(u => [u.id, u.name]))

  const rows: ChequeRecord[] = list.map(c => {
    const kind = c.sourceType as ChequeKind
    const refLabel = kind === 'PAYROLL_ITEM' ? empName.get(c.sourceId)
      : kind === 'PAYOUT_RUN' ? runProvider.get(c.sourceId)
        : labOf.get(c.sourceId)
    return {
      id: c.id, chequeNo: c.chequeNo, chequeDate: c.chequeDate, periodMonth: c.periodMonth, kind,
      payeeName: c.payeeName, refLabel: refLabel || '（來源已刪除）',
      clinicName: c.clinicId ? clinicName.get(c.clinicId) ?? '' : '', accountLabel: accountLabel.get(c.accountId) ?? '',
      amount: Number(c.amount), status: c.status, confirmed: !!c.confirmedAt,
      printedByName: userName.get(c.printedBy) ?? '', printedAt: c.createdAt.toISOString(),
      voidReason: c.voidReason, voidedAt: c.voidedAt ? c.voidedAt.toISOString() : null,
    }
  })
  return { rows, truncated }
}
