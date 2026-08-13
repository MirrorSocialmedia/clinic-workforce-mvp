import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apricotCall } from './client'
import { withApricotLock } from './lock'
import { sanitizePayment, sanitizeBill, assertNoPii } from './sanitize'
import { normalizeMethod } from './normalize'
import { allocatePayment, upsertAllocations } from './allocate'

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

/** 主同步入口 — 被 withApricotLock 包起 */
export async function syncPayments(clinicExtId: string, fromISO: string, toISO: string) {
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
              { key: 'startDate', value: fromISO },
              { key: 'endDate', value: toISO },
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
    const allRules = await prisma.paymentMethodRule.findMany({
      where: {
        effectiveTo: { gte: new Date(fromISO) },
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
      for (const row of rows) {
        await upsertAllocations([row])
      }
      allocRows += rows.length
    }

    return { paymentsSynced: allPayments.length, billsChecked: billIds.length, allocRows }
  })
}
