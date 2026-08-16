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
  await prisma.apricotSyncJob.update({ where: { id: jobId }, data })
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

/** 同步一間診所，支援 shouldCancel 檢查。傳入 jobId 用於追蹤進度。 */
export async function syncClinicForJob(
  clinicExtId: string,
  fromISO: string,
  toISO: string,
  jobId?: string,
) {
  const startUtc = new Date(fromISO)
  const endUtc = new Date(toISO)
  if (isNaN(+startUtc) || isNaN(+endUtc)) {
    throw new Error(`APRICOT_BAD_DATE_RANGE: from=${fromISO} to=${toISO}`)
  }
  const startValue = startUtc.toISOString()
  const endValue = endUtc.toISOString()

  // 1) 分頁拉 payments
  let page = 0
  const allPayments: any[] = []

  do {
    // ★ MD-Q: 每頁檢查 cancel
    if (jobId && (await shouldCancel(jobId))) {
      return { cancelled: true, paymentsSynced: allPayments.length, billsChecked: 0, allocRows: 0 }
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
    return { cancelled: true, paymentsSynced: allPayments.length, billsChecked: 0, allocRows: 0 }
  }

  // 2) upsert Payments — ★ V4: 每 10 筆檢查 cancel
  for (let idx = 0; idx < allPayments.length; idx++) {
    if (idx % 10 === 0 && jobId && (await shouldCancel(jobId))) {
      return { cancelled: true, paymentsSynced: allPayments.length, billsChecked: 0, allocRows: 0 }
    }
    await upsertPayment(allPayments[idx], clinicExtId)
  }

  // 3) 收集 billIds，cache check
  const billIds = collectBillIds(allPayments)
  let billsChecked = 0

  for (const billId of billIds) {
    const existing = await prisma.apricotBill.findUnique({ where: { extId: billId } })
    const billTime = existing?.billTime || new Date()
    const shouldFetch =
      !existing ||
      !existing.syncedAt ||
      (new Date().getTime() - existing.syncedAt.getTime()) > 7 * 24 * 3600 * 1000 ||
      isCurrentMonth(billTime)

    if (shouldFetch) {
      // ★ V4: 每 10 張 bill 檢查 cancel（唔好每張都 query DB）
      if (billsChecked % 10 === 0 && jobId && (await shouldCancel(jobId))) {
        return { cancelled: true, paymentsSynced: allPayments.length, billsChecked, allocRows: 0 }
      }

      if (jobId) {
        await updateJob(jobId, { currentStep: `拉帳單 ${billsChecked + 1}/${billIds.length}` })
      }

      const rawBill = await apricotCall(`/services/aepsmsbill/api/bills/${billId}`)
      const sanitized = sanitizeBill(rawBill)
      assertNoPii(sanitized)
      await upsertBill(sanitized)
    }
    billsChecked++
  }

  // ★ MD-Q: 拉完 bill 檢查 cancel
  if (jobId && (await shouldCancel(jobId))) {
    return { cancelled: true, paymentsSynced: allPayments.length, billsChecked, allocRows: 0 }
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

  let allocRows = 0
  for (let idx = 0; idx < allPayments.length; idx++) {
    // ★ V4: 每 10 筆付款檢查 cancel（唔好每筆都 query DB）
    if (idx % 10 === 0 && jobId && (await shouldCancel(jobId))) {
      return { cancelled: true, paymentsSynced: allPayments.length, billsChecked, allocRows }
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
    await upsertAllocations(rows.map(r => ({ ...r, isVoid: !!p.isVoid })))
    allocRows += rows.length
  }

  return { cancelled: false, paymentsSynced: allPayments.length, billsChecked, allocRows }
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
      await upsertAllocations(rows.map(r => ({ ...r, isVoid: !!p.isVoid })))
      allocRows += rows.length
    }

    return { paymentsSynced: allPayments.length, billsChecked: billIds.length, allocRows }
  })
}
