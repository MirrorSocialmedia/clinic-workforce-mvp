export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { handleRoute } from '@/lib/api-guard'
import { prisma } from '@/lib/prisma'
import { syncClinicForJob, shouldCancel, updateJob } from '@/lib/apricot/sync'
import { withApricotLock } from '@/lib/apricot/lock'

/** 清理殭屍 job：
 * ★ cwm-syncstuck-20260918 E2：兩條規則
 *   ① cancelRequested 但 2 分鐘仍然 RUNNING → 背景已經死，直接收工（CANCELLED）
 *   ② 冇 cancel 但 RUNNING 超過 1 小時 → zombie（FAILED）
 *   ⚠️ 規則② 維持 1 小時（本單紀律：生產數據未出，唔縮到 10 分鐘，防誤殺長 sync）
 */
async function cleanZombieJobs() {
  await prisma.apricotSyncJob.updateMany({
    where: {
      status: 'RUNNING',
      cancelRequested: true,
      startedAt: { lt: new Date(Date.now() - 2 * 60 * 1000) },
    },
    data: { status: 'CANCELLED', errorMessage: '已停止（背景程序未回應）', currentStep: '已停止', endedAt: new Date() },
  })
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
  // ★ cwm-syncforce-20260913 B：force 預設 false（定期 sync / cron 唔會 accidentally 變 force）
  force = false,
) {
  // ★ cwm-syncstuck-20260918 E1-2：任何路徑走完（完成／失敗／cancel／未預期 throw），
  //   job 都唔可以留喺 RUNNING —— 兜底 finally。
  //   ⚠️ updateMany + status:'RUNNING' 條件：正常完成嘅 job 已經係 DONE/CANCELLED/FAILED，唔會被覆蓋。
  try {
  // 順序執行，唔准 Promise.all — 每次 call 可能 rotate token
  let totalPayments = 0
  let totalBills = 0
  let totalAllocs = 0

  const acquired = await withApricotLock(async () => {
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
        const r = await syncClinicForJob(t, fromISO, toISO, jobId, force)
        if (r.cancelled) {
          // ★ cwm-syncstuck-20260918 E1：舊註釋講大話 —— syncClinicForJob 內部嘅 cancel
          //   （lib/apricot/sync.ts `return finish(true, …)`）只係 return，【唔會】寫 job。
          //   唔喺呢度補寫，status 永遠停喺 RUNNING、currentStep 停喺「拉帳單 100/100」，
          //   而 409 守衛令之後開唔到新 job。
          await updateJob(jobId, {
            status: 'CANCELLED',
            doneClinics: i,
            paymentsSynced: totalPayments + (r.paymentsSynced ?? 0),
            billsChecked: totalBills + (r.billsChecked ?? 0),
            allocRows: totalAllocs + (r.allocRows ?? 0),
            currentStep: '已停止',
            endedAt: new Date(),
          })
          return
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

  // ★ cwm-ops P4-6：攞唔到鎖（Apricot 正被另一 process 用，例如臨床索引夜跑）→
  //   即刻標 FAILED，唔好卡住 RUNNING 等到 zombie cleanup
  if (acquired === null) {
    await updateJob(jobId, {
      status: 'FAILED',
      errorMessage: 'Apricot 正忙，請稍後再試',
      currentStep: 'Apricot 正忙',
      endedAt: new Date(),
    })
  }
  } finally {
    // ★ cwm-syncstuck-20260918 E1-2：兜底 —— process 中途死（deploy/OOM/重啟）之前，
    //   任何正常退出但漏咗終態嘅 job 都轉 FAILED。已係終態嘅 job（status≠RUNNING）唔受影響。
    await prisma.apricotSyncJob.updateMany({
      where: { id: jobId, status: 'RUNNING' },
      data: { status: 'FAILED', errorMessage: '背景程序結束但未標記完成', endedAt: new Date() },
    }).catch(() => { /* 兜底都失敗：zombie cleanup 會收尾 */ })
  }
}

/** POST /api/apricot/sync — 建立 job + 背景執行（OWNER only） */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, req.method, req.url)
  if (isAuthError(auth)) return auth.error

  return handleRoute('apricot/sync', async () => {
    const body = await req.json().catch(() => ({} as any))
    const { clinicId, from, to, force } = body
    // ★ cwm-syncforce-20260913 B：force 只認嚴格 boolean true（防手寫字串 "true" 被當 force）；
    //   預設 false —— 定期 sync 維持快取，force 只俾人手 backfill 用。
    const forceMode = force === true

    if (!from || !to) {
      return NextResponse.json({ error: 'from, to required' }, { status: 400 })
    }

    // ★ cwm-syncforce-20260913 B：force 會逐張單 call Apricot API —— 限 7 日內，防手殘拉半年
    if (forceMode) {
      const days = (new Date(to).getTime() - new Date(from).getTime()) / 86400000
      if (days > 7) {
        return NextResponse.json(
          { error: '強制重拉只准 7 日內範圍（會逐張單 call Apricot API）' }, { status: 400 })
      }
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
        {
          error: '已有同步任務進行中',
          jobId: runningJob.id,
          // ★ cwm-syncstuck-20260918 E3-1：淨係話「進行中」用戶唔知係邊個卡住，
          //   撳極都冇反應仲以為個掣壞咗。
          running: {
            clinicExtId: runningJob.clinicExtId,
            totalClinics: runningJob.totalClinics,
            doneClinics: runningJob.doneClinics,
            currentStep: runningJob.currentStep,
            cancelRequested: runningJob.cancelRequested,
            startedAt: runningJob.startedAt,
          },
        },
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
      // ★ cwm-syncclinicid-20260914：caller 可能傳【我哋嘅 Clinic.id】（reconciliation backfill）
      //   或者【apricotClinicId】（apricot-sync 頁下拉）。route 要兩種都收得。
      //   ⚠️ 之前直接當佢係 apricotClinicId → backfill 傳 cuid 就 APRICOT_HTTP_500
      //      "invalid hexadecimal representation of an ObjectId"。
      const c = await prisma.clinic.findFirst({
        where: { OR: [{ id: clinicId }, { apricotClinicId: clinicId }] },
        select: { id: true, name: true, apricotClinicId: true },
      })
      if (!c) {
        return NextResponse.json({ error: `搵唔到診所：${clinicId}` }, { status: 404 })
      }
      if (!c.apricotClinicId) {
        return NextResponse.json(
          { error: `診所「${c.name}」未綁 Apricot ID，唔同步得` }, { status: 400 })
      }
      targets = [c.apricotClinicId]
      clinicExtId = c.apricotClinicId
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
        heartbeatAt: new Date(),
      },
    })

    // 5) 背景執行 — 唔等完成；加 .catch() 防止未預期錯誤令 job 永遠 RUNNING
    void runSyncInBackground(job.id, targets, fromISO, toISO, forceMode).catch(async (e: any) => {
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
