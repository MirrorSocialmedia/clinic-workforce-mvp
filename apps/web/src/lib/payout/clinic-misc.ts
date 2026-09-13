/**
 * ★ cwm-clinicmisc-wire-20260913：診所雜項收入（Apricot CLINIC 帳號）——【唯一來源】。
 *   caller：apricot/clinic-revenue（面板）、payout-runs/clinic-report（月報 Excel）。
 *   ⚠️★★★ 歸店一律靠 allocation 嘅 clinicExtId，【唔准】用 ApricotPractitioner.clinicId ——
 *      通用「Clinic」帳號個 clinicId 係 null（佢喺每間店都係同一個 ID），用佢 filter 會全部漏。
 */
import { prisma } from '@/lib/prisma'
import { ACTIVE_ALLOCATION } from '@/lib/payout/engine'

export interface ClinicMiscRow {
  source: 'APRICOT' | 'MANUAL'
  incomeAt: Date
  category: string        // APRICOT → 'APRICOT'；MANUAL → PRODUCT|DEPOSIT|OTHER
  itemName: string        // APRICOT → 帳號名（TW Clinic / Clinic）
  methodNorm: string
  amount: number
  note: string | null
  isVoid: boolean
}

/** Apricot CLINIC 帳號嘅收款（一間店、一個月） */
export async function loadApricotClinicMisc(
  apricotClinicId: string | null,
  periodMonth: string,
): Promise<ClinicMiscRow[]> {
  if (!apricotClinicId) return []   // ★ 未綁 Apricot 嘅店（青衣）→ 空，唔係錯

  const accts = await prisma.apricotPractitioner.findMany({
    where: { kind: 'CLINIC' },
    select: { apricotId: true, name: true },
  })
  if (accts.length === 0) return []
  const nameOf = new Map(accts.map(a => [a.apricotId, a.name]))

  const rows = await prisma.paymentAllocation.findMany({
    where: {
      ...ACTIVE_ALLOCATION,
      providerExtId: { in: accts.map(a => a.apricotId) },
      clinicExtId: apricotClinicId,   // ★★★ 歸店靠呢個
      periodMonth,
    },
    orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
  })

  return rows.map(r => ({
    source: 'APRICOT' as const,
    incomeAt: r.paidAt,
    category: 'APRICOT',
    itemName: nameOf.get(r.providerExtId ?? '') ?? '（診所帳號）',
    methodNorm: r.methodNorm,
    amount: Number(r.amount),
    note: null,
    isVoid: false,   // ACTIVE_ALLOCATION 已經隔走 isVoid / isSuperseded
  }))
}

/** 人手錄入（退路：真係唔經 Apricot 嗰啲） */
export async function loadManualClinicMisc(
  clinicId: string,
  periodMonth: string,
): Promise<ClinicMiscRow[]> {
  const rows = await prisma.miscIncome.findMany({
    where: { clinicId, periodMonth },
    orderBy: [{ incomeAt: 'asc' }, { id: 'asc' }],
  })
  return rows.map(r => ({
    source: 'MANUAL' as const,
    incomeAt: r.incomeAt,
    category: r.category,
    itemName: r.itemName,
    methodNorm: r.methodNorm,
    amount: Number(r.amount),
    note: r.note ?? null,
    isVoid: r.isVoid,
  }))
}

/** 兩者聯集，按日期排 */
export async function loadClinicMisc(
  clinicId: string,
  apricotClinicId: string | null,
  periodMonth: string,
): Promise<ClinicMiscRow[]> {
  const [apx, manual] = await Promise.all([
    loadApricotClinicMisc(apricotClinicId, periodMonth),
    loadManualClinicMisc(clinicId, periodMonth),
  ])
  return [...apx, ...manual].sort((a, b) => a.incomeAt.getTime() - b.incomeAt.getTime())
}
