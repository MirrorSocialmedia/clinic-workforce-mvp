/**
 * GET /api/payout-runs/[id]/export — Excel 匯出（單頁月結單，7 個區塊 A/B/C/D/E/G）
 * ★ AA3: 唔帶病人姓名，只帶病人編號（PII 零容忍）
 * ★ MD-AC2: 四個 sheet → 一個 sheet「月結單」
 *   ① 逐日收款全月逐日出（冇收入嗰日留白唔寫 0）
 *   ② 付款方式欄由資料 derive（ORDER 固定次序，未知方式排最後）
 *   ③ Credit / Free SP 欄標「不計入收入」，Weighted 格寫 — 唔寫 0
 */
import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { toHKDateStr } from '@/lib/hk-date'

// ★ MD-AC2 ②：付款方式固定次序（同月結單頁一致），未知方式排最後
const METHOD_ORDER = ['CASH', 'HCV', 'VISA', 'MASTERCARD', 'OCTOPUS', 'FPS', 'ALIPAY', 'CCF', 'CREDIT', 'FREE_SP']
// ★ MD-AC2 ③：Credit / Free SP 唔計入收入
const METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  HCV: 'HCV',
  VISA: 'Visa',
  MASTERCARD: 'Master',
  OCTOPUS: 'Octopus',
  FPS: 'FPS',
  ALIPAY: 'Alipay',
  CCF: 'CCF',
  CREDIT: 'Credit（不計入收入）',
  FREE_SP: 'Free SP（不計入收入）',
}
const NON_INCOME = new Set(['CREDIT', 'FREE_SP'])

const num = (v: unknown): number => Number(v ?? 0)
const money = (v: unknown): number => Number(num(v).toFixed(2))

/** ISO/Date → dd/MM（HK 時區） */
function ddMM(v: string | Date | null | undefined): string {
  if (!v) return ''
  const d = typeof v === 'string' ? new Date(v) : v
  if (isNaN(+d)) return ''
  const s = toHKDateStr(d) // YYYY-MM-DD
  return `${s.slice(8, 10)}/${s.slice(5, 7)}`
}

/** ISO/Date → dd/M/yyyy（HK 時區，17/8/2026） */
function ddMyy(v: string | Date | null | undefined): string {
  if (!v) return ''
  const d = typeof v === 'string' ? new Date(v) : v
  if (isNaN(+d)) return ''
  return d.toLocaleDateString('en-GB', { timeZone: 'Asia/Hong_Kong' })
}

