import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apricotCall } from './client'
import { withApricotLock } from './lock'
import { sanitizePayment, sanitizeBill, assertNoPii } from './sanitize'
import { normalizeMethod } from './normalize'
import { allocatePayment, upsertAllocations } from './allocate'

// ─── MD-Q: Job helpers ─────────────────────────────────────────────

export async function shouldCancel(jobId: string): Promise<boolean> {
  const job = await prisma.apricotSyncJob.findUnique({
    where: { id: jobId },
    select: { cancelRequested: true },
  })
  return !!job?.cancelRequested
}

export async function updateJob(jobId: string, data: Partial<any>) {
  // ★ cwm-syncstuck-20260918 E3-3：每次 checkpoint 都刷 heartbeatAt ——
  //   cancel endpoint 用佢判斷背景有冇回應（stale → 即刻 CANCELLED，唔使等）。
  await prisma.apricotSyncJob.update({ where: { id: jobId }, data: { ...data, heartbeatAt: new Date() } })
}

// ─── cwm-syncforce-20260913 D: billsFetched in-memory stats ─────────────────────
// ★ Zero-schema 設計：ApricotSyncJob 冇 JSON result 欄（本單零 migration 唔准加欄），
//   而 POST /api/apricot/sync 即回 jobId → 實際重拉數無法持久化，走呢個 map。
//   key = jobId（一個 job 可跨多間 clinic，逐 clinic 累積），value = { count, at }。
//   jobs/[id] GET 回應帶佢做非持久欄；map 冇就唔帶（誠實，唔好講大話）。
// ★ TTL：每次寫入時剔 >1h 條目（除本身）— 唔使 background timer，防 map 漏。
const billFetchStats = new Map<string, { count: number; at: number }>()
const BILL_FETCH_STATS_TTL_MS = 60 * 60 * 1000

function recordBillFetchStats(jobId: string | undefined, count: number) {
  if (!jobId) return
  const now = Date.now()
  for (const [k, v] of billFetchStats) {
    if (k !== jobId && now - v.at > BILL_FETCH_STATS_TTL_MS) billFetchStats.delete(k)
  }
  const prev = billFetchStats.get(jobId)
  billFetchStats.set(jobId, { count: (prev?.count ?? 0) + count, at: now })
}

/** 俾 jobs/[id] GET：實際重拉數。undefined = 無記錄（job 未終態／server 重啟／舊 job）→ 唔帶。 */
export function getBillFetchStats(jobId: string): number | undefined {
  return billFetchStats.get(jobId)?.count
}

/** 單測用：清空 stats map */
export function _resetBillFetchStatsForTest() {
  billFetchStats.clear()
}

