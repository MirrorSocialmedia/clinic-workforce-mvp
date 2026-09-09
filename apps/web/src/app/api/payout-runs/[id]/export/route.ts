/**
 * GET /api/payout-runs/[id]/export — Excel 匯出（單頁月報，六區 layout）
 * ★ 2026-09-10 cwm-payoutxlsx-20260908 B 章：改用 exceljs 產生器（lib/payout/xlsx-report.ts）。
 *   六區：A 逐日 / B Lab（含 Invisalign）/ C Implant / D SP+REF / E 調整 / F 結算。
 *   ★ AA3 已廢（2026-09-08 老細拍板）：B 區（Lab）同 C 區（Implant）列病人姓名
 *     （來源 CostCase.patientName）；PAYOUT_EXPORT audit notes 標明「包含病人姓名」。
 * ★ 數字零改變（B 章唯一驗收）：攞數段照舊，舊 A/B/C/D/E 區金額由新六區重現
 *   （舊 G 付款逐筆 / H 工廠總覽（跨醫生）剷走 — 屬舊系統附加，MD 樣板六區冇）。
 * ★ MD-AC2 ②：付款方式欄由資料 derive（ORDER 固定次序，未知方式排最後）
 * ★ 費率（F 區手續費率行）= 由 allocation 快照反解（net = raw×(1−fee)）—
 *   allocation 落庫時費率已係 PaymentMethodRule resolve 快照（feePercentUsed），
 *   反解保證同舊 A 區 Weighted / engine gross 一分不差；D2 章 export resolveMethodRule 後可換即時費率。
 */
