/**
 * lib/payout/report-data.ts — 醫生頁月報攞數（cwm-payoutxlsx-20260908 C 步抽出）
 *
 * ★★★ MD 坑⑥：單張匯出（api/payout-runs/[id]/export）同全店月報
 * （api/payout-runs/clinic-report）必須 call 同一個 function —
 * 兩個入口各自寫一次 = 將來改一邊就出兩個唔同嘅數。
 *
 * 本檔 = B 步 export route 內攞數段嘅原封抽出（邏輯零改動）：
 *   run / provider / clinic / breakdown（+extraRows 合併 CREDIT 等不計收入 allocation）
 *   / dayMap / SP / REF / ADJ / CostCase（LAB+INVISALIGN+IMPLANT+材料）
 *   → 砌好 DoctorSheetData 交回。
 */
import { prisma } from '@/lib/prisma'
import { apricotIdsOfProvider } from '@/lib/apricot-accounts'
import { toHKDateStr } from '@/lib/hk-date'
import { UNNAMED_VENDOR } from '@/lib/payout/engine'
import type { DoctorSheetData } from '@/lib/payout/xlsx-report'
import type { PayoutRun } from '@prisma/client'

// ★ MD-AC2 ②：付款方式固定次序（同月結單頁一致），未知方式排最後
export const METHOD_ORDER = ['CASH', 'HCV', 'VISA', 'MASTERCARD', 'OCTOPUS', 'FPS', 'ALIPAY', 'CCF', 'CREDIT', 'FREE_SP']
// ★ MD-AC2 ③：Credit / Free SP 唔計【店舖營收】（countAsIncome=false）
//   ★ cwm-reconxlsx-fix-20260910 C：FREE_SP 另【計醫生收入】（engine.ts:377-381 gross OR list 包 FREE_SP）。
//   ★ cwm-payout P-1（2026-09-29）：括號提示由 methods[].label 依雙旗統一加（colKey 決定）——
//     CREDIT 欄 =「Credit（不計醫生收入）」、FREE_SP 欄 =「Free SP（不計店舖營收）」。
//     口徑由每筆 allocation 自己嘅 countAsIncome（付款方式規則）決定，唔再寫死名單；
//     解釋仍然出喺封面備註區（cwm-coverrevenue-20260914 A7）。
export const METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  HCV: 'HCV',
  VISA: 'Visa',
  MASTERCARD: 'Master',
  OCTOPUS: 'Octopus',
  FPS: 'FPS',
  ALIPAY: 'Alipay',
  CCF: 'CCF',
  CREDIT: 'Credit',
  FREE_SP: 'Free SP',
  CHEQUE: 'Cheque',
}
// ★ cwm-payout P-1：舊 run fallback 用 — breakdown 快照冇 countAsIncome 欄時
//   推 storeIncome（2026-09-14 前嘅寫死口徑：CREDIT/FREE_SP 唔計店舖營收）。
export const NON_INCOME = new Set(['CREDIT', 'FREE_SP'])

// ★ cwm-payout P-1：方法欄 key = 方法名 + 雙旗（storeIncome/doctorIncome）。
//   同一方法若月中改咗「付款方式規則」（countAsIncome 翻生），前後兩段口徑唔同 →
//   分開兩欄，否則成欄只可以有一個口徑。實際 99% 情況一個方法得一個 key，唔會多出欄。
export const colKey = (m: string, storeIncome: boolean, doctorIncome: boolean): string =>
  `${m}|${storeIncome ? 1 : 0}|${doctorIncome ? 1 : 0}`
/** colKey → 方法名部分（排序／封面合計用） */
export const methodOf = (key: string): string => key.split('|')[0]

/**
 * ★ cwm-payout P-1：colKey-aware 方法合計（clinic-report 封面 Free SP/Credit 用）。
 * key 而家係「方法|s|d」— 淨方法名 match 會漏；跟 methods[] 攞齊該方法所有 key 加總。
 */
export function sumMethodOf(
  methods: { key: string }[],
  byMethod: Record<string, number>,
  methodName: string,
): number {
  return methods
    .filter(mm => methodOf(mm.key) === methodName)
    .reduce((s, mm) => s + Number(byMethod[mm.key] ?? 0), 0)
}