// ─── cwm-reconxlsx-fix-20260910 D: sweep ─────────────────────────────────
// sync 完一個範圍後，將該範圍內 Apricot 冇再返嘅 payment 嘅 allocation 標 isVoid（已刪／已作廢）。
// ★★★ 四個安全條件（缺一不可）：
//   ① 只喺【完整成功】先掃（call site 負責：cancel 早退 / API 出錯 throw）—— 攞唔到 ≠ 已刪除
//   ② allPayments.length > 0 —— 回零筆多數係 API 出事，唔係「嗰個月真係冇收錢」（call site 檢查 + 呢度 double-check）
//   ③ clinicExtId 一定要 filter —— 唔 filter 會掃走第二間診所嘅數
//   ④ paidAt 範圍 = 今次 sync 嘅範圍 —— 範圍外唔准掂
// ★ 用 isVoid: true 唔好硬刪 —— 保住審計線索；ACTIVE_ALLOCATION 已經排除 isVoid
// ★ seenPaymentIds 個 key = String(p.id) —— 同 allocate.ts 嘅 `paymentExtId: payment.id` 同一嚟源
//   （sanitizePayment 原樣保留 raw.id）。撞唔啱就會把全部 allocation 當孤兒掃走 —— 本章最危險嗰步，落刀前已 grep 實。
// ★ APRICOT_SWEEP_MODE=dry → 只 log 唔寫（預查用）；唔設 / on → 真掃
async function sweepOrphanAllocations(opts: {
  clinicExtId: string
  startUtc: Date
  endUtc: Date
  fromISO: string
  toISO: string
  seenPaymentIds: Set<string>,
}) {
  const { clinicExtId, startUtc, endUtc, fromISO, toISO, seenPaymentIds } = opts
  if (seenPaymentIds.size === 0) return // 條件② double-check：零筆 = 有問題，唔掃
  const dryRun = process.env.APRICOT_SWEEP_MODE === 'dry'
  const inRange = await prisma.paymentAllocation.findMany({
    where: {
      clinicExtId, // 條件③
      paidAt: { gte: startUtc, lte: endUtc }, // 條件④
      isVoid: false,
      isSuperseded: false,
    },
    select: { id: true, paymentExtId: true, methodNorm: true, amount: true, paidAt: true, periodMonth: true },
  })
  const orphans = inRange.filter(a => !seenPaymentIds.has(String(a.paymentExtId)))
  if (dryRun) {
    for (const a of orphans) {
      console.warn(
        `[apricot-sync] sweep DRY-RUN (no write): clinic=${clinicExtId} allocId=${a.id} paymentExtId=${a.paymentExtId} method=${a.methodNorm} amount=${Number(a.amount)} paidAt=${a.paidAt.toISOString()} period=${a.periodMonth}`,
      )
    }
    console.warn(
      `[apricot-sync] sweep DRY-RUN summary: ${clinicExtId} ${fromISO}~${toISO} would-void=${orphans.length} seen=${seenPaymentIds.size} inRangeActive=${inRange.length}`,
    )
    return
  }
  if (orphans.length > 0) {
    await prisma.paymentAllocation.updateMany({
      where: { id: { in: orphans.map(a => a.id) } },
      data: { isVoid: true },
    })
    console.warn(
      `[apricot-sync] sweep: ${clinicExtId} ${fromISO}~${toISO} 標走 ${orphans.length} 筆 Apricot 已冇嘅 allocation`,
    )
  }
}

// ─── Core helpers (unchanged) ──────────────────────────────────────

/** 判斷 dateTime 是否為 HK 當月 */
function isCurrentMonth(dt: Date | string): boolean {
  const d = typeof dt === 'string' ? new Date(dt) : dt
  const now = new Date()
  const nowISO = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
  const dtISO = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
  return nowISO === dtISO
}

/** 由 payments 收集所有 billIds */
function collectBillIds(allPayments: any[]): string[] {
  const ids = new Set<string>()
  for (const p of allPayments) {
    for (const ref of (p.refList || [])) {
      if (ref.billId) ids.add(ref.billId)
    }
  }
  return Array.from(ids)
}

async function upsertPayment(p: any, clinicExtId: string) {
  const methods = (p.paymentMethods || []).map((m: any) => ({
    methodRaw: (m.code || m.des || '').trim(),
    methodNorm: normalizeMethod(m.code || m.des || ''),
    amount: new Prisma.Decimal(String(m.amt ?? 0)),
    payType: m.payType || '',
  }))

  const refs = (p.refList || []).map((r: any) => ({
    billExtId: r.billId,
    billCode: r.billCode,
    amount: new Prisma.Decimal(String(r.amt ?? 0)),
  }))

  await prisma.apricotPayment.upsert({
    where: { extId: p.id },
    update: {
      code: p.code,
      paidAt: new Date(p.paymentTime),
      totalAmt: new Prisma.Decimal(String(p.amt ?? 0)),
      isVoid: !!p.isVoid,
      payerType: p.payerType || '',
      syncedAt: new Date(),
      methods: {
        deleteMany: {},
        create: methods,
      },
      refs: {
        deleteMany: {},
        create: refs,
      },
    },
    create: {
      extId: p.id,
      code: p.code,
      clinicExtId,
      paidAt: new Date(p.paymentTime),
      totalAmt: new Prisma.Decimal(String(p.amt ?? 0)),
      isVoid: !!p.isVoid,
      payerType: p.payerType || '',
      methods: { create: methods },
      refs: { create: refs },
    },
  })
}

