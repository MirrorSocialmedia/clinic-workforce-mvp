// ============================================================
// ★ cwm-chequeprint-20261005：支票打印 — 伺服器邏輯（只限老闆，API RBAC = OWNER）
//   三種來源：
//     PAYROLL_ITEM：計糧（金額 = totalPayable，已含雜項；出糧診所跟 ChequeSheetPayer，冇就跟計糧單診所）
//     PAYOUT_RUN  ：醫生月結（每醫生每診所一張，要 LOCKED）
//     LAB_AMOUNT  ：Lab 月結金額（人手輸入，隨時改）
//   號碼：戶口 nextNo 起，跳過已用；一出就記（印壞 = VOID，唔會再用）。
// ============================================================
import { prisma } from '@/lib/prisma'
import { getMonthRange } from '@/lib/hk-date'
import { HSBC_DEFAULT_FIELDS, normalizeFields, type LayoutFields, type PrinterMode } from './layout'
import { cleanPayee } from './content'

export type SourceType = 'PAYROLL_ITEM' | 'PAYOUT_RUN' | 'LAB_AMOUNT'
export const SOURCE_TYPES: SourceType[] = ['PAYROLL_ITEM', 'PAYOUT_RUN', 'LAB_AMOUNT']

export const isMonth = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)
export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s)

