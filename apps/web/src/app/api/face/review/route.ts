export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { noReportReviewWindow } from '@/lib/face-status'

// GET /api/face/review — List FAIL punches awaiting review
// Roles: OWNER, MANAGER
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  // ★ cwm-facemissing-20261010：加埋「手機冇回報人臉結果」—— 自己打嘅卡（QR）過咗 5 分鐘窗口仍然冇結果
  //   （舊版唔列 → 靜靜漏咗）。只計最近 30 日，免得舊數一次過塞爆覆核頁。
  // ★ cwm-facereviewcut-20261011：再加生效日（FACE_NO_REPORT_SINCE）—— 更新前嘅舊數唔追究
  const items = await prisma.punchRecord.findMany({
    where: {
      faceReviewedAt: null,
      OR: [
        { faceStatus: { in: ['FAIL', 'NO_FACE', 'SKIPPED'] } },
        {
          faceStatus: null,
          source: 'QR_DYNAMIC',
          createdAt: noReportReviewWindow(),
        },
      ],
    },
    include: {
      employee: { include: { user: { select: { name: true } } } },
      clinic: { select: { name: true } },
    },
    orderBy: { punchTime: 'desc' },
  })

  return NextResponse.json(items.map(item => ({
    id: item.id,
    punchTime: item.punchTime,
    employeeName: item.employee.user.name,
    clinicName: item.clinic.name,
    faceStatus: item.faceStatus ?? 'NO_REPORT',
    faceScore: item.faceScore,
    faceLiveness: item.faceLiveness,
    faceFramePath: item.faceFramePath,
    faceReason: item.faceReason,
  })))
}