async function upsertBill(b: any) {
  const items = (b.billDetails || []).map((d: any) => ({
    eleId: d.eleId,
    feeItemCode: d.feeItem?.code || '',
    feeItemDes: d.feeItem?.des || '',
    qty: d.qty ?? 1,
    unitPrice: new Prisma.Decimal(String(d.up ?? 0)),
    discPer: new Prisma.Decimal(String(d.discPer ?? 0)),
    discAmt: new Prisma.Decimal(String(d.discAmt ?? 0)),
    ttlDisc: new Prisma.Decimal(String(d.ttlDisc ?? 0)),
    amt: new Prisma.Decimal(String(d.amt ?? 0)),
    ttlAmt: new Prisma.Decimal(String(d.ttlAmt ?? 0)),
    isSp2p: !!d.isSp2p, // ★ MD-K: 2人SP 偵測（remarks 含 2p1k）
    reconJson: (d.reconPaymentDetails || []).map((r: any) => ({
      des: r.des || '',
      amt: Number(r.amt ?? 0),
    })),
  }))

  await prisma.apricotBill.upsert({
    where: { extId: b.id },
    update: {
      code: b.code,
      billTime: new Date(b.billTime),
      providerExtId: b.practitioner?.id || null,
      // ★ D1：存顯示名（撞到未知帳號唔使再返 Apricot 查）；舊行 null，下次 sync 自動補
      providerName: b.practitioner?.name || null,
      clinicExtId: b.clinic?.id || '',
      amt: new Prisma.Decimal(String(b.amt ?? 0)),
      ttlAmt: new Prisma.Decimal(String(b.ttlAmt ?? 0)),
      paidAmt: new Prisma.Decimal(String(b.paidAmt ?? 0)),
      osAmt: new Prisma.Decimal(String(b.osAmt ?? 0)),
      isVoid: !!b.isVoid,
      isRefunded: !!b.isRefunded,
      refundRefId: b.refundRefId || null,
      syncedAt: new Date(),
      items: {
        deleteMany: {},
        create: items,
      },
    },
    create: {
      extId: b.id,
      code: b.code,
      billTime: new Date(b.billTime),
      providerExtId: b.practitioner?.id || null,
      // ★ D1：同 update 側一致（create 都要帶）
      providerName: b.practitioner?.name || null,
      clinicExtId: b.clinic?.id || '',
      amt: new Prisma.Decimal(String(b.amt ?? 0)),
      ttlAmt: new Prisma.Decimal(String(b.ttlAmt ?? 0)),
      paidAmt: new Prisma.Decimal(String(b.paidAmt ?? 0)),
      osAmt: new Prisma.Decimal(String(b.osAmt ?? 0)),
      isVoid: !!b.isVoid,
      isRefunded: !!b.isRefunded,
      refundRefId: b.refundRefId || null,
      items: { create: items },
    },
  })
}

// ─── Sync for a single clinic (used by background job) ─────────────

/**
 * ★ D2：sync 撞到未知帳號一定要嗌（帶埋個名）。
 *   同 unknown_booking_status 同一 pattern：照存唔擋，但一定要嗌。
 *   ⚠️ 每次 sync 每個 id 只嗌一次（seen 由 caller 貫穿整個 sync 傳入），唔好每筆都嗌。
 * @param rows 本次 allocation 行（providerExtId + billExtId）
 * @param billNameByExtId billExtId → 帳號顯示名（由 billCache 導出）
 * @param clinicName 診所名（log 用）
 */