type Cell = string | number

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
    select: { id: true, name: true, shortName: true, apricotId: true },
  })
  const clinic = run.clinicId
    ? await prisma.clinic.findUnique({
        where: { id: run.clinicId },
        select: { id: true, name: true, shortName: true, apricotClinicId: true },
      })
    : null

  const providerName = provider?.name || '未知'
  const providerShort = provider?.shortName || provider?.name || '未知'
  const clinicName = clinic?.shortName || clinic?.name || '—'
  const clinicShort = clinic?.shortName || clinic?.name || '診所'

  // ─── 標題行 ─────────────────────────────────────────────────────
  // LOCKED → 「已鎖定 17/8/2026」；DRAFT → 「【草稿 — 數字可能會變】」
  const statusSuffix =
    run.status === 'LOCKED' && run.lockedAt
      ? `已鎖定 ${ddMyy(run.lockedAt)}`
      : '【草稿 — 數字可能會變】'
  const title = `${providerName} · ${clinicName} · ${run.periodMonth} 月結單　${statusSuffix}`

  // ─── 付款逐筆（breakdownJson）→ A 區逐日 + G 區 ─────────────────
  const breakdown: any[] = (run.breakdownJson as any[]) || []

  // ★ 引擎 breakdownJson 含 countAsIncome=true 嘅行 ＋ FREE_SP（★ 2026-08-22：FREE_SP 計醫生收入，
  //   engine allocWhere 已收埋），CREDIT（countAsIncome=false）唔喺入面 —
  //   所以 CREDIT 嗰啲 allocation 要另外撈返嚟合併入 A/G 區（FREE_SP 排除防 double count）。
  const extraWhere: any = {
    providerExtId: provider?.apricotId,
    periodMonth: run.periodMonth,
    isVoid: false,
    isSuperseded: false,
    countAsIncome: false,
    methodNorm: { not: 'FREE_SP' },
  }
  if (clinic?.apricotClinicId) extraWhere.clinicExtId = clinic.apricotClinicId
  const extraAllocs = await prisma.paymentAllocation.findMany({
    where: extraWhere,
    select: {
      methodNorm: true, amount: true, netAmount: true,
      feePercentUsed: true, paidAt: true, billExtId: true,
    },
  })
  const extraBillCodes = new Map<string, string>(
    (extraAllocs.length
      ? await prisma.apricotBill.findMany({
          where: { extId: { in: [...new Set(extraAllocs.map(a => a.billExtId))] } },
          select: { extId: true, code: true },
        })
      : []
    ).map(b => [b.extId, b.code]),
  )
  const extraRows: any[] = extraAllocs.map(a => ({
    method: a.methodNorm,
    rawAmount: Number(a.amount),
    netAmount: Number(a.netAmount),
    feePercentUsed: Number(a.feePercentUsed),
    paidAt: a.paidAt,
    billCode: extraBillCodes.get(a.billExtId) ?? '',
    countAsIncome: false,
  }))
  // A / G 區用合併後全集（收入 + 不計入收入）
  const allRows: any[] = [...breakdown, ...extraRows]

  // ★ MD-AC2 ②：付款方式欄由資料 derive（唔好寫死欄位）
  const seenMethods: string[] = []
  for (const b of allRows) {
    const m = String(b.method ?? '').trim()
    if (m && !seenMethods.includes(m)) seenMethods.push(m)
  }
  // ★ Fix CASH-last bug — MD 原始公式 (idx+99)%100 會把 ORDER[0]=CASH 排最後（modulo wrap），
  //   同 MD 自己 A 區樣板（Cash 打頭）矛盾。改成：已知方式按 ORDER index，
  //   未知方式（AMEX 等）排最後、按首次出現次序。
  const firstSeenIdx = new Map<string, number>(seenMethods.map((m, i) => [m, i]))
  seenMethods.sort((a, b) => {
    const ra = METHOD_ORDER.indexOf(a)
    const rb = METHOD_ORDER.indexOf(b)
    if (ra !== -1 && rb !== -1) return ra - rb
    if (ra !== -1) return -1
    if (rb !== -1) return 1
    return (firstSeenIdx.get(a) ?? 0) - (firstSeenIdx.get(b) ?? 0)
  })

  // dateKey(YYYY-MM-DD, HK) → method → { raw, net }
  const dayMap = new Map<string, Map<string, { raw: number; net: number }>>()
  for (const b of allRows) {
    const dk = b.paidAt ? toHKDateStr(new Date(b.paidAt)) : ''
    if (!dk) continue
    const m = String(b.method ?? '').trim()
    let dayM = dayMap.get(dk)
    if (!dayM) {
      dayM = new Map()
      dayMap.set(dk, dayM)
    }
    const cur = dayM.get(m) ?? { raw: 0, net: 0 }
    cur.raw += num(b.rawAmount)
    cur.net += num(b.netAmount)
    dayM.set(m, cur)
  }

  // ─── A 區：逐日收款（全月逐日出，冇收入留白） ───────────────────
  const [yy, mm] = run.periodMonth.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate()

  const aRows: Cell[][] = [
    ['A  逐日收款'],
    ['日期', ...seenMethods.map(m => METHOD_LABELS[m] || m), 'TOTAL'],
  ]
  for (let day = 1; day <= daysInMonth; day++) {
    const dk = `${run.periodMonth}-${String(day).padStart(2, '0')}`
    const dayM = dayMap.get(dk)
    const row: Cell[] = [`${String(day).padStart(2, '0')}/${String(mm).padStart(2, '0')}`]
    let dayTotal = 0
    for (const m of seenMethods) {
      const v = dayM?.get(m)
      // ★ 冇收入嗰日留白（留白 = 冇交易；0 = 有交易但金額零）
      if (v && v.raw !== 0) row.push(money(v.raw))
      else row.push('')
      // TOTAL 只計入收入方式（Credit / Free SP 唔計）
      if (v && !NON_INCOME.has(m)) dayTotal += v.raw
    }
    row.push(dayTotal !== 0 ? money(dayTotal) : '')
    aRows.push(row)
  }
  // Total 行（原始金額）
  const totalRow: Cell[] = ['Total']
  let grandRaw = 0
  for (const m of seenMethods) {
    let s = 0
    for (const dayM of dayMap.values()) {
      const v = dayM.get(m)
      if (v) s += v.raw
    }
    totalRow.push(s !== 0 ? money(s) : '')
    if (!NON_INCOME.has(m)) grandRaw += s
  }
  totalRow.push(money(grandRaw))
  aRows.push(totalRow)
  // Weighted 行（扣費後）— Credit / Free SP 格寫 — 唔好寫 0
  const weightedRow: Cell[] = ['Weighted']
  let grandNet = 0
  for (const m of seenMethods) {
    if (NON_INCOME.has(m)) {
      weightedRow.push('—')
      continue
    }
    let s = 0
    for (const dayM of dayMap.values()) {
      const v = dayM.get(m)
      if (v) s += v.net
    }
    weightedRow.push(s !== 0 ? money(s) : '')
    grandNet += s
  }
  weightedRow.push(money(grandNet))
  aRows.push(weightedRow)

  // ─── E 區資料先攞埋（B 區 label 要轉介費率） ─────────────────────
  const spWhere: any = {
    providerId: run.providerId,
    periodMonth: run.periodMonth,
    status: 'CONFIRMED',
  }
  if (run.clinicId) spWhere.clinicId = run.clinicId
  const spConfirmed = await prisma.spSubsidy.findMany({ where: spWhere, orderBy: { id: 'asc' } })

  const refWhere: any = {
    fromProviderId: run.providerId,
    periodMonth: run.periodMonth,
    status: 'CONFIRMED',
  }
  if (run.clinicId) refWhere.clinicId = run.clinicId
  const refConfirmed = await prisma.providerReferral.findMany({ where: refWhere, orderBy: { createdAt: 'asc' } })

  const adjustments = await prisma.payoutAdjustment.findMany({
    where: { runId: run.id },
    orderBy: { createdAt: 'asc' },
  })

  // 帳單編號 + 日期（由 ApricotBill 解出）
  const billExtIds = [
    ...new Set(
      [...spConfirmed.map(s => s.billExtId), ...refConfirmed.map(r => r.billExtId)].filter(Boolean) as string[],
    ),
  ]
  const bills = billExtIds.length
    ? await prisma.apricotBill.findMany({
        where: { extId: { in: billExtIds } },
        select: { extId: true, code: true, billTime: true },
      })
    : []
  const billByExt = new Map(bills.map(b => [b.extId, b]))

  // ─── B 區：結算摘要（同月結單頁逐個對得上） ─────────────────────
  const refPcts = new Set(refConfirmed.map(r => Number(r.refPercent)))
  const refLabel = refPcts.size === 1 ? `轉介 ${[...refPcts][0]}%` : '轉介收入'
  const bRows: Cell[][] = [
    ['B  結算摘要'],
    ['Gross（Weighted）', money(run.grossAmount), '已扣手續費'],
    ['Lab 成本', -money(run.labCost), '見 C 區'],
    ['Implant 成本', -money(run.implantCost), '見 D 區'],
    ['Invisalign 成本', -money(run.invisalignCost)],
    ['利潤', money(run.profitAmount)],
    [`拆帳 ${num(run.percentUsed)}%`, money(run.salaryAmount)],
    ['2人SP 補貼', money(run.spSubsidy), '見 E 區'],
    [refLabel, money(run.refAmount), '見 E 區'],
    ['上期調整', money(run.adjustAmount)],
    ['總額', money(run.totalAmount)],
  ]
  // ★ 2026-08-22：FREE_SP 唔計店舖營收但計醫生收入 —— 單獨列一行（拍板③）
  //   同 A 區 dayMap 同一來源（allocation netAmount，同 Gross 口徑）；
  //   已 finalize 舊 run 嘅 Gross 未含 FREE_SP — 至 re-finalize 前「Gross+本行 ≠ 總額」係預期 one-off artifact
  let freeSpNet = 0
  for (const dayM of dayMap.values()) {
    const v = dayM.get('FREE_SP')
    if (v) freeSpNet += v.net
  }
  if (freeSpNet > 0) bRows.push(['Free SP（不計店舖營收，計醫生收入）', money(freeSpNet)])

  // ─── C / D 區：成本明細（只准 patientCode，❌ patientName） ─────
  const costWhere: any = {
    providerId: run.providerId,
    periodMonth: run.periodMonth,
    status: { not: 'VOID' },
  }
  if (run.clinicId) costWhere.clinicId = run.clinicId

  const costs = await prisma.costCase.findMany({
    where: costWhere,
    include: {
      lab: { select: { name: true } },
      materials: { select: { materialItemId: true, qty: true, unitPriceUsed: true, subtotal: true, note: true } },
    },
    orderBy: { orderedAt: 'asc' },
  })

  const labCases = costs.filter(c => c.category === 'LAB')
  const implantCases = costs.filter(c => c.category === 'IMPLANT')

  // 材料名（MaterialItem 冇 relation field，另查）
  const materialIds = [...new Set(implantCases.flatMap(c => c.materials.map(m => m.materialItemId)))]
  const materialItems = materialIds.length
    ? await prisma.materialItem.findMany({ where: { id: { in: materialIds } }, select: { id: true, name: true } })
    : []
  const materialName = new Map(materialItems.map(mi => [mi.id, mi.name]))

  const vendorOf = (c: any): string => String(c.lab?.name || c.labOther || c.dsaName || '')
  const cRows: Cell[][] = [
    ['C  Lab 成本明細'],
    ['落單日', '病人編號', '項目', '工場', '單號', 'DSA', '原價', '折扣%', '實計'],
  ]
  for (const c of labCases) {
    cRows.push([
      ddMM(c.orderedAt),
      String(c.patientCode || ''), // ★ 只准 patientCode
      String(c.itemType || c.itemTypeOther || ''),
      vendorOf(c),
      String(c.labOrderNo || ''),
      String(c.dsaName || ''),
      money(c.baseCost),
      money(c.discountPct),
      money(c.finalCost),
    ])
  }
  // C 小計 — 逐工場
  const labByVendor = new Map<string, number>()
  for (const c of labCases) {
    const v = vendorOf(c) || '其他'
    labByVendor.set(v, (labByVendor.get(v) || 0) + num(c.finalCost))
  }
  const labTotal = [...labByVendor.values()].reduce((a, b) => a + b, 0)
  const labVendorText = [...labByVendor.entries()].map(([k, v]) => `${k} ${money(v)}`).join(' · ')
  const cSubtotalRow: Cell[] = ['C 小計']
  for (let i = 1; i < 8; i++) cSubtotalRow.push(i === 2 ? labVendorText : '')
  cSubtotalRow.push(money(labTotal))
  cRows.push(cSubtotalRow)

  // D 區：植體成本（按病人分組，每組一小計行）
  const dRows: Cell[][] = [
    ['D  植體成本明細（按病人分組）'],
    ['落單日', '病人編號', '材料', '數量', '單價', '小計'],
  ]
  const byPatient = new Map<string, typeof implantCases>()
  for (const c of implantCases) {
    const k = String(c.patientCode || '')
    if (!byPatient.has(k)) byPatient.set(k, [])
    byPatient.get(k)!.push(c)
  }
  for (const [patient, cases] of byPatient) {
    let groupTotal = 0
    for (const c of cases) {
      if (c.materials.length > 0) {
        for (const mat of c.materials) {
          dRows.push([
            ddMM(c.orderedAt),
            patient,
            mat.note?.trim() || materialName.get(mat.materialItemId) || mat.materialItemId, // ★ 2026-08-22：Other 材料顯示手動填嘅材料名（note 優先）
            mat.qty,
            money(mat.unitPriceUsed),
            money(mat.subtotal),
          ])
          groupTotal += num(mat.subtotal)
        }
      } else {
        // 冇材料行 → 直接出 case 成本
        dRows.push([ddMM(c.orderedAt), patient, String(c.itemType || c.itemTypeOther || ''), 1, money(c.finalCost), money(c.finalCost)])
        groupTotal += num(c.finalCost)
      }
    }
    dRows.push([`${patient} 小計`, '', '', '', '', money(groupTotal)])
  }

  // ─── E 區：2人SP 補貼 ／ 轉介 2% ／ 調整 ────────────────────────
  const eRows: Cell[][] = [
    ['E  2人SP 補貼 ／ 轉介 2%'],
    ['類別', '帳單', '日期', '項目', '單價', '數量', '%', '金額'],
  ]
  for (const sp of spConfirmed) {
    const bill = billByExt.get(sp.billExtId)
    eRows.push([
      'SP',
      bill?.code || sp.billExtId,
      bill ? ddMM(bill.billTime) : '',
      String(sp.itemDes || ''),
      money(sp.listPrice),
      sp.headcount,
      `${num(sp.splitPercent)}%`,
      money(sp.amount),
    ])
  }
  for (const ref of refConfirmed) {
    const bill = ref.billExtId ? billByExt.get(ref.billExtId) : null
    eRows.push([
      'REF',
      ref.billCode || bill?.code || ref.billExtId || '',
      bill ? ddMM(bill.billTime) : '',
      String(ref.itemDes || ''),
      ref.unitPrice != null ? money(ref.unitPrice) : '',
      ref.qty,
      `${num(ref.refPercent)}%`,
      money(ref.amount),
    ])
  }
  for (const adj of adjustments) {
    eRows.push(['ADJ', String(adj.refCode || ''), '', `${adj.reason} — ${adj.note || ''}`, '', '', '', money(adj.amount)])
  }

  // ─── G 區：付款逐筆（由 breakdownJson，按日期排） ───────────────
  const gRows: Cell[][] = [
    [`G  付款逐筆（${allRows.length} 行）`],
    ['日期', '帳單編號', '付款方式', '原始', '費率', '淨額'],
    ...[...allRows]
      .sort((a, b) => String(a.paidAt ?? '').localeCompare(String(b.paidAt ?? '')))
      .map(b => [
        ddMM(b.paidAt),
        String(b.billCode || ''),
        String(b.method),
        money(b.rawAmount),
        num(b.feePercentUsed),
        money(b.netAmount),
      ]),
  ]

  // ─── Build workbook（單 sheet） ─────────────────────────────────
  const aoa: Cell[][] = [
    [title],
    [],
    ...aRows,
    [],
    ...bRows,
    [],
    ...cRows,
    [],
    ...dRows,
    [],
    ...eRows,
    [],
    ...gRows,
  ]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [
    { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 14 },
    { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '月結單')

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: auth.session!.userId,
      action: 'PAYOUT_EXPORT',
      entity: 'PayoutRun',
      entityId: run.id,
      notes: `匯出月結單：${run.periodMonth}`,
    },
  })

  // Generate buffer
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' })

  // ★ MD-AC2：檔名 ${providerShort}_${clinicShort}_${periodMonth}_月結單.xlsx
  //   中文檔名一定要 filename*=UTF-8''（部分瀏覽器純 filename="中文" 會亂碼）
  const name = `${providerShort}_${clinicShort}_${run.periodMonth}_月結單.xlsx`
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="payout_${run.periodMonth}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  })
}
