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

  const rule = await prisma.payRule.update({
    where: { id: params.ruleId },
    data: {
      ...(payType ? { payType } : {}),
      ...(baseAmount !== undefined ? { baseAmount } : {}),
      ...(modularConfig ? { configJson: JSON.stringify(modularConfig) } : {}),
      ...(effectiveFrom ? { effectiveFrom: new Date(`${effectiveFrom}T00:00:00+08:00`) } : {}),
    },
  })

  return NextResponse.json({ success: true, rule })
}