export async function maybeAlertUnknownPractitioners(
  rows: Array<{ providerExtId: string | null; billExtId: string | null }>,
  billNameByExtId: Map<string, string>,
  clinicName: string,
  seen: Set<string>,
): Promise<void> {
  // 先收埋呢個 sync 未見過的 id（含已知 — 已知嘅之後都唔使再查）
  const fresh = new Map<string, string | null>()
  for (const r of rows) {
    if (r.providerExtId && !seen.has(r.providerExtId)) {
      seen.add(r.providerExtId)
      fresh.set(r.providerExtId, r.billExtId ? (billNameByExtId.get(r.billExtId) ?? null) : null)
    }
  }
  if (fresh.size === 0) return
  const known = await prisma.apricotPractitioner.findMany({
    where: { apricotId: { in: [...fresh.keys()] } },
    select: { apricotId: true },
  })
  const knownSet = new Set(known.map(({ apricotId }) => apricotId))
  for (const [id, name] of fresh) {
    if (!knownSet.has(id)) {
      console.error(
        `[apricot-sync] ⚠️ ALERT unknown_practitioner — 「${name ?? '(無名)'}」(${id}) @${clinicName}`
        + ` — 照存但【唔會入任何月結】，請去「未綁帳號」頁綁定`,
      )
    }
  }
}

