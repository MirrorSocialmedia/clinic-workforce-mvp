export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'

/** GET /api/payment-method-rules — 列出付款方式規則 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, req.method, req.url)
  if (isAuthError(auth)) return auth.error

  const rules = await prisma.paymentMethodRule.findMany({
    orderBy: [
      { method: 'asc' },
      { effectiveFrom: 'desc' },
    ],
  })

  return jsonNoStore({
    rules: rules.map(r => ({
      id: r.id,
      method: r.method,
      label: r.label,
      feePercent: Number(r.feePercent),
      countAsIncome: r.countAsIncome,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      createdBy: r.createdBy,
    })),
  })
}

/** POST /api/payment-method-rules — 建立或更新付款方式規則 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, req.method, req.url)
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({} as any))
  const { id, method, label, feePercent, countAsIncome, effectiveFrom, effectiveTo } = body

  if (!method || label == null || feePercent == null || !effectiveFrom) {
    return NextResponse.json({ error: 'method, label, feePercent, effectiveFrom required' }, { status: 400 })
  }

  try {
    let rule
    if (id) {
      // Update existing rule
      rule = await prisma.paymentMethodRule.update({
        where: { id },
        data: {
          label,
          feePercent: new Prisma.Decimal(String(feePercent)),
          countAsIncome,
          effectiveFrom: new Date(effectiveFrom),
          effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
        },
      })
    } else {
      // Create new rule
      rule = await prisma.paymentMethodRule.create({
        data: {
          method,
          label,
          feePercent: new Prisma.Decimal(String(feePercent)),
          countAsIncome: countAsIncome ?? true,
          effectiveFrom: new Date(effectiveFrom),
          effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
          createdBy: auth.session!.userId,
        },
      })
    }

    // Audit log
    await prisma.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: id ? 'UPDATE' : 'CREATE',
        entity: 'PaymentMethodRule',
        entityId: rule.id,
        notes: `${id ? '更新' : '新增'}付款方式規則：${method} ${feePercent}% ${label} 生效 ${effectiveFrom}`,
        afterJson: JSON.stringify({ method, label, feePercent, countAsIncome, effectiveFrom }),
      },
    }).catch(e => console.error('[payment-method-rules] audit failed', e))

    return NextResponse.json({
      rule: {
        id: rule.id,
        method: rule.method,
        label: rule.label,
        feePercent: Number(rule.feePercent),
        countAsIncome: rule.countAsIncome,
        effectiveFrom: rule.effectiveFrom,
        effectiveTo: rule.effectiveTo,
        createdBy: rule.createdBy,
      },
    })
  } catch (e: any) {
    console.error('[payment-method-rules] POST failed', e)
    return NextResponse.json({ error: '建立失敗' }, { status: 500 })
  }
}
