/**
 * GET /api/payout-runs/[id]/export — Excel export (4 sheets, no PII)
 * ★ AA3: 唔帶病人姓名，只帶病人編號
 */
import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const id = (await params).id

  const run = await prisma.payoutRun.findUnique({ where: { id } })
  if (!run) return jsonNoStore({ error: '月結單不存在' }, { status: 404 })

  const provider = await prisma.provider.findUnique({
    where: { id: run.providerId },
    select: { id: true, name: true, shortName: true },
  })
  const clinic = run.clinicId
    ? await prisma.clinic.findUnique({
        where: { id: run.clinicId },
        select: { id: true, name: true, shortName: true },
      })
    : null

  const providerLabel = provider?.shortName || provider?.name || '未知'

  // ─── Sheet 1: 摘要 ───────────────────────────────────────────────
  const summaryRows = [
    ['月結單摘要'],
    ['', ''],
    ['醫生', providerLabel],
    ['診所', clinic?.shortName || clinic?.name || '—'],
    ['月份', run.periodMonth],
    ['狀態', run.status === 'LOCKED' ? '已鎖定' : '草稿（未鎖定）'],
    ['', ''],
    ['原始收入', Number(run.rawAmount)],
    ['收入（扣手續費後）', Number(run.grossAmount)],
    ['Lab 成本', -Number(run.labCost)],
    ['Implant 成本', -Number(run.implantCost)],
    ['Invisalign 成本', -Number(run.invisalignCost)],
    ['利潤', Number(run.profitAmount)],
    ['拆帳%', run.percentUsed ? Number(run.percentUsed) : 0],
    ['拆帳金額', Number(run.salaryAmount)],
    ['2人SP補貼', Number(run.spSubsidy)],
    ['轉介收入', Number(run.refAmount)],
    ['上期調整', Number(run.adjustAmount)],
    ['', ''],
    ['總額', Number(run.totalAmount)],
  ]

  // ─── Sheet 2: 付款明細 ───────────────────────────────────────────
  const breakdownJson: any[] = (run.breakdownJson as any[]) || []
  const detailHeader = ['日期', '帳單編號', '付款方式', '原始金額', '費率(%)', '淨額']
  const detailRows = [detailHeader, ...breakdownJson.map((b: any) => [
    b.paidAt ? new Date(b.paidAt).toLocaleDateString('zh-HK') : '',
    String(b.billCode || ''),
    String(b.method),
    String(b.rawAmount ?? 0),
    String(b.feePercentUsed ?? 0),
    String(b.netAmount ?? 0),
  ])]

  // ─── Sheet 3: 成本明細 ───────────────────────────────────────────
  const costWhere: any = {
    providerId: run.providerId,
    periodMonth: run.periodMonth,
    status: { not: 'VOID' },
  }
  if (run.clinicId) costWhere.clinicId = run.clinicId

  const costs = await prisma.costCase.findMany({
    where: costWhere,
    include: { lab: { select: { name: true } } },
  })

  const costHeader = ['病人編號', '類別', '供應商', '報價', '最終成本']
  const costRows = [costHeader, ...costs.map((c: any) => [
    String(c.patientCode || ''),
    String(c.category),
    String(c.lab?.name || c.labOther || c.dsaName || ''),
    String(Number(c.baseCost || 0)),
    String(Number(c.finalCost || 0)),
  ])]

  // ─── Sheet 4: 補貼與轉介 ─────────────────────────────────────────
  const spWhere: any = {
    providerId: run.providerId,
    periodMonth: run.periodMonth,
  }
  if (run.clinicId) spWhere.clinicId = run.clinicId

  const spSubsidies = await prisma.spSubsidy.findMany({ where: spWhere })
  const refWhere: any = {
    fromProviderId: run.providerId,
    periodMonth: run.periodMonth,
  }
  if (run.clinicId) refWhere.clinicId = run.clinicId

  const referrals = await prisma.providerReferral.findMany({ where: refWhere })
  const adjustments = await prisma.payoutAdjustment.findMany({
    where: { runId: run.id },
  })

  const subsidyHeader = ['類型', '帳單編號', '項目', '數量', '金額']
  const subsidyRows = [subsidyHeader]

  for (const sp of spSubsidies) {
    subsidyRows.push([
      'SP補貼',
      String(sp.billExtId || ''),
      String(sp.itemDes || ''),
      String(sp.headcount || 0),
      String(Number(sp.amount)),
    ])
  }

  for (const ref of referrals) {
    subsidyRows.push([
      '轉介',
      String(ref.billExtId || ref.billCode || ''),
      String(ref.itemDes || ''),
      String(ref.qty || 0),
      String(Number(ref.amount || 0)),
    ])
  }

  for (const adj of adjustments) {
    subsidyRows.push([
      '調整',
      String(adj.refCode || ''),
      `${adj.reason} — ${adj.note || ''}`,
      '',
      String(Number(adj.amount)),
    ])
  }

  // ─── Build workbook ──────────────────────────────────────────────
  const wb = XLSX.utils.book_new()

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), '摘要')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detailRows), '付款明細')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(costRows), '成本明細')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(subsidyRows), '補貼與轉介')

  // Audit log
  await prisma.auditLog.create({ data: {
    actorId: auth.session!.userId,
    action: 'PAYOUT_EXPORT',
    entity: 'PayoutRun',
    entityId: run.id,
    notes: `匯出月結單：${run.periodMonth}`,
  }})

  // Generate buffer
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' })

  // 檔名：Dr.Lau_MF_2026-07_月結單.xlsx（唔帶病人資料）
  const name = `Dr.${providerLabel}_${run.periodMonth}_月結單.xlsx`
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="payout_${run.periodMonth}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  })
}