/** 同步一間診所，支援 shouldCancel 檢查。傳入 jobId 用於追蹤進度。 */
export async function syncClinicForJob(
  clinicExtId: string,
  fromISO: string,
  toISO: string,
  jobId?: string,
  /**
   * ★ cwm-syncforce-20260913：繞過 shouldFetch 快取，逐張 bill 強制重拉。
   *   點解要：舊單嘅 practitioner／金額被員工改咗之後，四個 shouldFetch 條件
   *   全部唔成立（唔係本月、七日內 sync 過）→ 永遠唔會重拉，DB 永遠係舊值。
   *   ⚠️ 只俾【人手 backfill】用 —— 定期 sync 用返快取，否則 API call 會爆。
   */
  force = false,
) {
  // ★ cwm-syncclinicid-20260914：Apricot 個 clinicId 係 24 位 hex ObjectId。
  //   傳咗本地 cuid 上去會回一個好難讀嘅 500
  //   ("invalid hexadecimal representation of an ObjectId")——
  //   喺呢度即刻 throw，錯誤訊息直接講明係咩事。
  if (!/^[0-9a-f]{24}$/i.test(clinicExtId)) {
    throw new Error(
      `APRICOT_BAD_CLINIC_ID: ${clinicExtId} —— 似係本地 Clinic.id，唔係 apricotClinicId`)
  }

  const startUtc = new Date(fromISO)
  const endUtc = new Date(toISO)
  if (isNaN(+startUtc) || isNaN(+endUtc)) {
    throw new Error(`APRICOT_BAD_DATE_RANGE: from=${fromISO} to=${toISO}`)
  }
  // ★ from === to（純日期被當 UTC 午夜）→ 零長度區間，靜靜拉唔到嘢
  if (endUtc.getTime() <= startUtc.getTime()) {
    throw new Error(
      `APRICOT_BAD_DATE_RANGE: 區間零長度或者倒轉 from=${fromISO} to=${toISO}`)
  }
  const startValue = startUtc.toISOString()
  const endValue = endUtc.toISOString()

  // 1) 分頁拉 payments
  let page = 0
  const allPayments: any[] = []

  // ★ cwm-syncforce-20260913 D: 實際重拉（有 API call）張數 — 喺度先宣告，令 finish()
  //   可以喺任何 return path（包括 billsChecked 宣告前嘅 cancel 早退）安全引用
  let billsFetched = 0

  // ★ cwm-syncforce-20260913: 單一出口 — 所有 return path（含全部 cancel 早退）都經呢度，
  //   結構性保證 billsFetched 每一路都回傳 + 寫入 stats map，零漏分支。
  const finish = (cancelled: boolean, billsCheckedNow: number, allocRowsNow: number) => {
    recordBillFetchStats(jobId, billsFetched)
    return { cancelled, paymentsSynced: allPayments.length, billsChecked: billsCheckedNow, allocRows: allocRowsNow, billsFetched }
  }

  do {
    // ★ MD-Q: 每頁檢查 cancel
    if (jobId && (await shouldCancel(jobId))) {
      return finish(true, 0, 0)
    }

    if (jobId) {
      await updateJob(jobId, { currentStep: `拉付款 第 ${page + 1} 頁` })
    }

    const list: any[] = await apricotCall(
      `/services/aepsmsbill/api/payments/search?page=${page}&size=100&sort=desc&keyword=&clinicId=${clinicExtId}&sortBy=paymentTime`,
      {
        method: 'POST',
        body: JSON.stringify({
          params: [
            { key: 'startDate', value: startValue },
            { key: 'endDate', value: endValue },
          ],
        }),
      },
    )

    const sanitized = (list || []).map(sanitizePayment)
    sanitized.forEach(p => assertNoPii(p))
    allPayments.push(...sanitized)

    if ((list || []).length < 100) break
    page++
    if (page > 50) { console.error('[apricot] 分頁過多，中止'); break }
  } while (true)

  // ★ MD-Q: 拉完付款檢查 cancel
  if (jobId && (await shouldCancel(jobId))) {
    return finish(true, 0, 0)
  }

  // 2) upsert Payments — ★ V4: 每 10 筆檢查 cancel
  for (let idx = 0; idx < allPayments.length; idx++) {
    if (idx % 10 === 0 && jobId && (await shouldCancel(jobId))) {
      return finish(true, 0, 0)
    }
    await upsertPayment(allPayments[idx], clinicExtId)
  }

  // 3) 收集 billIds，cache check
  const billIds = collectBillIds(allPayments)
  let billsChecked = 0

  for (const billId of billIds) {
    const existing = await prisma.apricotBill.findUnique({ where: { extId: billId } })
    const billTime = existing?.billTime || new Date()
    // ★ cwm-syncforce-20260913: force 加喺最前 short-circuit — 人手 backfill 逐張單強制重拉
    const shouldFetch =
      force ||
      !existing ||
      !existing.syncedAt ||
      (new Date().getTime() - existing.syncedAt.getTime()) > 7 * 24 * 3600 * 1000 ||
      isCurrentMonth(billTime)

    if (shouldFetch) {
      // ★ V4: 每 10 張 bill 檢查 cancel（唔好每張都 query DB）
      if (billsChecked % 10 === 0 && jobId && (await shouldCancel(jobId))) {
        return finish(true, billsChecked, 0)
      }

      if (jobId) {
        await updateJob(jobId, { currentStep: `拉帳單 ${billsChecked + 1}/${billIds.length}` })
      }

      const rawBill = await apricotCall(`/services/aepsmsbill/api/bills/${billId}`)
      const sanitized = sanitizeBill(rawBill)
      assertNoPii(sanitized)
      await upsertBill(sanitized)
      billsFetched++ // ★ cwm-syncforce-20260913 D: 計實際重拉數
    }
    billsChecked++
  }

  // ★ MD-Q: 拉完 bill 檢查 cancel
  if (jobId && (await shouldCancel(jobId))) {
    return finish(true, billsChecked, 0)
  }

  // 4) 重算 allocation
  const billIdsTouched = [...new Set(allPayments.flatMap((p: any) =>
    (p.refList || []).map((r: any) => r.billId)))]

  const globalRefs = await prisma.apricotPaymentRef.findMany({
    where: { billExtId: { in: billIdsTouched } },
    select: { billExtId: true },
  })

  const from = new Date(startValue)
  const to = new Date(endValue)
  const allRules = await prisma.paymentMethodRule.findMany({
    where: {
      effectiveFrom: { lte: to },
      OR: [
        { effectiveTo: null },
        { effectiveTo: { gte: from } },
      ],
    },
  })

  const billCache = new Map<string, any>()
  for (const bid of billIdsTouched) {
    const b = await prisma.apricotBill.findUnique({
      where: { extId: bid },
      include: { items: true },
    })
    if (b) billCache.set(bid, b)
  }

  // ★ D2：未知帳號 ALERT 用 — billExtId → 帳號顯示名（D1 providerName 已入庫；fallback 用 bill code）
  const billNameByExtId = new Map<string, string>(
    [...billCache].map(([extId, b]) => [extId, b.providerName || b.code || '']),
  )
  const unknownSeen = new Set<string>() // ★ 每次 sync 每個 id 只嗌一次
  const clinicName = (await prisma.clinic.findFirst({ where: { apricotClinicId: clinicExtId }, select: { name: true } }))?.name ?? clinicExtId

  let allocRows = 0
  for (let idx = 0; idx < allPayments.length; idx++) {
    // ★ V4: 每 10 筆付款檢查 cancel（唔好每筆都 query DB）
    if (idx % 10 === 0 && jobId && (await shouldCancel(jobId))) {
      return finish(true, billsChecked, allocRows)
    }
    const p = allPayments[idx]

    const methods = (p.paymentMethods || []).map((m: any) => ({
      methodRaw: m.des ?? '',
      methodNorm: normalizeMethod(m.des ?? ''),
      amount: m.amt ?? 0,
      payType: m.payType ?? '',
    }))
    const refs = (p.refList || []).map((r: any) => ({
      billExtId: r.billId,
      billCode: r.billCode,
      amount: r.amt ?? 0,
    }))
    if (!refs.length) continue

    const rows = await allocatePayment(p, methods, refs, billCache, clinicExtId, globalRefs, allRules)
    // ★ D2：upsertAllocations 前嗌未知帳號（每個 id 每次 sync 只嗌一次）
    await maybeAlertUnknownPractitioners(rows, billNameByExtId, clinicName, unknownSeen)
    await upsertAllocations(rows.map(r => ({ ...r, isVoid: !!p.isVoid })))
    allocRows += rows.length
  }

  // ★ cwm-reconxlsx-fix-20260910 D: sweep —— 呢個範圍入面，Apricot 冇再返嘅 payment = 已刪／已作廢，要標 isVoid 清走。
  //   唔做嘅話舊記錄永久活住（實例：8/16 ALIPAY $14,000 被改正做 MASTER，舊 ALIPAY 冇被作廢 → 對數永遠差 $14,000）。
  //   條件① !cancelled：呢個函數所有 cancel 點都係早退 return，行到呢度 = 完整成功。
  //   條件② allPayments.length > 0：回零筆多數係 API 出事，唔掃。
  if (allPayments.length > 0) {
    await sweepOrphanAllocations({
      clinicExtId,
      startUtc,
      endUtc,
      fromISO,
      toISO,
      seenPaymentIds: new Set(allPayments.map((p: any) => String(p.id))),
    })
  }

  return finish(false, billsChecked, allocRows)
}

