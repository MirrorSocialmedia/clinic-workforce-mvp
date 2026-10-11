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
      countForDoctor: r.countForDoctor,
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
  const { id, method, label, feePercent, countAsIncome, countForDoctor, effectiveFrom, effectiveTo } = body

  if (!method || label == null || feePercent == null || !effectiveFrom) {
    return NextResponse.json({ error: 'method, label, feePercent, effectiveFrom required' }, { status: 400 })
  }
  // ★ cwm-doctorflag-20261011：兩個旗一定要係 true／false（唔准 "false" 字串當 true）
  if ((countAsIncome !== undefined && typeof countAsIncome !== 'boolean')
    || (countForDoctor !== undefined && typeof countForDoctor !== 'boolean')) {
    return NextResponse.json({ error: '計收入／計醫生收入要係 true 或 false' }, { status: 400 })
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
          countForDoctor, // undefined = 唔改
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
          // ★ cwm-doctorflag-20261011：冇講 → 跟計收入（同舊口徑：計店舖營收嘅都計醫生）
          countForDoctor: countForDoctor ?? (countAsIncome ?? true),
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
        notes: `${id ? '更新' : '新增'}付款方式規則：${method} ${feePercent}% ${label} 計店舖營收=${rule.countAsIncome ? '是' : '否'} 計醫生收入=${rule.countForDoctor ? '是' : '否'} 生效 ${effectiveFrom}`,
        afterJson: JSON.stringify({ method, label, feePercent, countAsIncome: rule.countAsIncome, countForDoctor: rule.countForDoctor, effectiveFrom }),
      },
    }).catch(e => console.error('[payment-method-rules] audit failed', e))

    return NextResponse.json({
      rule: {
        id: rule.id,
        method: rule.method,
        label: rule.label,
        feePercent: Number(rule.feePercent),
        countAsIncome: rule.countAsIncome,
        countForDoctor: rule.countForDoctor,
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