// ★ cwm-coverrevenue-20260914 A4：封面撈 FREE_SP / CREDIT 合計用呢兩個常數 ——
//   要同 METHOD_ORDER 一致，唔准 hardcode 字串第二次。
export const KEY_FREE_SP = 'FREE_SP'
export const KEY_CREDIT = 'CREDIT'

export const num = (v: unknown): number => Number(v ?? 0)
export const money = (v: unknown): number => Number(num(v).toFixed(2))
export const round2 = (n: number): number => Math.round(n * 100) / 100

/** ISO/Date → dd/MM（HK 時區） */
export function ddMM(v: string | Date | null | undefined): string {
  if (!v) return ''
  const d = typeof v === 'string' ? new Date(v) : v
  if (isNaN(+d)) return ''
  const s = toHKDateStr(d) // YYYY-MM-DD
  return `${s.slice(8, 10)}/${s.slice(5, 7)}`
}

/** ISO/Date → dd/M/yyyy（HK 時區，17/8/2026） */
export function ddMyy(v: string | Date | null | undefined): string {
  if (!v) return ''
  const d = typeof v === 'string' ? new Date(v) : v
  if (isNaN(+d)) return ''
  return d.toLocaleDateString('en-GB', { timeZone: 'Asia/Hong_Kong' })
}

export interface DoctorSheetLoad {
  run: PayoutRun
  provider: { id: string; name: string; shortName: string | null } | null
  clinic: { id: string; name: string; shortName: string | null; apricotClinicId: string | null } | null
  data: DoctorSheetData
}

/**
 * 由 runId 攞齊醫生頁全部數據並砌好 DoctorSheetData。
 * run 不存在 → null（caller 決定 404 / skip）。
 */