/** 舊版入口 — 被 withApricotLock 包起，保持原有同步行為 */
export async function syncPayments(clinicExtId: string, fromISO: string, toISO: string) {
  // ★ H1: 唔理 caller 送咩格式（+08:00 / 裸日期 / Z），一律轉成 Apricot 收嘅 UTC Z
  const startUtc = new Date(fromISO)
  const endUtc = new Date(toISO)
  if (isNaN(+startUtc) || isNaN(+endUtc)) {
    throw new Error(`APRICOT_BAD_DATE_RANGE: from=${fromISO} to=${toISO}`)
  }
  const startValue = startUtc.toISOString()
  const endValue = endUtc.toISOString()

  return withApricotLock(async () => {
    // 1) 分頁拉 payments
    let page = 0
    const allPayments: any[] = []

    do {
      const list: any[] = await apricotCall(
        `/services/aepsmsbill/api/payments/search?page=${page}&size=100&sort=desc&keyword=&clinicId=${clinicExtId}&sortBy=paymentTime`,
        {
          method: 'POST',
          body: JSON.stringify({
            params: [
              { key: 'startDate', value: startValue },
              { key: 'endDate', value: endValue },
            ],
          }),
        },
      )

      const sanitized = (list || []).map(sanitizePayment)
      sanitized.forEach(p => assertNoPii(p))
      allPayments.push(...sanitized)

      if ((list || []).length < 100) break
      page++
      if (page > 50) { console.error('[apricot] 分頁過多，中止'); break }
    } while (true)

    // 2) upsert Payments
    for (const p of allPayments) {
      await upsertPayment(p, clinicExtId)
    }

    // 3) 收集 billIds，cache check
    const billIds = collectBillIds(allPayments)
    for (const billId of billIds) {
      const existing = await prisma.apricotBill.findUnique({ where: { extId: billId } })
      const billTime = existing?.billTime || new Date()
      const shouldFetch =
        !existing ||
        !existing.syncedAt ||
        (new Date().getTime() - existing.syncedAt.getTime()) > 7 * 24 * 3600 * 1000 ||
        isCurrentMonth(billTime)

      if (shouldFetch) {
        const rawBill = await apricotCall(`/services/aepsmsbill/api/bills/${billId}`)
        const sanitized = sanitizeBill(rawBill)
        assertNoPii(sanitized)
        await upsertBill(sanitized)
      }
    }

    // 4) 重算 allocation
    const billIdsTouched = [...new Set(allPayments.flatMap((p: any) =>
      (p.refList || []).map((r: any) => r.billId)))]

    // 查全歷史 refs（用於 RECON 判斷）— C3
    const globalRefs = await prisma.apricotPaymentRef.findMany({
      where: { billExtId: { in: billIdsTouched } },
      select: { billExtId: true },
    })

    // C6: 載入所有可能生效的 rules（一次性，避免 N+1）
    const from = new Date(startValue)
    const to = new Date(endValue)
    const allRules = await prisma.paymentMethodRule.findMany({
      where: {
        effectiveFrom: { lte: to },
        OR: [
          { effectiveTo: null },
          { effectiveTo: { gte: from } },
        ],
      },
    })

    // billCache — 由 DB 讀（Prisma shape: providerExtId + items[].reconJson）
    const billCache = new Map<string, any>()
    for (const bid of billIdsTouched) {
      const b = await prisma.apricotBill.findUnique({
        where: { extId: bid },
        include: { items: true },
      })
      if (b) billCache.set(bid, b)
    }

    // ★ D2：未知帳號 ALERT 用（同 syncClinicForJob 一致 — 坑⑥：兩邊都要改）
    const billNameByExtId = new Map<string, string>(
      [...billCache].map(([extId, b]) => [extId, b.providerName || b.code || '']),
    )
    const unknownSeen = new Set<string>() // ★ 每次 sync 每個 id 只嗌一次
    const clinicName = (await prisma.clinic.findFirst({ where: { apricotClinicId: clinicExtId }, select: { name: true } }))?.name ?? clinicExtId

    let allocRows = 0
    for (const p of allPayments) {
      const methods = (p.paymentMethods || []).map((m: any) => ({
        methodRaw: m.des ?? '',
        methodNorm: normalizeMethod(m.des ?? ''),
        amount: m.amt ?? 0,
        payType: m.payType ?? '',
      }))
      const refs = (p.refList || []).map((r: any) => ({
        billExtId: r.billId,
        billCode: r.billCode,
        amount: r.amt ?? 0,
      }))
      if (!refs.length) continue

      const rows = await allocatePayment(p, methods, refs, billCache, clinicExtId, globalRefs, allRules)
      // ★ D2：upsertAllocations 前嗌未知帳號（每個 id 每次 sync 只嗌一次）
      await maybeAlertUnknownPractitioners(rows, billNameByExtId, clinicName, unknownSeen)
      await upsertAllocations(rows.map(r => ({ ...r, isVoid: !!p.isVoid })))
      allocRows += rows.length
    }

    // ★ cwm-reconxlsx-fix-20260910 D: sweep —— 同新入口（坑⑥：兩邊都要改）。
    //   條件①：舊入口冇 jobId/cancel；API 出錯 = apricotCall throw → 行唔到呢度 = 唔掃。
    //   條件②③④ 見 sweepOrphanAllocations。
    if (allPayments.length > 0) {
      await sweepOrphanAllocations({
        clinicExtId,
        startUtc,
        endUtc,
        fromISO,
        toISO,
        seenPaymentIds: new Set(allPayments.map((p: any) => String(p.id))),
      })
    }

    return { paymentsSynced: allPayments.length, billsChecked: billIds.length, allocRows }
  })
}
