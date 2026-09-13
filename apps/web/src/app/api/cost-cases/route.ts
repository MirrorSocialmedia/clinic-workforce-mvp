import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { hkDateStart, hkDateEnd } from '@/lib/hk-date'
import { deriveCostPeriod } from '@/lib/cost-entry/period-month'

// ============================================================
// GET /api/cost-cases — List cost cases
// Roles: OWNER, MANAGER (cost_entry via perm override)
// Query: ?providerId=&periodMonth=&category=&status=&clinicId=
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const providerId = searchParams.get('providerId')
  const periodMonth = searchParams.get('periodMonth')
  const category = searchParams.get('category')
  const status = searchParams.get('status')
  const clinicId = searchParams.get('clinicId')
  const labId = searchParams.get('labId')
  const unlocked = searchParams.get('unlocked')
  // ★ cwm-costentry-20260827 §2：病人搜尋（編號/姓名，insensitive 部分匹配）
  const q = searchParams.get('q')?.trim()
  // ★ 2026-08-28 cwm-matedit T2 §2：兩個日期模式 — 'ordered'（按落單日，預設，兼容舊行為）/ 'received'（按到貨日 = periodMonth）
  const dateMode: 'ordered' | 'received' = searchParams.get('dateMode') === 'received' ? 'received' : 'ordered'

  // ★ 2026-08-28 cwm-costfix §2.2：統計用 baseWhere（唔含月份條件）分開砌，
  //   列表用 where（由 baseWhere 推導 + 月份條件）—— 唔好由主 where 推導，容易漏。
  const baseWhere: any = {}
  if (providerId) baseWhere.providerId = providerId
  if (category) baseWhere.category = category
  if (status) baseWhere.status = status
  if (clinicId) baseWhere.clinicId = clinicId
  if (labId) baseWhere.labId = labId
  if (unlocked === '1') baseWhere.lockedByRunId = null
  // ★ cwm-costentry-20260827 §2：病人搜尋（編號/姓名，insensitive 部分匹配）
  if (q) {
    baseWhere.AND = [
      { OR: [
        { patientCode: { contains: q, mode: 'insensitive' } },
        { patientName: { contains: q, mode: 'insensitive' } },
      ] },
    ]
  }

  // MANAGER scope: only see their clinics
  if (scope === 'my-clinics' && session.clinics && session.clinics.length > 0) {
    baseWhere.clinicId = { in: session.clinics }
  }

  const where: any = { ...baseWhere }
  if (periodMonth) {
    // ★ 2026-08-28 cwm-matedit T2 §2：兩個日期模式（取代 cwm-costfix 嘅 OR 補丁）
    if (dateMode === 'received') {
      // ★#15 按到貨日 — periodMonth 直接 match；未到貨（NULL）自然唔 match
      where.periodMonth = periodMonth
    } else {
      // ★#12 到貨月唔同都照出現（orderedAt 範圍唔睇 periodMonth）
      // ★#13 落單唔喺該月就唔出現
      // ⚠️ 頂層 key（唔放 AND 陣列）— 同 baseWhere.AND（q 搜尋）、clinic scope 自然 AND（★#20）
      // ⚠️ 範圍本身已包含 periodMonth NULL 個案 — cwm-costfix「未到貨唔消失」守則保留
      const [yy, mm] = periodMonth.split('-').map(Number)
      const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate()
      where.orderedAt = {
        gte: hkDateStart(`${periodMonth}-01`),
        lte: hkDateEnd(`${periodMonth}-${String(lastDay).padStart(2, '0')}`),
      }
    }
  } else if (dateMode === 'received') {
    // ★★#21 全部月份 + 按到貨日 → 只出有到貨日嘅（未到貨 NULL 唔出）
    where.periodMonth = { not: null }
  }

  const [cases, totals] = await prisma.$transaction([
    prisma.costCase.findMany({
      where,
      // ★ 2026-08-28 cwm-costfix §7.2.4：「全部月份」＝撈晒所有 CostCase ——
      //   而家幾百筆冇問題，上到幾萬筆前先用 take 上限擋住（summary 仲計全數）
      take: 500,
      orderBy: { orderedAt: 'desc' },
      include: {
        lab: { select: { id: true, name: true } },
        // ★ cwm-payoutcost-fix-20260908 P0-2：次序要確定 —— PUT 逐位比對「有冇改」靠佢
        materials: { orderBy: { id: 'asc' } },
      },
    }),
    prisma.costCase.aggregate({
      where,
      _sum: { finalCost: true, baseCost: true },
      _count: true,
    }),
  ])

  // Count without baseCost
  const unpriced = await prisma.costCase.count({
    where: { ...where, baseCost: null },
  })

  // ★ 2026-08-28 cwm-matedit T2 §2：分模式統計（★#16 到貨日模式總額 = 醫生月結扣嘅成本）
  //   計數均限縮喺主 where（含月份條件）；⚠️ marker 計數排除 VOID（作廢單唔入月結討論），
  //   count / pricedTotal 用全量（同舊 total 口徑一致）。
  const pricedTotal = totals._sum.finalCost ? Number(totals._sum.finalCost) : 0
  const markerWhere = (extra: any) => ({ ...where, status: { not: 'VOID' }, ...extra })
  // noPriceCount = 範圍入面 finalCost null（ordered 模式含未到貨；received 模式 = 已到貨未有價）
  const noPriceCount = await prisma.costCase.count({ where: markerWhere({ finalCost: null }) })
  let notReceivedCount = 0
  let receivedOtherMonthCount = 0
  if (dateMode === 'ordered' && periodMonth) {
    // ordered + 指定月：notReceivedCount = orderedAt 喺該月但 periodMonth null（未到貨）
    // ★#17 receivedOtherMonthCount = orderedAt 喺該月但到貨喺**其他月**（「31/7 落單、6/8 到貨」唔入 7 月月結）
    ;[notReceivedCount, receivedOtherMonthCount] = await prisma.$transaction([
      prisma.costCase.count({ where: markerWhere({ periodMonth: null }) }),
      // ⚠️ Prisma `not` = SQL `!=`，NULL row 自然唔 match — 一個 not 已經排除未到貨
      prisma.costCase.count({ where: markerWhere({ periodMonth: { not: periodMonth } }) }),
    ])
  } else if (dateMode === 'ordered') {
    // 全部月份：未到貨仍然有意義（兼容 cwm-costfix）；「到貨其他月」冇參考月 → 0
    notReceivedCount = await prisma.costCase.count({ where: markerWhere({ periodMonth: null }) })
  }

  // Group by lab
  const labGroups: Record<string, { count: number; total: number }> = {}
  for (const c of cases) {
    let key: string | null = null
    if (c.lab) {
      key = c.lab.name
    } else if (c.labOther) {
      key = `other:${c.labOther}`
    } else if (c.labId === null) {
      // skip — no lab selected
    }
    if (!key) continue
    if (!labGroups[key]) labGroups[key] = { count: 0, total: 0 }
    labGroups[key].count++
    const fc = c.finalCost ? Number(c.finalCost) : 0
    labGroups[key].total += fc
  }

  // ★ cwm-payoutcost-20260908 C1/D1：材料名 + 醫生名由 server 解析
  //   ⚠️ CostCaseMaterial.materialItemId 同 CostCase.providerId 都係裸 String（schema 冇 relation）
  //      → 做唔到 include，照 payout-runs/route.ts:30-35 手動 map
  //   ★★ 呢兩條 query 一律【唔准】加 isActive / 日期窗口 filter ——
  //      重點就係要撈到已停用／已過期嘅版本同已停用嘅醫生，否則就係而家個 bug
  const materialItemIds = [...new Set(cases.flatMap(c => c.materials.map(m => m.materialItemId)))]
  const materialRows = materialItemIds.length > 0
    ? await prisma.materialItem.findMany({
        where: { id: { in: materialItemIds } },
        // ★ cwm-payoutcost-fix-20260908 P0-2/P1-1：連主檔價一齊帶落去，
        //   修改 modal 先判斷得到「有冇覆寫」同「主檔有冇價」
        select: { id: true, name: true, unitPrice: true },
      })
    : []
  const materialRowById = new Map(materialRows.map(m => [m.id, m]))

  // ★ P0-2：呢隻材料名而家仲有冇 active 版本？冇 = 已更名／全停用 →
  //   修改 modal 要明明白白話俾用戶知，唔好留白等佢亂揀
  const usedNames = [...new Set(materialRows.map(r => r.name))]
  const activeRows = usedNames.length > 0
    ? await prisma.materialItem.findMany({
        where: { name: { in: usedNames }, isActive: true },
        select: { name: true },
        distinct: ['name'],
      })
    : []
  const activeNames = new Set(activeRows.map(r => r.name))

  const providerIds = [...new Set(cases.map(c => c.providerId))]
  const providerRows = providerIds.length > 0
    ? await prisma.provider.findMany({
        where: { id: { in: providerIds } },
        select: { id: true, name: true, shortName: true },
      })
    : []
  const providerById = new Map(providerRows.map(p => [p.id, p]))

  // Serialize Decimal fields for JSON
  const serializedCases = cases.map(c => ({
    ...c,
    baseCost: c.baseCost ? Number(c.baseCost) : null,
    discountPct: c.discountPct ? Number(c.discountPct) : null,
    finalCost: c.finalCost ? Number(c.finalCost) : null,
    // ★ C1/D1
    provider: providerById.get(c.providerId) ?? null,
    materials: c.materials.map(m => ({
      ...m,
      materialName: materialRowById.get(m.materialItemId)?.name ?? null,
      // ★ P1-1：呢個【版本】嘅主檔價（唔係今日最新版嘅價）
      materialMasterPrice: materialRowById.get(m.materialItemId)?.unitPrice != null
        ? Number(materialRowById.get(m.materialItemId)!.unitPrice)
        : null,
      // ★ P0-2：呢個名而家仲揀唔揀得返
      materialResolvable: activeNames.has(materialRowById.get(m.materialItemId)?.name ?? ''),
      unitPriceUsed: Number(m.unitPriceUsed),
      subtotal: Number(m.subtotal),
    })),
  }))

  return jsonNoStore({
    cases: serializedCases,
    summary: {
      // ★ cwm-matedit T2 §2：mode tag + 分模式字段（前端底部標記跟 mode 顯）
      mode: dateMode,
      count: totals._count,
      pricedTotal,
      noPriceCount,
      notReceivedCount,
      receivedOtherMonthCount,
      // —— 兼容舊字段 ——
      total: totals._count,
      totalFinalCost: totals._sum.finalCost ? Number(totals._sum.finalCost) : null,
      totalBaseCost: totals._sum.baseCost ? Number(totals._sum.baseCost) : null,
      unpricedCount: unpriced,
      labGroups,
    },
  })
}