export async function loadDoctorSheetData(runId: string, db: any = prisma): Promise<DoctorSheetLoad | null> {
  // ★ cwm-payout P-1 test：db 可選注入（parity test 用 fake prisma；預設 singleton 行為唔變）
  const run = await db.payoutRun.findUnique({ where: { id: runId } })
  if (!run) return null

  const provider = await db.provider.findUnique({
    where: { id: run.providerId },
    select: { id: true, name: true, shortName: true },
  })
  const clinic = run.clinicId
    ? await db.clinic.findUnique({
        where: { id: run.clinicId },
        select: { id: true, name: true, shortName: true, apricotClinicId: true },
      })
    : null

  const providerName = provider?.name || '未知'
  const clinicName = clinic?.shortName || clinic?.name || '—'

  // ─── 付款逐筆（breakdownJson）→ A 區逐日 ─────────────────────
  const breakdown: any[] = (() => {
    // ★ 2026-08-26：新 breakdownJson = { allocations, vendors }；舊 run 係裸陣列 → normalize
    const raw: any = run.breakdownJson
    return Array.isArray(raw) ? raw : (raw?.allocations ?? [])
  })()

  // ★ Stage 2：Provider 舊 apricotId 欄已剷走 —— 帳號由 ApricotPractitioner（唯一來源）攞。
  //   冇綁帳號 → extraAllocs 空（舊行為 providerExtId=null 會攞到別行，純 latent bug，唔再重現）。
  const providerApricotIds = provider ? await apricotIdsOfProvider(db, provider.id) : []
  // ★ 引擎 breakdownJson 含 countAsIncome=true 嘅行 ＋ FREE_SP（★ 2026-08-22：FREE_SP 計醫生收入，
  //   engine allocWhere 已收埋），CREDIT（countAsIncome=false）唔喺入面 —
  //   所以 CREDIT 嗰啲 allocation 要另外撈返嚟合併入 A 區（FREE_SP 排除防 double count）。
  const extraWhere: any = {
    providerExtId: { in: providerApricotIds },
    periodMonth: run.periodMonth,
    isVoid: false,
    isSuperseded: false,
    countAsIncome: false,
    methodNorm: { not: 'FREE_SP' },
  }
  if (clinic?.apricotClinicId) extraWhere.clinicExtId = clinic.apricotClinicId
  const extraAllocs: any[] = providerApricotIds.length > 0
    ? await db.paymentAllocation.findMany({
        where: extraWhere,
        select: {
          methodNorm: true, amount: true, netAmount: true,
          feePercentUsed: true, paidAt: true, billExtId: true,
        },
      })
    : []
  const extraBills: any[] = extraAllocs.length
    ? await db.apricotBill.findMany({
        where: { extId: { in: [...new Set(extraAllocs.map(a => a.billExtId))] } },
        select: { extId: true, code: true },
      })
    : []
  const extraBillCodes = new Map<string, string>(
    extraBills.map(b => [b.extId, b.code] as [string, string]),
  )
  // ★ cwm-payout P-1：雙旗 — 呢批 query 本身係 countAsIncome=false AND method≠FREE_SP
  //   → 店舖營收、醫生收入兩樣都唔計（CREDIT 等）
  const extraRows: any[] = extraAllocs.map(a => ({
    method: a.methodNorm,
    rawAmount: Number(a.amount),
    netAmount: Number(a.netAmount),
    feePercentUsed: Number(a.feePercentUsed),
    paidAt: a.paidAt,
    billCode: extraBillCodes.get(a.billExtId) ?? '',
    storeIncome: false,
    doctorIncome: false,
  }))
  // ★ cwm-payout P-1：breakdown（engine 快照）行加雙旗 —
  //   doctorIncome = true（engine allocWhere 只收 countAsIncome || FREE_SP = 計醫生收入嘅行）；
  //   storeIncome = 快照 countAsIncome（engine 寫入）；舊 run 冇該欄 → fallback 寫死口徑
  const flaggedBreakdown: any[] = breakdown.map(b => ({
    ...b,
    storeIncome: typeof b.countAsIncome === 'boolean'
      ? b.countAsIncome
      : !NON_INCOME.has(String(b.method ?? '').trim()),
    doctorIncome: true,
  }))
  // A 區用合併後全集（收入 + 不計入收入）
  const allRows: any[] = [...flaggedBreakdown, ...extraRows]

  // ★ MD-AC2 ②：付款方式欄由資料 derive（唔好寫死欄位）
  // ★ cwm-payout P-1：derive 嘅係 colKey（方法+雙旗）— 同一方法口徑翻生會多一欄
  const seenKeys: string[] = []
  for (const b of allRows) {
    const m = String(b.method ?? '').trim()
    if (!m) continue
    const k = colKey(m, !!b.storeIncome, !!b.doctorIncome)
    if (!seenKeys.includes(k)) seenKeys.push(k)
  }
  // ★ Fix CASH-last bug — MD 原始公式 (idx+99)%100 會把 ORDER[0]=CASH 排最後（modulo wrap），
  //   同 MD 自己 A 區樣板（Cash 打頭）矛盾。改成：已知方式按 ORDER index，
  //   未知方式（AMEX 等）排最後、按首次出現次序。
  // ★ cwm-payout P-1：排序照 METHOD_ORDER 用【方法名部分】（旗唔該影響次序）
  const firstSeenIdx = new Map<string, number>(seenKeys.map((k, i) => [k, i]))
  seenKeys.sort((a, b) => {
    const ra = METHOD_ORDER.indexOf(methodOf(a))
    const rb = METHOD_ORDER.indexOf(methodOf(b))
    if (ra !== -1 && rb !== -1) return ra - rb
    if (ra !== -1) return -1
    if (rb !== -1) return 1
    return (firstSeenIdx.get(a) ?? 0) - (firstSeenIdx.get(b) ?? 0)
  })

  // dateKey(YYYY-MM-DD, HK) → method → { raw, net }
  // ★ cwm-payout P-1：dayMap 由方法名改做 colKey（同 seenKeys 同一把尺）
  const dayMap = new Map<string, Map<string, { raw: number; net: number }>>()
  for (const b of allRows) {
    const dk = b.paidAt ? toHKDateStr(new Date(b.paidAt)) : ''
    if (!dk) continue
    const m = String(b.method ?? '').trim()
    if (!m) continue
    const k = colKey(m, !!b.storeIncome, !!b.doctorIncome)
    let dayM = dayMap.get(dk)
    if (!dayM) {
      dayM = new Map()
      dayMap.set(dk, dayM)
    }
    const cur = dayM.get(k) ?? { raw: 0, net: 0 }
    cur.raw += num(b.rawAmount)
    cur.net += num(b.netAmount)
    dayM.set(k, cur)
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
  const spConfirmed: any[] = await db.spSubsidy.findMany({ where: spWhere, orderBy: { id: 'asc' } })

  const refWhere: any = {
    fromProviderId: run.providerId,
    periodMonth: run.periodMonth,
    status: 'CONFIRMED',
  }
  if (run.clinicId) refWhere.clinicId = run.clinicId
  const refConfirmed: any[] = await db.providerReferral.findMany({ where: refWhere, orderBy: { createdAt: 'asc' } })

  const adjustments: any[] = await db.payoutAdjustment.findMany({
    where: { runId: run.id },
    orderBy: { createdAt: 'asc' },
  })

  // 帳單編號 + 日期（由 ApricotBill 解出）
  const billExtIds = [
    ...new Set(
      [...spConfirmed.map(s => s.billExtId), ...refConfirmed.map(r => r.billExtId)].filter(Boolean) as string[],
    ),
  ]
  const bills: any[] = billExtIds.length
    ? await db.apricotBill.findMany({
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

  // ─── 費率（F 區手續費率行）：由 allocation 快照反解（見 export route 檔頭註） ───
  // ★ cwm-payout P-1：feeFor 入參改 colKey
  const feeFor = (k: string): number => {
    let raw = 0
    let net = 0
    for (const dayM of dayMap.values()) {
      const v = dayM.get(k)
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

  const costs: any[] = await db.costCase.findMany({
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
  const materialIds = [...new Set(implantCases.flatMap(c => c.materials.map((m: any) => m.materialItemId)))]
  const materialItems: any[] = materialIds.length
    ? await db.materialItem.findMany({ where: { id: { in: materialIds } }, select: { id: true, name: true } })
    : []
  const materialName = new Map(materialItems.map(mi => [mi.id, mi.name]))

  // ★ 2026-08-25：dsaName 係助護唔係工廠 —— 剔走 fallback
  const vendorOf = (c: any): string => String(c.lab?.name || c.labOther || '')

  // ─── 砌 DoctorSheetData（六區 layout，由產生器出） ──────────────
  // ★ 口徑對齊 engine（lib/payout/engine.ts L391-401）：
  //   醫生收入（F 區 gross）= countAsIncome || FREE_SP — CREDIT 等 countAsIncome=false 嘅方式唔計
  //   店舖營收（A 區 TOTAL）= countAsIncome（每筆 allocation 自己嘅旗，由付款方式規則決定）
  //   labRows 必傳 LAB + INVISALIGN 兩類（engine profit 要減 invisalignCost）
  //   SP/REF 金額 = 資料庫 amount（base/rate 只作顯示；人手改過加「（已人手調整）」標記）
  const days: DoctorSheetData['days'] = []
  for (let day = 1; day <= daysInMonth; day++) {
    const dk = `${run.periodMonth}-${String(day).padStart(2, '0')}`
    const dayM = dayMap.get(dk)
    const byMethod: Record<string, number> = {}
    for (const k of seenKeys) {
      byMethod[k] = money(dayM?.get(k)?.raw ?? 0)
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
      let matSum = 0 // ★ cwm-payout P-3：逐行同寫法器一樣口徑（round2(qty×money(unitPriceUsed))）
      for (const mat of c.materials) {
        // 防呆：DB subtotal 同 qty×單價 唔一致（手改過）→ 公式重算值會偏舊出口徑
        if (Math.abs(num(mat.subtotal) - num(mat.qty) * num(mat.unitPriceUsed)) > 0.005) {
          console.warn(`[payout-export] 材料 subtotal 同 qty×單價 唔一致（case ${c.id}）：subtotal=${mat.subtotal}, qty×price=${num(mat.qty) * num(mat.unitPriceUsed)}`)
        }
        const unitPrice = money(mat.unitPriceUsed)
        matSum = round2(matSum + round2(num(mat.qty) * unitPrice))
        implantRows.push({
          patientCode,
          patientName,
          orderedAt: ddMM(c.orderedAt),
          material: mat.note?.trim() || materialName.get(mat.materialItemId) || mat.materialItemId, // ★ 2026-08-22：Other 材料顯示手動填嘅材料名（note 優先）
          qty: mat.qty,
          unitPrice,
        })
      }
      // ★ cwm-payout P-3：Σ 材料 ≠ finalCost（折扣／人手改過）→ 加調整行，
      //   令病人小計 = finalCost = engine sumByCosts 口徑（C 區總計對返系統）
      const finalCost = money(c.finalCost)
      const implAdj = round2(finalCost - matSum)
      if (Math.abs(implAdj) > 0.005) {
        console.warn(`[payout-export] Implant case ${c.id}：材料合計 ${matSum} ≠ finalCost ${finalCost} → 加調整行 ${implAdj}`)
        implantRows.push({
          patientCode,
          patientName,
          orderedAt: ddMM(c.orderedAt),
          material: '調整（以成本記錄為準）',
          qty: 1,
          unitPrice: implAdj,
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
    const amount = money(sp.amount) // ★ cwm-payout P-3：金額欄同小計用 DB amount（engine 同一數）
    const adjusted = Math.abs(round2(base * rate) - amount) > 0.005
    if (adjusted) {
      console.warn(`[payout-export] SP ${sp.id} amount=${sp.amount} ≠ base×rate=${round2(base * rate)}（手改過？）→ 加「已人手調整」標記`)
    }
    return {
      billCode: bill?.code || sp.billExtId,
      date: bill ? ddMM(bill.billTime) : '',
      patientName: '', // SpSubsidy 無病人欄
      desc: String(sp.itemDes || ''),
      base,
      rate,
      amount,
      adjusted: adjusted || undefined,
    }
  })

  // D 區：REF（轉介收入）—— amount = unitPrice×qty×ref%
  const refRows = refConfirmed.map(ref => {
    const bill = ref.billExtId ? billByExt.get(ref.billExtId) : null
    const base = ref.unitPrice != null ? round2(num(ref.unitPrice) * ref.qty) : 0
    const rate = num(ref.refPercent) / 100
    const amount = money(ref.amount ?? 0) // ★ cwm-payout P-3：同 SP — DB amount
    const adjusted = Math.abs(round2(base * rate) - amount) > 0.005
    if (adjusted) {
      console.warn(`[payout-export] REF ${ref.id} amount=${ref.amount} ≠ base×rate=${round2(base * rate)}（手改過？）→ 加「已人手調整」標記`)
    }
    return {
      billCode: ref.billCode || bill?.code || ref.billExtId || '',
      date: bill ? ddMM(bill.billTime) : '',
      patientName: '', // ProviderReferral 無病人欄（只有 patientNote）
      desc: String(ref.itemDes || ''),
      base,
      rate,
      amount,
      adjusted: adjusted || undefined,
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

  const data: DoctorSheetData = {
    providerName,
    clinicName,
    periodMonth: run.periodMonth,
    // LOCKED → 帶鎖定日期；DRAFT → 草稿提示（同舊 title statusSuffix 同信息）
    status:
      run.status === 'LOCKED' && run.lockedAt
        ? `LOCKED（已鎖定 ${ddMyy(run.lockedAt)}）`
        : 'DRAFT（草稿 — 數字可能會變）',
    // ★ cwm-payout P-1：雙旗入 methods —
    //   countAsIncome（store）= A 區 TOTAL（店舖營收）口徑；
    //   countForDoctor = F 區（醫生收入）口徑，同 engine.ts L391-401 一致。
    //   括號統一由雙旗加：d=0 優先（唔計醫生收入），否則 s=0（唔計店舖營收）。
    methods: seenKeys.map(k => {
      const [m, s, d] = k.split('|')
      return {
        key: k,
        label: (METHOD_LABELS[m] || m) + (d === '0' ? '（不計醫生收入）' : s === '0' ? '（不計店舖營收）' : ''),
        feePercent: feeFor(k),
        countAsIncome: s === '1', // A 區 TOTAL（店舖營收）用
        countForDoctor: d === '1', // F 區（醫生收入）用
      }
    }),
    days,
    labRows,
    implantRows,
    spRows,
    refRows,
    adjRows,
    percentUsed: num(run.percentUsed) / 100, // DB 存百分數（50）→ 產生器用小數（0.5）
  }

  return { run, provider, clinic, data }
}
