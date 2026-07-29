export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

export async function GET(req: NextRequest) {
 const auth = await requireAuth(req, 'GET', req.url)
 if (isAuthError(auth)) return auth.error

 const pending = await prisma.faceTemplate.findMany({
  where: {
   active: false,
   approvedAt: null,
   embedding: { not: '' },       // ★ 隔走登記中途失敗嘅佔位記錄
   refFrameId: { not: null },    // ★ 冇參考照嘅審核唔到，唔好出
  },
  include: { employee: { include: { user: { select: { name: true } } } } },
  orderBy: { enrolledAt: 'desc' },
 })

 return NextResponse.json(pending.map(p => ({
  id: p.id,
  employeeId: p.employeeId,
  employeeName: p.employee.user.name,
  enrolledAt: p.enrolledAt,
  enrolledBy: p.enrolledBy,
  refFrameId: p.refFrameId,
 })))
}
