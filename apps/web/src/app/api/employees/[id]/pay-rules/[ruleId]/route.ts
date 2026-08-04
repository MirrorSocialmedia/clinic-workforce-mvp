export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// PUT /api/employees/:id/pay-rules/:ruleId — update existing pay rule
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string; ruleId: string } }
) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const body = await req.json()
  const { modularConfig, payType, baseAmount, effectiveFrom } = body

  // ★ 2026-08-04：驗證年假階梯格式
  if (modularConfig) {
    const table = modularConfig?.modifiers?.annual_leave?.table
    if (table !== undefined) {
      if (!Array.isArray(table) || table.some(n => typeof n !== 'number' || n < 0 || n > 60)) {
        return NextResponse.json({ error: '年假階梯必須係 0-60 嘅數字陣列' }, { status: 400 })
      }
      if (table.length > 20) {
        return NextResponse.json({ error: '年假階梯最多 20 個年度' }, { status: 400 })
      }
      // 唔擋低過法定（resolveLeaveTable 會自動補），但 console.warn 提醒
      const STATUTORY = [7, 7, 8, 9, 10, 11, 12, 13, 14]
      const hasBelowStatutory = table.some((n: number, i: number) => {
        const stat = STATUTORY[Math.min(i, STATUTORY.length - 1)]
        return n < stat
      })
      if (hasBelowStatutory) {
        console.warn('[PayRules] annual_leave.table 部分值低過法定，已自動補至法定底線')
      }
    }
  }

  const before = await prisma.payRule.findUnique({
    where: { id: params.ruleId },
    include: { employee: { select: { id: true, user: { select: { name: true } } } } },
  })
  if (!before) return NextResponse.json({ error: 'PayRule not found' }, { status: 404 })

  const rule = await prisma.payRule.update({
    where: { id: params.ruleId },
    data: {
      ...(payType ? { payType } : {}),
      ...(baseAmount !== undefined ? { baseAmount } : {}),
      ...(modularConfig ? { configJson: JSON.stringify(modularConfig) } : {}),
      ...(effectiveFrom ? { effectiveFrom: new Date(`${effectiveFrom}T00:00:00+08:00`) } : {}),
    },
  })

  // ★ 2026-08-04: 薪酬規則變更必須審計
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'PAY_RULE_UPDATE',
      entity: 'PayRule',
      entityId: rule.id,
      targetEmployeeId: rule.employeeId,
      beforeJson: JSON.stringify({
        payType: before!.payType,
        baseAmount: before!.baseAmount,
        configJson: before!.configJson,
        effectiveFrom: before!.effectiveFrom?.toISOString(),
      }),
      afterJson: JSON.stringify({
        payType: rule.payType,
        baseAmount: rule.baseAmount,
        configJson: rule.configJson,
        effectiveFrom: rule.effectiveFrom?.toISOString(),
      }),
      notes: `更新薪酬規則 (${before!.employee?.user?.name ?? ''})`,
      ipAddress: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: req.headers.get('user-agent') ?? null,
    },
  })

  return NextResponse.json({ success: true, rule })
}
