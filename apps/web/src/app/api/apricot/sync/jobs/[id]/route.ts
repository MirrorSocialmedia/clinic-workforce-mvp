// ownership-ok: ApricotSyncJob 係全公司系統任務，冇 clinic/employee 歸屬；
// route 已經喺 RBAC matrix 限定 OWNER
export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'

/** GET /api/apricot/sync/jobs/[id] — 回進度 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req, req.method, req.url)
  if (isAuthError(auth)) return auth.error

  const { id } = await params
  const job = await prisma.apricotSyncJob.findUnique({
    where: { id },
  })

  if (!job) {
    return jsonNoStore({ error: 'job not found' }, { status: 404 })
  }

  return jsonNoStore({ job })
}

/** POST /api/apricot/sync/jobs/[id] — cancel（set cancelRequested = true） */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req, req.method, req.url)
  if (isAuthError(auth)) return auth.error

  const { id } = await params
  const job = await prisma.apricotSyncJob.findUnique({
    where: { id },
    select: { status: true },
  })

  if (!job) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 })
  }

  if (job.status !== 'RUNNING') {
    return NextResponse.json({ error: 'job is not running' }, { status: 400 })
  }

  await prisma.apricotSyncJob.update({
    where: { id },
    data: { cancelRequested: true },
  })

  return NextResponse.json({ success: true })
}