import { NextRequest } from 'next/server'
import ExcelJS from 'exceljs'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { toHKDateStr } from '@/lib/hk-date'
import { UNNAMED_VENDOR } from '@/lib/payout/engine'
import { buildDoctorSheet, type DoctorSheetData } from '@/lib/payout/xlsx-report'

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
const round2 = (n: number): number => Math.round(n * 100) / 100

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

  // ─── 付款逐筆（breakdownJson）→ A 區逐日 ─────────────────────
  const breakdown: any[] = (() => {
    // ★ 2026-08-26：新 breakdownJson = { allocations, vendors }；舊 run 係裸陣列 → normalize
    const raw: any = run.breakdownJson
    return Array.isArray(raw) ? raw : (raw?.allocations ?? [])
  })()

  // ★ 引擎 breakdownJson 含 countAsIncome=true 嘅行 ＋ FREE_SP（★ 2026-08-22：FREE_SP 計醫生收入，
  //   engine allocWhere 已收埋），CREDIT（countAsIncome=false）唔喺入面 —
  //   所以 CREDIT 嗰啲 allocation 要另外撈返嚟合併入 A 區（FREE_SP 排除防 double count）。
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
  // A 區用合併後全集（收入 + 不計入收入）
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

  // ─── A 區資料：全月逐日（冇收入嗰日 byMethod 傳 0 → 產生器留白） ──
  const [yy, mm] = run.periodMonth.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate()

  // E 區資料（SP 筆數逐日 + D 區行）
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

  // SP 筆數逐日（A 區新增欄；billTime 無嘅唔計）
  const spCountByDay = new Map<string, number>()
  for (const sp of spConfirmed) {
    const bill = sp.billExtId ? billByExt.get(sp.billExtId) : null
    const t = bill?.billTime
    if (!t) continue
    const dk = toHKDateStr(new Date(t))
    spCountByDay.set(dk, (spCountByDay.get(dk) ?? 0) + 1)
  }

  // ─── 費率（F 區手續費率行）：由 allocation 快照反解（見檔頭註） ───
  const feeFor = (m: string): number => {
    let raw = 0
    let net = 0
    for (const dayM of dayMap.values()) {
      const v = dayM.get(m)
      if (v) {
        raw += v.raw
        net += v.net
      }
    }
    if (raw === 0) return 0
    const fee = 1 - net / raw
    return fee > 0 ? fee : 0
  }

  // ─── C / D 區：成本明細（B 區 = LAB + INVISALIGN；C 區 = IMPLANT）──
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
  const invCases = costs.filter(c => c.category === 'INVISALIGN')
  const implantCases = costs.filter(c => c.category === 'IMPLANT')

  // 材料名（MaterialItem 冇 relation field，另查）
  const materialIds = [...new Set(implantCases.flatMap(c => c.materials.map(m => m.materialItemId)))]
  const materialItems = materialIds.length
    ? await prisma.materialItem.findMany({ where: { id: { in: materialIds } }, select: { id: true, name: true } })
    : []
  const materialName = new Map(materialItems.map(mi => [mi.id, mi.name]))

  // ★ 2026-08-25：dsaName 係助護唔係工廠 —— 剔走 fallback
  const vendorOf = (c: any): string => String(c.lab?.name || c.labOther || '')

  // ─── 砌 DoctorSheetData（六區 layout，由產生器出） ──────────────
  // ★ 口徑對齊 engine（lib/payout/engine.ts）：
  //   gross = Σ 全 method net（CREDIT/FREE_SP 都計）→ F 區收入淨額 TOTAL
  //   labRows 必傳 LAB + INVISALIGN 兩類（engine profit 要減 invisalignCost）
  //   SP/REF 金額 = base × rate（rate 小數；base 折入 headcount/qty）
  const days: DoctorSheetData['days'] = []
  for (let day = 1; day <= daysInMonth; day++) {
    const dk = `${run.periodMonth}-${String(day).padStart(2, '0')}`
    const dayM = dayMap.get(dk)
    const byMethod: Record<string, number> = {}
    for (const m of seenMethods) {
      byMethod[m] = money(dayM?.get(m)?.raw ?? 0)
    }
    days.push({
      date: `${String(day).padStart(2, '0')}/${String(mm).padStart(2, '0')}`,
      byMethod,
      spCount: spCountByDay.get(dk) ?? 0,
    })
  }

  const labRows = [...labCases, ...invCases].map(c => ({
    vendor: vendorOf(c) || UNNAMED_VENDOR,
    orderedAt: ddMM(c.orderedAt),
    patientCode: String(c.patientCode || ''),
    patientName: String(c.patientName || ''), // 規則⑤：病人姓名可列（2026-09-08 拍板）
    itemType: String(c.itemType || c.itemTypeOther || ''),
    amount: money(c.finalCost),
  }))

  // C 區：IMPLANT 材料逐筆（單價 = unitPriceUsed 快照，規則②）；
  // 冇材料行 → case 成本直出（qty=1 × finalCost，同舊 export fallback 口徑）
  const implantRows: DoctorSheetData['implantRows'] = []
  for (const c of implantCases) {
    const patientCode = String(c.patientCode || '')
    const patientName = String(c.patientName || '') // 規則⑤
    if (c.materials.length > 0) {
      for (const mat of c.materials) {
        // 防呆：DB subtotal 同 qty×單價 唔一致（手改過）→ 公式重算值會偏舊出口徑
        if (Math.abs(num(mat.subtotal) - num(mat.qty) * num(mat.unitPriceUsed)) > 0.005) {
          console.warn(`[payout-export] 材料 subtotal 同 qty×單價 唔一致（case ${c.id}）：subtotal=${mat.subtotal}, qty×price=${num(mat.qty) * num(mat.unitPriceUsed)}`)
        }
        implantRows.push({
          patientCode,
          patientName,
          orderedAt: ddMM(c.orderedAt),
          material: mat.note?.trim() || materialName.get(mat.materialItemId) || mat.materialItemId, // ★ 2026-08-22：Other 材料顯示手動填嘅材料名（note 優先）
          qty: mat.qty,
          unitPrice: money(mat.unitPriceUsed),
        })
      }
    } else {
      implantRows.push({
        patientCode,
        patientName,
        orderedAt: ddMM(c.orderedAt),
        material: String(c.itemType || c.itemTypeOther || ''),
        qty: 1,
        unitPrice: money(c.finalCost),
      })
    }
  }

  // D 區：SP（2人補貼）—— amount = (listPrice−actualPrice)×split%×headcount
  const spRows = spConfirmed.map(sp => {
    const bill = sp.billExtId ? billByExt.get(sp.billExtId) : null
    const base = round2((num(sp.listPrice) - num(sp.actualPrice)) * sp.headcount)
    const rate = num(sp.splitPercent) / 100
    if (Math.abs(round2(base * rate) - num(sp.amount)) > 0.005) {
      console.warn(`[payout-export] SP ${sp.id} amount=${sp.amount} ≠ base×rate=${round2(base * rate)}（手改過？）`)
    }
    return {
      billCode: bill?.code || sp.billExtId,
      date: bill ? ddMM(bill.billTime) : '',
      patientName: '', // SpSubsidy 無病人欄
      desc: String(sp.itemDes || ''),
      base,
      rate,
    }
  })

  // D 區：REF（轉介收入）—— amount = unitPrice×qty×ref%
  const refRows = refConfirmed.map(ref => {
    const bill = ref.billExtId ? billByExt.get(ref.billExtId) : null
    const base = ref.unitPrice != null ? round2(num(ref.unitPrice) * ref.qty) : 0
    const rate = num(ref.refPercent) / 100
    if (Math.abs(round2(base * rate) - num(ref.amount ?? 0)) > 0.005) {
      console.warn(`[payout-export] REF ${ref.id} amount=${ref.amount} ≠ base×rate=${round2(base * rate)}（手改過？）`)
    }
    return {
      billCode: ref.billCode || bill?.code || ref.billExtId || '',
      date: bill ? ddMM(bill.billTime) : '',
      patientName: '', // ProviderReferral 無病人欄（只有 patientNote）
      desc: String(ref.itemDes || ''),
      base,
      rate,
    }
  })

  // E 區：調整
  const adjRows = adjustments.map(adj => ({
    refCode: String(adj.refCode || ''),
    date: ddMM(adj.createdAt),
    reason: String(adj.reason || ''),
    note: String(adj.note || ''),
    amount: money(adj.amount),
  }))

  const data = {
    providerName,
    clinicName,
    periodMonth: run.periodMonth,
    // LOCKED → 帶鎖定日期；DRAFT → 草稿提示（同舊 title statusSuffix 同信息）
    status:
      run.status === 'LOCKED' && run.lockedAt
        ? `LOCKED（已鎖定 ${ddMyy(run.lockedAt)}）`
        : 'DRAFT（草稿 — 數字可能會變）',
    methods: seenMethods.map(m => ({
      key: m,
      label: METHOD_LABELS[m] || m,
      feePercent: feeFor(m),
      countAsIncome: !NON_INCOME.has(m),
    })),
    days,
    labRows,
    implantRows,
    spRows,
    refRows,
    adjRows,
    percentUsed: num(run.percentUsed) / 100, // DB 存百分數（50）→ 產生器用小數（0.5）
  }

  // ─── Build workbook（單 sheet，sheet 名 = 醫生名） ─────────────
  const wb = new ExcelJS.Workbook()
  buildDoctorSheet(wb, data)

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: auth.session!.userId,
      action: 'PAYOUT_EXPORT',
      entity: 'PayoutRun',
      entityId: run.id,
      // ★ 規則⑤：匯出包含病人姓名（B/C 區）— 審計要查得返
      notes: `匯出月度收入報表：${run.periodMonth}（包含病人姓名）`,
    },
  })

  // Generate buffer
  const buf = await wb.xlsx.writeBuffer()

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
