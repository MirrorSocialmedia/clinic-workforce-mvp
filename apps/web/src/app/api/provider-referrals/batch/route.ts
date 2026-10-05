/**
 * POST /api/provider-referrals/batch — Batch create referrals from bill items (OWNER / provider_payout)
 * Used for bill-linked referral entry (MD-U)
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { lockPeriod, PeriodLockedError } from '@/lib/payout/period-lock'
import { toHKDateStr } from '@/lib/hk-date'
import { round2 } from '@/lib/payout/engine'
import { lockedRunFor } from '@/lib/cost-entry/guards'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({}))
  const { fromProviderId, billExtId, refPercent, items, toProviderId } = body as any

  if (!fromProviderId || !billExtId || !items?.length) {
    return NextResponse.json(
      { error: 'fromProviderId, billExtId, items required' },
      { status: 400 },
    )
  }

  // ★ cwm-payaudit-20261006：轉介 % 要係 0–100 嘅數（之前 Number(undefined) ?? 2 = NaN）
  const pct = Number(refPercent ?? 2)
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    return NextResponse.json({ error: '轉介 % 要喺 0 至 100 之間' }, { status: 400 })
  }

  try {
    // Validate bill exists
    const bill = await prisma.apricotBill.findUnique({
      where: { extId: billExtId },
    })
    if (!bill) {
      return NextResponse.json(
        { error: '帳單未同步落本地' },
        { status: 404 },
      )
    }

    // Resolve clinic from bill
    let clinicId: string = ''
    if (bill.clinicExtId) {
      const clinic = await prisma.clinic.findFirst({
        where: { apricotClinicId: bill.clinicExtId },
        select: { id: true },
      })
      if (clinic) clinicId = clinic.id
    }
    // ★ cwm-payaudit-20261006：冇診所 = 唔會計入任何月結（同 complete 一樣擋）
    if (!clinicId) {
      return NextResponse.json({ error: `帳單所屬診所（${bill.clinicExtId}）未對應，請去診所管理設定` }, { status: 400 })
    }

    // Validate quantities against bill items
    const billItems = await prisma.apricotBillItem.findMany({
      where: { billId: bill.id },
    })
    const billItemMap = new Map(billItems.map(i => [i.eleId, i]))

    for (const item of items) {
      const billItem = billItemMap.get(item.eleId)
      if (!billItem) {
        return NextResponse.json(
          { error: `項目 ${item.eleId} 唔存在` },
          { status: 404 },
        )
      }
      if (!Number.isInteger(Number(item.qty)) || Number(item.qty) < 1) {
        return NextResponse.json({ error: '數量要係正整數' }, { status: 400 })
      }
      if (Number(item.qty) > billItem.qty) {
        return NextResponse.json(
          { error: `數量唔可以多過帳單嘅 ${billItem.qty}` },
          { status: 400 },
        )
      }
      if (Number(billItem.unitPrice) < 0) {
        return NextResponse.json(
          { error: `「${billItem.feeItemDes}」係負數項目，唔可以轉介` },
          { status: 400 },
        )
      }
    }

    // Duplicate check — list all dups (not return on first)
    const dups = await prisma.providerReferral.findMany({
      where: {
        fromProviderId,
        billItemEleId: { in: items.map((i: any) => i.eleId) },
        status: 'CONFIRMED',
      },
      select: { itemDes: true, billCode: true },
    })
    if (dups.length) {
      return NextResponse.json(
        { error: `以下項目已經轉介過：${dups.map(d => `${d.itemDes}（${d.billCode}）`).join('、')}` },
        { status: 400 },
      )
    }

    // Derive periodMonth from bill time (HK timezone)
    const periodMonth = toHKDateStr(bill.billTime).slice(0, 7)

    // ★ cwm-payaudit-20261006：該月月結已鎖 → 新轉介唔會計入，醫生收唔到 —— 擋
    if (await lockedRunFor(prisma, fromProviderId, clinicId, periodMonth)) {
      return NextResponse.json({ error: `${periodMonth} 嘅月結已經鎖定，新轉介唔會計入。請用「手動調整」喺下期補，或者先解鎖該月月結` }, { status: 409 })
    }

    // Transaction — 全入或全唔入
    // ★ 改用 function-based transaction，入面可加重複檢查
    const referrals = await prisma.$transaction(async (tx) => {
      // ★ cwm-payaudit-20261006：期間鎖 + 再查一次（同鎖月結一前一後）
      await lockPeriod(tx, fromProviderId, clinicId, periodMonth)
      if (await lockedRunFor(tx, fromProviderId, clinicId, periodMonth)) throw new PeriodLockedError(periodMonth)
      const results = []
      for (const item of items) {
        // ★ cwm-payaudit-20261006：單價以帳單為準（唔信 request）；金額 round2 ——
        //   舊寫法 Math.round(x/100)*100 會四捨五入去【$100】：$1,200 × 2% = $24 存咗 $0
        const billItem = billItemMap.get(item.eleId)!
        const unitPrice = Number(billItem.unitPrice)
        const qty = Number(item.qty)
        const refPct = pct
        const amount = round2(unitPrice * qty * refPct / 100)

        const ref = await tx.providerReferral.create({
          data: {
            fromProviderId,
            toProviderId: toProviderId || null,
            billExtId,
            billCode: bill.code,
            billItemEleId: item.eleId,
            itemDes: billItem.feeItemDes,
            unitPrice: unitPrice,
            qty,
            refPercent: refPct,
            amount,
            clinicId: clinicId || null,
            periodMonth,
            status: 'CONFIRMED',
            createdBy: auth.session!.userId,
          },
        })
        results.push(ref)
      }
      return results
    })

    // Audit log
    await prisma.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: 'REFERRAL_BATCH_CREATE',
        entity: 'ProviderReferral',
        entityId: billExtId,
        notes: `批次新增 ${referrals.length} 筆轉介：bill ${bill.code}`,
        afterJson: JSON.stringify({ fromProviderId, billExtId, count: referrals.length }),
      },
    }).catch((e: any) => console.error('[provider-referrals/batch] audit failed', e))

    return NextResponse.json(
      {
        referrals,
        count: referrals.length,
      },
      { status: 201 },
    )
  } catch (e: any) {
    // ★ 同時兩個人轉介同一項目 → partial unique index（CONFIRMED + billItemEleId）擋
    if (e instanceof PeriodLockedError) return NextResponse.json({ error: `${e.periodMonth} 嘅月結已經鎖定，新轉介唔會計入。請用「手動調整」喺下期補，或者先解鎖該月月結` }, { status: 409 })
    if (e?.code === 'P2002') return NextResponse.json({ error: '呢個項目啱啱已經有人轉介咗，請重新整理' }, { status: 409 })
    console.error('[provider-referrals/batch] failed', e)
    return NextResponse.json({ error: '批次轉介失敗，冇任何一筆寫入，請重試' }, { status: 500 })
  }
}
