// ownership-ok: ApricotSyncJob 係全公司系統任務，冇 clinic/employee 歸屬；
// route 已經喺 RBAC matrix 限定 OWNER
export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { getBillFetchStats } from '@/lib/apricot/sync'

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

  // ★ cwm-syncforce-20260913 D: billsFetched = 實際重拉數（in-memory stats，非持久欄）。
  //   只在 stats map 有記錄時先帶（job 未終態／server 重啟後／舊 job 都唔會帶）→ UI 唔會講大話。
  const billsFetched = getBillFetchStats(id)
  return jsonNoStore(billsFetched != null ? { job: { ...job, billsFetched } } : { job })
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
    select: { status: true, startedAt: true, heartbeatAt: true },
  })

  if (!job) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 })
  }

  if (job.status !== 'RUNNING') {
    return NextResponse.json({ error: 'job is not running' }, { status: 400 })
  }

  // ★ cwm-syncstuck-20260918 E3-3：除咗 cancelRequested，如果背景已經冇回應
  //   （heartbeatAt 超過 2 分鐘冇郁 —— 每個 checkpoint 都會刷），直接標 CANCELLED，唔好等。
  //   heartbeatAt 為 null（舊 job / 從未 checkpoint）→ fallback 用 startedAt。
  const lastBeat = job.heartbeatAt ?? job.startedAt
  const stale = Date.now() - lastBeat.getTime() > 2 * 60 * 1000
  await prisma.apricotSyncJob.update({
    where: { id },
    data: stale
      ? { cancelRequested: true, status: 'CANCELLED', currentStep: '已停止', endedAt: new Date(), errorMessage: '人手中止（背景未回應）' }
      : { cancelRequested: true },
  })

  return NextResponse.json({ success: true, cancelledImmediately: stale })
}