export function formatNo(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

export interface LayoutDTO { id: string; name: string; fields: LayoutFields; offsetXmm: number; offsetYmm: number; printerMode: PrinterMode }

/** 冇版面就開一個「匯豐商業支票」預設 */
export async function listLayouts(): Promise<LayoutDTO[]> {
  let rows = await prisma.chequeLayout.findMany({ orderBy: { createdAt: 'asc' } })
  if (rows.length === 0) {
    await prisma.chequeLayout.create({ data: { name: '匯豐商業支票', fieldsJson: JSON.stringify(HSBC_DEFAULT_FIELDS) } })
    rows = await prisma.chequeLayout.findMany({ orderBy: { createdAt: 'asc' } })
  }
  return rows.map(r => {
    let fields = HSBC_DEFAULT_FIELDS
    try { fields = normalizeFields(JSON.parse(r.fieldsJson)) } catch { /* 壞咗用預設 */ }
    return { id: r.id, name: r.name, fields, offsetXmm: r.offsetXmm, offsetYmm: r.offsetYmm, printerMode: r.printerMode === 'TEXT' ? 'TEXT' : 'ESCP' }
  })
}

export interface CenterRow {
  sourceType: SourceType
  sourceId: string
  clinicId: string | null
  clinicName: string
  /** 支票抬頭（null = 未設定，唔可以出票） */
  payee: string | null
  /** 顯示用：員工花名／醫生名／Lab 名 */
  label: string
  detail: string
  amount: number
  /** 擋住唔可以出票嘅原因 */
  blocker: string | null
  cheque: { id: string; chequeNo: string; status: string; confirmed: boolean; chequeDate: string } | null
  /** Lab 先有：人手輸入嘅資料 */
  lab?: { labId: string; statementRef: string | null; note: string | null; systemCost: number }
}

/** 戶口用緊嘅診所 */
export async function accountClinicIds(accountId: string): Promise<string[]> {
  const rows = await prisma.chequeAccountClinic.findMany({ where: { accountId }, select: { clinicId: true } })
  return rows.map(r => r.clinicId)
}

async function activeCheques(sourceType: SourceType, ids: string[]) {
  if (ids.length === 0) return new Map<string, any>()
  const rows = await prisma.cheque.findMany({
    where: { sourceType, sourceId: { in: ids }, status: { not: 'VOID' } },
    select: { id: true, chequeNo: true, status: true, confirmedAt: true, chequeDate: true, sourceId: true, accountId: true },
  })
  return new Map(rows.map(r => [r.sourceId, r]))
}

const chequeDTO = (c: any) => c ? { id: c.id, chequeNo: c.chequeNo, status: c.status, confirmed: !!c.confirmedAt, chequeDate: c.chequeDate } : null

/** 打印中心：某戶口某月要出嘅票 */
export async function loadCenter(month: string, accountId: string): Promise<{ employees: CenterRow[]; providers: CenterRow[]; labs: CenterRow[] }> {
  const clinicIds = await accountClinicIds(accountId)
  const clinicSet = new Set(clinicIds)
  const clinics = await prisma.clinic.findMany({ select: { id: true, name: true } })
  const clinicName = new Map(clinics.map(c => [c.id, c.name]))

  // ---------- 員工（計糧） ----------
  const { start, end } = getMonthRange(new Date(`${month}-01T00:00:00+08:00`))
  const [runs, payers] = await Promise.all([
    prisma.payrollRun.findMany({
      where: { periodMonth: { gte: start, lte: end } },
      select: {
        id: true, status: true, clinicId: true,
        items: {
          select: {
            id: true, totalPayable: true,
            employee: { select: { id: true, homeClinicId: true, user: { select: { name: true, fullName: true } } } },
          },
        },
      },
    }),
    prisma.chequeSheetPayer.findMany({ select: { employeeId: true, payerClinicId: true } }),
  ])
  const payerOf = new Map(payers.map(p => [p.employeeId, p.payerClinicId]))
  const empRows: CenterRow[] = []
  for (const run of runs) {
    for (const it of run.items) {
      const payerClinic = payerOf.get(it.employee.id) ?? run.clinicId ?? it.employee.homeClinicId
      if (!payerClinic || !clinicSet.has(payerClinic)) continue
      const amount = Math.round(it.totalPayable * 100) / 100
      const full = it.employee.user.fullName?.trim() || null
      empRows.push({
        sourceType: 'PAYROLL_ITEM', sourceId: it.id, clinicId: payerClinic, clinicName: clinicName.get(payerClinic) ?? '',
        payee: full, label: it.employee.user.name, detail: `計糧 · ${clinicName.get(run.clinicId ?? '') ?? '全部診所'}`
          + (run.clinicId && run.clinicId !== payerClinic ? `（喺${clinicName.get(payerClinic) ?? ''}出票）` : ''),
        amount,
        blocker: run.status === 'DRAFT' ? '計糧未確認' : !full ? '未填全名（帳號管理）' : amount <= 0 ? '金額係 0 或負數' : null,
        cheque: null,
      })
    }
  }
  const empCheques = await activeCheques('PAYROLL_ITEM', empRows.map(r => r.sourceId))
  empRows.forEach(r => { r.cheque = chequeDTO(empCheques.get(r.sourceId)) })

  // ---------- 醫生（月結，每醫生每診所） ----------
  const [payouts, providerPayees] = await Promise.all([
    clinicIds.length ? prisma.payoutRun.findMany({
      where: { periodMonth: month, clinicId: { in: clinicIds } },
      select: { id: true, providerId: true, clinicId: true, totalAmount: true, status: true },
    }) : Promise.resolve([]),
    prisma.chequePayee.findMany({ where: { kind: 'PROVIDER' } }),
  ])
  const providers = payouts.length
    ? await prisma.provider.findMany({ where: { id: { in: payouts.map(p => p.providerId) } }, select: { id: true, name: true, shortName: true } })
    : []
  const provName = new Map(providers.map(p => [p.id, p.shortName || p.name]))
  const provPayee = new Map(providerPayees.map(p => [p.refId, p.payeeName]))
  const provRows: CenterRow[] = payouts.map(p => {
    const amount = Number(p.totalAmount)
    const payee = provPayee.get(p.providerId) ?? null
    return {
      sourceType: 'PAYOUT_RUN' as const, sourceId: p.id, clinicId: p.clinicId, clinicName: clinicName.get(p.clinicId) ?? '',
      payee, label: provName.get(p.providerId) ?? '', detail: `醫生月結 · ${clinicName.get(p.clinicId) ?? ''}`,
      amount,
      blocker: p.status !== 'LOCKED' ? '月結未鎖定' : !payee ? '未設定支票抬頭' : amount <= 0 ? '金額係 0 或負數' : null,
      cheque: null,
    }
  })
  const provCheques = await activeCheques('PAYOUT_RUN', provRows.map(r => r.sourceId))
  provRows.forEach(r => { r.cheque = chequeDTO(provCheques.get(r.sourceId)) })

  // ---------- Lab（人手輸入月結金額） ----------
  const [labs, labPayees, amounts, costs] = await Promise.all([
    prisma.lab.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.chequePayee.findMany({ where: { kind: 'LAB' } }),
    clinicIds.length ? prisma.labChequeAmount.findMany({ where: { periodMonth: month, clinicId: { in: clinicIds } } }) : Promise.resolve([]),
    // 系統成本記錄（只係參考，唔用嚟出票）
    clinicIds.length ? prisma.costCase.groupBy({
      by: ['labId', 'clinicId'],
      where: { category: 'LAB', periodMonth: month, clinicId: { in: clinicIds }, status: { not: 'VOID' }, labId: { not: null } },
      _sum: { finalCost: true },
    }) : Promise.resolve([] as any[]),
  ])
  const labPayee = new Map(labPayees.map(p => [p.refId, p.payeeName]))
  const amountOf = new Map(amounts.map(a => [`${a.labId}|${a.clinicId}`, a]))
  const costOf = new Map((costs as any[]).map(c => [`${c.labId}|${c.clinicId}`, Number(c._sum.finalCost ?? 0)]))
  const labRows: CenterRow[] = []
  for (const lab of labs) {
    for (const cid of clinicIds) {
      const key = `${lab.id}|${cid}`
      const a = amountOf.get(key)
      const systemCost = costOf.get(key) ?? 0
      const payee = labPayee.get(lab.id) ?? null
      const amount = a ? Number(a.amount) : 0
      labRows.push({
        sourceType: 'LAB_AMOUNT', sourceId: a?.id ?? `new:${key}`, clinicId: cid, clinicName: clinicName.get(cid) ?? '',
        payee, label: lab.name, detail: `Lab 月結 · ${clinicName.get(cid) ?? ''}`,
        amount,
        blocker: !a ? '未輸入月結金額' : !payee ? '未設定支票抬頭' : amount <= 0 ? '金額係 0 或負數' : null,
        cheque: null,
        lab: { labId: lab.id, statementRef: a?.statementRef ?? null, note: a?.note ?? null, systemCost },
      })
    }
  }
  const labCheques = await activeCheques('LAB_AMOUNT', labRows.filter(r => !r.sourceId.startsWith('new:')).map(r => r.sourceId))
  labRows.forEach(r => { r.cheque = chequeDTO(labCheques.get(r.sourceId)) })

  const byClinicThenLabel = (a: CenterRow, b: CenterRow) => a.clinicName.localeCompare(b.clinicName, 'zh-Hant') || a.label.localeCompare(b.label, 'zh-Hant')
  return { employees: empRows.sort(byClinicThenLabel), providers: provRows.sort(byClinicThenLabel), labs: labRows.sort(byClinicThenLabel) }
}

/** 由來源搵返收款人同金額（出票時重新讀，唔信 client） */
export async function resolveSource(sourceType: SourceType, sourceId: string, accountId: string, month: string): Promise<{ ok: true; payee: string; amount: number; clinicId: string | null } | { ok: false; error: string }> {
  const center = await loadCenter(month, accountId)
  const all = [...center.employees, ...center.providers, ...center.labs]
  const row = all.find(r => r.sourceType === sourceType && r.sourceId === sourceId)
  if (!row) return { ok: false, error: '搵唔到呢筆（可能唔屬於呢個戶口或者月份）' }
  if (row.cheque) return { ok: false, error: `已經出咗票 #${row.cheque.chequeNo}` }
  if (row.blocker) return { ok: false, error: row.blocker }
  return { ok: true, payee: cleanPayee(row.payee!), amount: row.amount, clinicId: row.clinicId }
}
