export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// PUT /api/employees/:id/pay-rules/:ruleId — update existing pay rule
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string; ruleId: string } }
) {
  const auth = requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const body = await req.json()
  const { modularConfig, payType, baseAmount } = body

  const rule = await prisma.payRule.update({
    where: { id: params.ruleId },
    data: {
      ...(payType ? { payType } : {}),
      ...(baseAmount !== undefined ? { baseAmount } : {}),
      ...(modularConfig ? { configJson: JSON.stringify(modularConfig) } : {}),
    },
  })

  return NextResponse.json({ success: true, rule })
}
