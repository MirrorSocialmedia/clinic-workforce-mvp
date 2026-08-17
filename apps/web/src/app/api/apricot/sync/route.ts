export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { handleRoute } from '@/lib/api-guard'
import { prisma } from '@/lib/prisma'
import { syncClinicForJob, shouldCancel, updateJob } from '@/lib/apricot/sync'
import { withApricotLock } from '@/lib/apricot/lock'

/** 清理殭屍 job：RUNNING + 超過 1 小時 → FAILED */
async function cleanZombieJobs() {
  await prisma.apricotSyncJob.updateMany({
    where: {
      status: 'RUNNING',
      startedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) },
    },
    data: { status: 'FAILED', errorMessage: '逾時或程序中斷', endedAt: new Date() },
  })
}

/** 背景執行同步 — 被 withApricotLock 包起，支援 cancel */
async function runSyncInBackground(
  jobId: string,
  targets: string[],
  fromISO: string,
  toISO: string,
) {
  // 順序執行，唔准 Promise.all — 每次 call 可能 rotate token
  let totalPayments = 0
  let totalBills = 0
  let totalAllocs = 0

  await withApricotLock(async () => {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]

      // 檢查 cancel
      if (await shouldCancel(jobId)) {
        await updateJob(jobId, {
          status: 'CANCELLED',
          doneClinics: i,
          paymentsSynced: totalPayments,
          billsChecked: totalBills,
          allocRows: totalAllocs,
          currentStep: '已停止',
          endedAt: new Date(),
        })
        return
      }

      await updateJob(jobId, {
        currentStep: `診所 ${i + 1}/${targets.length}：${t}`,
      })

      try {
        const r = await syncClinicForJob(t, fromISO, toISO, jobId)
        if (r.cancelled) {
          return // shouldCancel 已經處理咗 job status
        }
        totalPayments += r.paymentsSynced
        totalBills += r.billsChecked
        totalAllocs += r.allocRows

        await updateJob(jobId, {
          doneClinics: i + 1,
          paymentsSynced: totalPayments,
          billsChecked: totalBills,
          allocRows: totalAllocs,
        })
      } catch (e: any) {
        console.error(`[apricot/sync-bg] 診所 ${t} 失敗`, e)
        await updateJob(jobId, {
          status: 'FAILED',
          doneClinics: i,
          paymentsSynced: totalPayments,
          billsChecked: totalBills,
          allocRows: totalAllocs,
          errorMessage: e.message || 'sync failed',
          currentStep: `診所 ${t} 失敗`,
          endedAt: new Date(),
        })
        return
      }
    }

    // All done
    await updateJob(jobId, {
      status: 'DONE',
      doneClinics: targets.length,
      paymentsSynced: totalPayments,
      billsChecked: totalBills,
      allocRows: totalAllocs,
      currentStep: '完成',
      endedAt: new Date(),
    })
  })
}

/** POST /api/apricot/sync — 建立 job + 背景執行（OWNER only） */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, req.method, req.url)
  if (isAuthError(auth)) return auth.error

  return handleRoute('apricot/sync', async () => {
    const body = await req.json().catch(() => ({} as any))
    const { clinicId, from, to } = body

    if (!from || !to) {
      return NextResponse.json({ error: 'from, to required' }, { status: 400 })
    }

    // 1) Clean zombie jobs
    await cleanZombieJobs()

    // 2) 檢查是否有 RUNNING job
    const runningJob = await prisma.apricotSyncJob.findFirst({
      where: { status: 'RUNNING' },
      orderBy: { startedAt: 'desc' },
    })
    if (runningJob) {
      return NextResponse.json(
        { error: '已有同步任務進行中', jobId: runningJob.id },
        { status: 409 },
      )
    }

    // 3) 解析 target clinics
    const userId = auth.session.userId
    const fromISO = from
    const toISO = to

    let targets: string[]
    let clinicExtId: string | null = null

    if (clinicId) {
      targets = [clinicId]
      clinicExtId = clinicId
    } else {
      const cs = await prisma.clinic.findMany({
        where: { apricotClinicId: { not: null } },
        select: { apricotClinicId: true },
        orderBy: { id: 'asc' },
      })
      targets = cs.map(c => c.apricotClinicId!).filter(Boolean)
      if (targets.length === 0) {
        return NextResponse.json({ error: '冇任何診所綁咗 Apricot ID' }, { status: 400 })
      }
    }

    // 4) 建 job 記錄
    const job = await prisma.apricotSyncJob.create({
      data: {
        clinicExtId,
        fromDate: new Date(fromISO),
        toDate: new Date(toISO),
        totalClinics: targets.length,
        createdBy: userId,
        currentStep: '準備中',
      },
    })

    // 5) 背景執行 — 唔等完成；加 .catch() 防止未預期錯誤令 job 永遠 RUNNING
    void runSyncInBackground(job.id, targets, fromISO, toISO).catch(async (e: any) => {
      console.error('[apricot/sync-bg] 未預期錯誤', e)
      await prisma.apricotSyncJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          errorMessage: String(e?.message ?? e).slice(0, 500),
          currentStep: '未預期錯誤',
          endedAt: new Date(),
        },
      }).catch(() => { /* job 都寫唔到就算 */ })
    })

    // 6) 即刻回 jobId
    return NextResponse.json({ jobId: job.id })
  })
}