// ============================================================
// POST /api/cost-cases — Create a cost case (LAB / INVISALIGN)
// Roles: OWNER, MANAGER
// Body: { providerId, clinicId, category, patientCode, patientName?,
//         orderedAt, itemType?, labId?, labOrderNo?, dsaName?,
//         baseCost?, discountPct?, receivedAt?, appointmentAt? }
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const body = await req.json()
  const {
    providerId, clinicId, category, patientCode, patientName,
    orderedAt, itemType, itemTypeOther, labId, labOther, labOrderNo, dsaName,
    baseCost, discountPct, receivedAt, appointmentAt,
    billExtId, billCode, billItemEleId, // ★ MD-F
    // ★ 2026-09-02 cwm-costnote：自由備註
    note,
  } = body

  if (!providerId || !clinicId || !category || !patientCode || !orderedAt) {
    return NextResponse.json(
      { error: 'providerId, clinicId, category, patientCode, orderedAt are required' },
      { status: 400 }
    )
  }

  if (!['LAB', 'INVISALIGN'].includes(category)) {
    return NextResponse.json({ error: 'IMPLANT 請用 POST /api/cost-cases/implant' }, { status: 400 })
  }

  // ★ 2026-09-02 cwm-costnote：備註最多 200 字（前端 maxLength 繞得過，後端兜底）
  if (note != null && String(note).length > 200) {
    return NextResponse.json({ error: '備註最多 200 字' }, { status: 400 })
  }

  // ★ cwm-implantdate-20260913：IMPLANT 強制跟落單日；LAB/INVISALIGN 維持跟到貨日（未到貨 = null）。
  //   （2026-08-27 拍板①嘅「跟到貨日」只保留畀 LAB/INVISALIGN：落單 7/25、到貨 8/5 → 計 8 月；
  //    未到貨（receivedAt null）→ periodMonth = null → 唔入任何月結，等補咗到貨日先計。）
  //   ⚠️ 上方 guard 而家會擋住 IMPLANT（400 導流去 /api/cost-cases/implant），
  //      呢個 IMPLANT branch 係 defensive（MD A3 要求三 route 導出邏輯統一）。
  const { receivedAt: effectiveReceivedAt, periodMonth } = deriveCostPeriod(category, orderedAt, receivedAt)

  // ★ Q2: Look up discount from LabMonthlyDiscount table (ignore body discountPct)
  //   ★ 2026-08-27：periodMonth null（未到貨）→ 冇月度折扣，finalCost = baseCost
  const effectiveLabId = labId || null
  let discountPctNum: number | null = null
  if (effectiveLabId && periodMonth) {
    const d = await prisma.labMonthlyDiscount.findUnique({
      where: { labId_periodMonth: { labId: effectiveLabId, periodMonth } },
      select: { discountPct: true },
    })
    discountPctNum = d ? Number(d.discountPct) : null
  }
  // ★ labOther（Others）冇折扣 —— 要折扣就正式建一個 Lab

  // Compute finalCost
  const baseCostNum = baseCost != null ? Number(baseCost) : null
  let finalCostNum: number | null = null
  if (baseCostNum != null && discountPctNum != null) {
    finalCostNum = Number((baseCostNum * (100 - discountPctNum) / 100).toFixed(2))
  } else if (baseCostNum != null) {
    finalCostNum = baseCostNum
  }

  // If no baseCost, status stays PENDING
  const status = baseCostNum != null ? 'PRICED' : 'PENDING'

  const caseData = await prisma.costCase.create({
    data: {
      providerId,
      clinicId,
      category,
      patientCode,
      patientName: patientName || null,
      orderedAt: new Date(orderedAt),
      itemType: itemType || null,
      itemTypeOther: itemTypeOther || null,
      labId: labId || null,
      labOther: labOther || null,
      labOrderNo: labOrderNo || null,
      dsaName: dsaName || null,
      baseCost: baseCostNum != null ? baseCostNum : null,
      discountPct: discountPctNum != null ? discountPctNum : null,
      finalCost: finalCostNum != null ? finalCostNum : null,
      receivedAt: effectiveReceivedAt,   // ★ IMPLANT = 落單日；LAB = 到貨日（deriveCostPeriod）
      appointmentAt: category === 'IMPLANT' ? null : (appointmentAt ? new Date(appointmentAt) : null),
      // ★ 2026-09-02 cwm-costnote：備註（trim；空字串 → null）
      note: note?.trim() || null,
      billExtId: billExtId || null,
      billCode: billCode || null,
      billItemEleId: billItemEleId || null,
      source: billExtId ? 'BILL_LINKED' : 'MANUAL',
      status,
      periodMonth,
      createdBy: session.userId,
    },
    include: {
      lab: { select: { id: true, name: true } },
    },
  })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'COST_CASE_CREATE',
      entity: 'CostCase',
      entityId: caseData.id,
      clinicId,
      beforeJson: null,
      afterJson: JSON.stringify({
        providerId, clinicId, category, patientCode,
        baseCost: baseCostNum, discountPct: discountPctNum,
        finalCost: finalCostNum, status,
        note: note?.trim() || null,
      }),
      notes: `新增成本記錄: ${category} ${patientCode} ${baseCostNum != null ? '$' + baseCostNum : '未有價'} (${periodMonth})`,
    },
  } as any)

  const result = {
    ...caseData,
    baseCost: caseData.baseCost ? Number(caseData.baseCost) : null,
    discountPct: caseData.discountPct ? Number(caseData.discountPct) : null,
    finalCost: caseData.finalCost ? Number(caseData.finalCost) : null,
  }

  return NextResponse.json({ case: result }, { status: 201 })
}
