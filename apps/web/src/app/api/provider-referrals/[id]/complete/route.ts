/**
 * POST /api/provider-referrals/[id]/complete — Complete draft with multiple items (OWNER / provider_payout)
 * // ownership-ok: provider_payout 權限限制
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { lockPeriod, PeriodLockedError } from '@/lib/payout/period-lock'
import { toHKDateStr } from '@/lib/hk-date'
import { round2 } from '@/lib/payout/engine'
import { lockedRunFor } from '@/lib/cost-entry/guards'
import { payoutClinicGuard, payoutClinicGuardDraft } from '@/lib/payout/kiosk-scope'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  try {
    // 1. Read draft + validate
    const draft = await prisma.providerReferral.findUnique({
      where: { id: params.id },
    })
    if (!draft) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (draft.status !== 'DRAFT') return NextResponse.json({ error: '只有草稿可以補上帳單' }, { status: 400 })
    if (draft.lockedByRunId) return NextResponse.json({ error: '該轉介已鎖定喺月結單中' }, { status: 409 })
    { const denied = payoutClinicGuardDraft(auth.session!, draft.clinicId); if (denied) return denied } // ★ cwm-kioskpayout-20261010

    // 2. Parse body
    const { billExtId, billCode, refPercent, items } = await req.json()
    if (!Array.isArray(items) || items.length === 0) return NextResponse.json({ error: '請至少揀一個項目' }, { status: 400 })

    // 3. Resolve clinicId + periodMonth from bill
    const bill = await prisma.apricotBill.findUnique({
      where: { extId: billExtId },
      select: { clinicExtId: true, billTime: true },
    })
    if (!bill) return NextResponse.json({ error: '帳單未同步落本地' }, { status: 400 })

    const clinic = await prisma.clinic.findFirst({
      where: { apricotClinicId: bill.clinicExtId },
      select: { id: true },
    })
    if (!clinic) return NextResponse.json({ error: `帳單所屬診所（${bill.clinicExtId}）未對應，請去診所管理設定` }, { status: 400 })

    { const denied = payoutClinicGuard(auth.session!, clinic.id); if (denied) return denied } // ★ cwm-kioskpayout-20261010：帳單要係自己店
    const periodMonth = toHKDateStr(bill.billTime).slice(0, 7)
    const pct = Number(refPercent ?? draft.refPercent ?? 2)
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return NextResponse.json({ error: '轉介 % 要喺 0 至 100 之間' }, { status: 400 })
    // ★ cwm-payaudit-20261006：該月月結已鎖 → 補完都唔會計入 —— 擋
    if (await lockedRunFor(prisma, draft.fromProviderId, clinic.id, periodMonth)) {
      return NextResponse.json({ error: `${periodMonth} 嘅月結已經鎖定，轉介唔會計入。請用「手動調整」喺下期補，或者先解鎖該月月結` }, { status: 409 })
    }

    // 4. Per-item validation (before transaction)
    const billItems = await prisma.apricotBillItem.findMany({
      where: { bill: { extId: billExtId } },
      select: { eleId: true, feeItemDes: true, qty: true, unitPrice: true },
    })
    const byEle = new Map(billItems.map(i => [i.eleId, i]))

    for (const it of items) {
      const bi = byEle.get(it.eleId)
      if (!bi) return NextResponse.json({ error: `項目 ${it.eleId} 唔喺呢張帳單` }, { status: 400 })
      if (!Number.isInteger(Number(it.qty)) || Number(it.qty) < 1) return NextResponse.json({ error: '數量要係正整數' }, { status: 400 })
      if (Number(it.qty) > bi.qty) return NextResponse.json({ error: `「${bi.feeItemDes}」數量唔可以多過帳單嘅 ${bi.qty}` }, { status: 400 })
      if (Number(bi.unitPrice) < 0) return NextResponse.json({ error: `「${bi.feeItemDes}」係負數項目，唔可以轉介` }, { status: 400 })
    }

    // 5. Duplicate check (all items, before transaction)
    const dups = await prisma.providerReferral.findMany({
      where: {
        fromProviderId: draft.fromProviderId,
        billItemEleId: { in: items.map(i => i.eleId) },
        status: 'CONFIRMED',
      },
      select: { itemDes: true, billCode: true },
    })
    if (dups.length) return NextResponse.json({ error: `以下項目已經轉介過：${dups.map(d => `${d.itemDes}（${d.billCode}）`).join('、')}` }, { status: 400 })

    // 6. $transaction — one draft → N referrals
    const created = await prisma.$transaction(async (tx) => {
      // ★ cwm-payaudit-20261006：期間鎖 + 再查一次（同鎖月結一前一後）
      await lockPeriod(tx, draft.fromProviderId, clinic.id, periodMonth)
      if (await lockedRunFor(tx, draft.fromProviderId, clinic.id, periodMonth)) throw new PeriodLockedError(periodMonth)
      const out: any[] = []
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        // ★ cwm-payaudit-20261006：單價以帳單為準（唔信 request）
        const bi = byEle.get(it.eleId)!
        const amount = round2(Number(bi.unitPrice) * Number(it.qty) * pct / 100)
        const data = {
          fromProviderId: draft.fromProviderId,
          toProviderId: draft.toProviderId,
          clinicId: clinic.id,
          billExtId,
          billCode,
          billItemEleId: it.eleId,
          itemDes: bi.feeItemDes,
          unitPrice: Number(bi.unitPrice),
          qty: Number(it.qty),
          refPercent: pct,
          amount,
          periodMonth,
          patientNote: draft.patientNote,
          note: draft.note,
          status: 'CONFIRMED',
          createdBy: auth.session!.userId,
        }
        if (i === 0) {
          // ★ cwm-payaudit-20261006：條件寫入 —— 連撳兩下／兩個人同時補，第二個唔會再改同一張草稿
          out.push(await tx.providerReferral.update({ where: { id: draft.id, status: 'DRAFT', lockedByRunId: null }, data }))
        } else {
          out.push(await tx.providerReferral.create({ data }))
        }
      }
      return out
    })

    // 7. Audit log
    await prisma.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: 'REFERRAL_COMPLETE',
        entity: 'ProviderReferral',
        entityId: draft.id,
        notes: `草稿補上帳單 ${billCode}：${created.length} 個項目，合共 $${created.reduce((s, r) => s + Number(r.amount), 0).toFixed(2)}`,
        beforeJson: JSON.stringify(draft),
        afterJson: JSON.stringify(created.map(r => ({ id: r.id, itemDes: r.itemDes, amount: Number(r.amount) }))),
      },
    }).catch((e: any) => console.error('[provider-referrals/complete] audit failed', e))

    return NextResponse.json({ referrals: created, count: created.length })
  } catch (e: any) {
    if (e instanceof PeriodLockedError) return NextResponse.json({ error: `${e.periodMonth} 嘅月結已經鎖定，轉介唔會計入。請用「手動調整」喺下期補，或者先解鎖該月月結` }, { status: 409 })
    if (e?.code === 'P2025' || e?.code === 'P2002') return NextResponse.json({ error: '呢張草稿啱啱已經補咗／項目已經轉介過，請重新整理' }, { status: 409 })
    console.error('[provider-referrals/complete] failed', e)
    return NextResponse.json({ error: '補上帳單失敗，冇任何一筆寫入，請重試' }, { status: 500 })
  }
}
