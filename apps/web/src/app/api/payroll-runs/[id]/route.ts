export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma, basePrisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope, getConfidentialScope } from '@/lib/scope-helpers'
import { runWithAudit } from '@/lib/audit-context'
import { snapshotWagesForADW } from '@/lib/adw'
import { toHKDateStr, hkDateStart } from '@/lib/hk-date'
// ★ cwm-tbfix-20260910 P1-2：最新生效 pay rule 統一口徑（P0-2 / 坑②）
import { PAY_RULE_SELECT } from '@/lib/pay-rule-latest'
import { computeRosterHours, rosterDiffNote, rosterDiffNoteFilter } from '@/lib/roster-hours'
// ★ cwm-tbcache-rosterdiff-20260909：寫／刪 TimeBankEntry 一定要 invalidate 快取（坑④）
import { invalidateTimeBankFrom } from '@/lib/punch-query'
// ★ cwm-lbsnap-asof-20260909：snapshot 要同排班總覽「剩餘」用同一個口徑
import { restDayBalanceAsOf } from '@/lib/leave-balance-as-of'
// ★ cwm-tbledger-20260909 C1：finalize 凍結時間帳戶帳本（同讀取側總覽用同一個 builder）
import { buildTimeBankLedger } from '@/lib/timebank-ledger'
import { TIMEBANK_ENGINE_VERSION } from '@/lib/payroll-engine'


// GET /api/payroll-runs/[id] — Payroll run detail with items
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const run = await prisma.payrollRun.findUnique({
    where: { id: params.id },
    include: {
      clinic: { select: { id: true, name: true } },
      items: {
        include: {
          employee: {
            select: {
              payConfidential: true,
              homeClinicId: true,
              status: true,
              resignedAt: true,
              user: { select: { id: true, name: true, phone: true } },
              clinics: { select: { clinicId: true, clinic: { select: { name: true } } } },
              // ★ cwm-tbfix-20260910 P1-2：最新生效規則口徑統一（lib/pay-rule-latest）
              payRules: PAY_RULE_SELECT,
            },
          },
        },
        orderBy: { employeeId: 'asc' },
      },
    },
  })

  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // ★ Cross-clinic guard (2026-08-03): 被限制範圍嘅人唔可以開跨店計糧單
  const allowed = await resolveClinicScope(session, auth.perms ?? [], {
    homeOnly: ['payroll_view', 'payroll_generate'],
  })
  if (allowed !== null) {
    if (!run.clinicId) {
      return NextResponse.json({ error: '你冇權限查看跨店計糧單' }, { status: 403 })
    }
    if (!allowed.includes(run.clinicId)) {
      return NextResponse.json({ error: '你冇權限查看呢間診所嘅計糧單' }, { status: 403 })
    }
  }

  // ★ Confidential filter — 用 getConfidentialScope 一次過算好範圍（2026-08-03）
  const perms = auth.perms ?? []
  const confidentialScope = await getConfidentialScope(session, perms)
  let items = run.items
  if (confidentialScope !== null) {
    items = items.filter((item: any) =>
      !item.employee?.payConfidential || (!!item.employee?.homeClinicId && confidentialScope.includes(item.employee.homeClinicId))
    )
  }

  // ★ cwm-tbfix-20260910 P1-1：run 列表嘅 per-employee timeBankLedger 拼裝（舊 S5 F 段）已剷 ——
  //   grep 全 repo：唯一 consumer 係糧單詳情頁（payroll/[id]/employee/[empId]/page.tsx:308），
  //   而佢由自己條 route（api/payroll-runs/[id]/employee/[empId]）攞 ledger，呢度 N ×
  //   calculateTimeBank 冇人用（實測 3 人 run 列表 458ms，大頭係呢段）。糧單詳情頁零影響。
  //   日後列表真要 ledger 先加 ?withLedger=1 開關。

  // ★ Extract sickDeduction from detailJson for each item
  //   (2026-08-02: sickDeduction is stored in detailJson, not in PayrollItem.deduction)
  const itemsWithSickDeduction = items.map((it: any) => ({
    ...it,
    sickDeduction: (() => {
      try { return JSON.parse(it.detailJson || '{}').sickDeduction ?? 0 } catch { return 0 }
    })(),
  }))

  // ★ Totals recalculated from visible items only (prevents reverse-engineering)
  const summary = {
    totalEmployees: itemsWithSickDeduction.length,
    totalBasePay: itemsWithSickDeduction.reduce((s: number, i: any) => s + (i.basePay || 0), 0),
    totalOTPay: itemsWithSickDeduction.reduce((s: number, i: any) => s + (i.otPay || 0), 0),
    totalSplitPay: itemsWithSickDeduction.reduce((s: number, i: any) => s + (i.splitPay || 0), 0),
    // ★ totalDeduction includes both absent/unpaid deduction AND sick deduction (2026-08-02)
    totalDeduction: itemsWithSickDeduction.reduce(
      (s: number, i: any) => s + (i.deduction || 0) + (i.sickDeduction || 0), 0,
    ),
    totalPayable: itemsWithSickDeduction.reduce((s: number, i: any) => s + (i.totalPayable || 0), 0),
    totalWorkedHours: itemsWithSickDeduction.reduce((s: number, i: any) => s + i.workedHours, 0),
    totalOTHours: itemsWithSickDeduction.reduce((s: number, i: any) => {
      let detail: any = null
      try { detail = i.detailJson ? JSON.parse(i.detailJson) : null } catch {}
      return s + (detail?.timebank?.otMinutes ?? i.otHours * 60) / 60
    }, 0),
    totalLeaveDays: itemsWithSickDeduction.reduce((s: number, i: any) => s + i.leaveDays, 0),
    totalAbsentDays: itemsWithSickDeduction.reduce((s: number, i: any) => s + i.absentDays, 0),
  }

  return NextResponse.json({ run: { ...run, items: itemsWithSickDeduction }, summary }, {
    headers: { 'Cache-Control': 'no-store, must-revalidate' },
  })
}

// PUT /api/payroll-runs/[id] — Update payroll run status/notes
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const t0 = Date.now()
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const run = await prisma.payrollRun.findUnique({ where: { id: params.id } })
      if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

      const body = await req.json()
      const { status, notes, payDate } = body

      // ★ 2026-08-25：payDate 只准喺 DRAFT 改（同已鎖定唔准改同一原則）
      if (payDate !== undefined && run.status !== 'DRAFT') {
        return NextResponse.json({ error: '已確認計糧，唔可以改發薪日期' }, { status: 409 })
      }

      if (status) {
        const validStatuses = ['DRAFT', 'FINALIZED', 'EXPORTED'] as const
        if (!validStatuses.includes(status as any)) {
          return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, { status: 400 })
        }

        const order: Record<string, number> = { DRAFT: 0, FINALIZED: 1, EXPORTED: 2 }
        const isDowngrade = order[status] < order[run.status]

        if (isDowngrade) {
          // ★ 退回草稿：只准 FINALIZED → DRAFT，OWNER 限定，必須填原因
          if (!(run.status === 'FINALIZED' && status === 'DRAFT')) {
            return NextResponse.json(
              { error: `唔支援由 ${run.status} 退回 ${status}（已匯出的計糧單唔可以退回）` },
              { status: 400 },
            )
          }
          if (session.role !== 'OWNER') { // ROLE-OK：保密員工隔離刻意用 role
            return NextResponse.json({ error: '只有 OWNER 可以退回計糧單至草稿' }, { status: 403 })
          }
          const reason = (body.reason ?? '').trim()
          if (reason.length < 5) {
            return NextResponse.json({ error: '退回草稿必須填寫原因（至少 5 個字）' }, { status: 400 })
          }
        }
      }

      // FIX #1: Use $transaction — status update + audit in same transaction
      // ★ 覆核 P0-1：帳本凍結令 transaction 重好多（N × calculateTimeBank）。
      //   默認 5s 唔夠（實測 3 人 721ms → 21 人 ≈ 5s）。同 payroll-engine.ts:1173 同一設定。
      const updated = await basePrisma.$transaction(async (tx) => {
        const result = await tx.payrollRun.update({
          where: { id: params.id },
          data: {
            ...(status && { status }),
            ...(notes !== undefined && { notes }),
            // ★ payDate 入庫一律 HK 午夜（同 periodMonth 同一原則）；空字串 = 清除
            ...(payDate !== undefined && { payDate: payDate ? hkDateStart(payDate) : null }),
          },
          include: { _count: { select: { items: true } }, clinic: { select: { id: true, name: true } } },
        })

        // ★ periodKey helper — 寫入同退回用同一個 helper，確保格式一致（2026-08-15）
        const periodKey = (v: string | Date) =>
          typeof v === 'string' ? v.slice(0, 7) : toHKDateStr(v).slice(0, 7)

        // cwm-tbledger-20260909 C2：finalize 凍結人數 — 供尾段 PAYROLL_FINALIZE audit notes 用
        let frozenCount = 0

        // ★★ DRAFT → FINALIZED: auto-snapshot wage records for ADW
        if (status === 'FINALIZED' && run.status === 'DRAFT') {
          await snapshotWagesForADW(tx, params.id, auditCtx.actorId)

          // ★ 編更差額入帳（每個月薪員工一筆）
          const items = await tx.payrollItem.findMany({
            where: { runId: params.id },
            include: {
              employee: {
                select: {
                  id: true,
                  // ★ cwm-tbfix-20260910 P1-2：最新生效規則口徑統一（lib/pay-rule-latest）
                  payRules: PAY_RULE_SELECT,
                },
              },
            },
          })
          const pm = periodKey(run.periodMonth)
          const [py, pmNum] = pm.split('-').map(Number)
          // ★ nextMonthStart 已處理跳年 —— 統一用它導出 monthEndDate
          const nextMonthStart = new Date(
            pmNum === 12
              ? `${py + 1}-01-01T00:00:00+08:00`
              : `${py}-${String(pmNum + 1).padStart(2, '0')}-01T00:00:00+08:00`
          )
          // 月尾 = 下月 1 號減 1 毫秒（同 hk-date.ts getMonthRange 一致）
          const monthEndDate = new Date(nextMonthStart.getTime() - 1)
          const monthStart = new Date(`${pm}-01T00:00:00+08:00`)
          // ★ 提到迴圈外 — 防止 N+1 query 撞 transaction timeout（2026-08-15）
          const empIds = items
            .filter(i => i.employee.payRules[0]?.payType === 'MONTHLY')
            .map(i => i.employee.id)

          const rosterHours = await computeRosterHours(empIds, pm, tx)

          // ★ cwm-tbcache-rosterdiff-20260909 A2（坑④）：收集受影響員工 —— 迴圈後一次過
          //   批次 invalidate TimeBank 快取（= 逐個叫 invalidateTimeBankFrom 的批次版，
          //   一次 deleteMany；2026-08-15 逐人發 query 撞過 transaction timeout）。
          const touchedEmpIds: string[] = []
          for (const item of items) {
            const payRule = item.employee.payRules[0]
            if (!payRule || payRule.payType !== 'MONTHLY') continue
            const empId = item.employee.id

            const rh = rosterHours.get(empId)
            const diff = Math.round(rh?.diffMinutes ?? 0)
            if (diff === 0) continue

            // ★ monthEndDate 用日結 timestamp；TimeBankEntry 無 unique constraint，唔會撞
            await tx.timeBankEntry.create({
              data: {
                employeeId: empId,
                date: monthEndDate,
                type: 'ROSTER_DIFF',
                minutes: diff,
                note: `${rosterDiffNote(pm)}：已編班 ${((rh?.rosterMinutes ?? 0) / 60).toFixed(1)}h − 應返 ${((rh?.expectedMinutes ?? 0) / 60).toFixed(1)}h`,
                createdBy: session.userId,
              },
            })
            touchedEmpIds.push(empId)
          }

          // ★★★ cwm-tbcache-rosterdiff-20260909 A2（坑④）：寫咗 TimeBankEntry 就一定要
          //   invalidate，否則 getCarriedFrom（payroll-engine.ts:1461-1466）會攞舊 TimeBank
          //   快取直接 return，呢筆 ROSTER_DIFF 永遠唔會入條鏈。
          //   ⚠️ 舊 cacheKey 只 hash config + 引擎版本，寫幾多 entry 個 key 都唔變 —— 靠佢兜唔到
          //      （B 章 fingerprint 係第二道防線）。
          //   ⚠️ 傳 tx（唔係 prisma），見得到本 transaction 已寫入嘅 entry。
          //   ⚠️ 下界用 monthStart = getMonthRange(monthEndDate).start（同
          //      invalidateTimeBankFrom(empId, monthEndDate, tx) 內部 deleteMany 完全同一語義）——
          //      TimeBank.periodMonth 存月首日（YYYY-MM-01 HK），用 monthEndDate 做下界會漏咗 run 自己嗰個月。
          if (touchedEmpIds.length > 0) {
            await tx.timeBank.deleteMany({
              where: { employeeId: { in: touchedEmpIds }, periodMonth: { gte: monthStart } },
            })
          }

          // ★★★ cwm-tbledger-20260909 C1：凍結時間帳戶帳本。
          //   位置一定要喺 ROSTER_DIFF 寫入【之後】—— ROSTER_DIFF 係嗰個月帳本嘅一行，
          //   先凍結後寫就永遠漏咗佢（LeaveBalanceSnapshot 撞過同一個坑）。
          //   upsert 唔用 create —— 重 FINALIZE（FINALIZED→DRAFT→FINALIZED）idempotent。
          for (const item of items) {
            const empId = item.employee.id
            let cfg: any = {}
            try { cfg = JSON.parse(item.employee.payRules?.[0]?.configJson || '{}') } catch { /* 壞 JSON 當冇 config */ }
            if (cfg?.base_type === 'hourly') continue          // ★ 時薪／兼職唔設時間帳戶

            const ledger = await buildTimeBankLedger(tx, empId, pm, cfg)
            await tx.timeBankLedgerSnapshot.upsert({
              where: { employeeId_periodMonth: { employeeId: empId, periodMonth: pm } },
              update: {
                opening: ledger.opening, closing: ledger.closing,
                linesJson: JSON.stringify(ledger.lines),
                engineVersion: TIMEBANK_ENGINE_VERSION,
                frozenAt: new Date(), frozenBy: session.userId,
              },
              create: {
                employeeId: empId, periodMonth: pm,
                opening: ledger.opening, closing: ledger.closing,
                linesJson: JSON.stringify(ledger.lines),
                engineVersion: TIMEBANK_ENGINE_VERSION,
                frozenBy: session.userId,
              },
            })
            frozenCount++
          }
          // ★ 覆核 P0-1：耗時 log —— 人數再大會有預警（runbook 4.3 計時目標；>30s 要停手回報）
          console.log(`[payroll-finalize] ${pm} 凍結 ${frozenCount} 人，耗時 ${Date.now() - t0}ms`)

          // ★ 2026-08-22 §6.2.2：假期餘額月結快照 —— 下個月排班總覽「上月剩」欄靠佢
          //   範圍：run 內全部員工（複用上面對面攞到嘅 items，唔多發 query）× 佢哋全部
          //   LeaveBalance 行（全 type 全 year）。
          //   ★ REST_DAY／OT補假係每曆年一行（LeaveBalance.year）—— 同一 (員工, 假期類型)
          //     會有多行；呢度按 (employeeId, leaveTypeId) 加總 remaining 合併成一行，
          //     配合 [employeeId, leaveTypeId, periodMonth] unique（唔合併會撞 constraint）。
          //     年假／生日假係累積制 year=0，每人一行，加總等於原值。
          // ★ 先刪後寫：重 FINALIZE（FINALIZED→DRAFT→FINALIZED）idempotent 唔重覆，unique 兜底。
          const snapEmpIds = items.map(i => i.employee.id)
          if (snapEmpIds.length > 0) {
            const snapBalances = await tx.leaveBalance.findMany({
              where: { employeeId: { in: snapEmpIds } },
              select: { employeeId: true, leaveTypeId: true, remaining: true },
            })
            if (snapBalances.length > 0) {
              const byEmpType = new Map<string, number>()
              for (const b of snapBalances) {
                const k = `${b.employeeId}|${b.leaveTypeId}`
                byEmpType.set(k, (byEmpType.get(k) ?? 0) + b.remaining)
              }

              // ★ cwm-lbsnap-asof-20260909 A2：REST_DAY 唔可以抄 LeaveBalance.remaining ——
              //   嗰個係【成個曆年嘅滾動值】，已經包含下個月已發放嘅休息日同已批嘅假期單。
              //   八月尾／九月初先確認計糧，snapshot 就會攞到「9 月已發、9 月已放」之後嘅數，
              //   令下個月「上月剩」對唔返上個月「剩餘」（實測 Jesscia 1 → −1、Luna 0 → 8）。
              //   ★★★ 一定要同 scheduling-leave-summary 個「剩餘」用【同一個 helper】——
              //      2026-09-05 cwm-lvsum 只改咗讀取側，寫入側漏咗（坑⑥）。
              //   ⚠️ helper 只支援 REST_DAY（年假／OT補假／生日假冇逐月發放記錄）→ 其餘類型照舊抄。
              const restType = await tx.leaveType.findFirst({
                where: { systemKey: 'REST_DAY' },
                select: { id: true },
              })
              if (restType) {
                // pm = periodKey(run.periodMonth)（:193 已算，格式 'YYYY-MM'）
                const [ry, rm] = pm.split('-').map(Number)
                const runLastDay = new Date(Date.UTC(ry, rm, 0)).getUTCDate()
                const runMonthEnd = `${pm}-${String(runLastDay).padStart(2, '0')}`
                // ⚠️ 傳 tx 入去 —— helper 係純讀，而且要見到本 transaction 已寫入嘅嘢
                const asOfRest = await restDayBalanceAsOf(tx, snapEmpIds, runMonthEnd)
                for (const [empId, v] of asOfRest) {
                  // ★ 係【覆寫】唔係相加 —— helper 已經回一個員工一個值
                  byEmpType.set(`${empId}|${restType.id}`, v.remaining)
                }
                // ★ helper 冇回嘅員工（冇 LeaveBalance REST_DAY 行）→ 保留上面抄嘅值（多數係冇呢個 key）
              }

              // ★ #50：periodMonth 用同 revert 端同一個 periodKey helper 導出（pm）——
              //   兩邊格式唔一致（例如 '2026-08' vs '2026-8'）會令退回刪唔到快照。
              await tx.leaveBalanceSnapshot.deleteMany({
                where: { employeeId: { in: snapEmpIds }, periodMonth: pm },
              })
              await tx.leaveBalanceSnapshot.createMany({
                data: [...byEmpType.entries()].map(([k, remaining]) => {
                  const [employeeId, leaveTypeId] = k.split('|')
                  return { employeeId, leaveTypeId, remaining, periodMonth: pm }
                }),
              })
            }
          }
        }

        // ★ 退回草稿：獨立 action，方便日後追查
        if (status === 'DRAFT' && run.status === 'FINALIZED') {
          // ★ 退回時刪除 ROSTER_DIFF 入帳
          const pk = periodKey(run.periodMonth)
          const itemsRevert = await tx.payrollItem.findMany({
            where: { runId: params.id },
            select: { employeeId: true },
          })
          // ⚠️ 靠 note 識月份——改咗上邊個文案要先改呢度！
          const deleted = await tx.timeBankEntry.deleteMany({
            where: {
              employeeId: { in: itemsRevert.map(i => i.employeeId) },
              type: 'ROSTER_DIFF',
              note: rosterDiffNoteFilter(pk),
            },
          })
          console.log(`[payroll-revert] 刪咗 ${deleted.count} 筆 ROSTER_DIFF`)

          // ★ 2026-08-22 §6.2.2：退回要刪假期餘額快照 ——
          //   唔刪嘅話下個月「上月剩」會攞到「已 finalize 但實際退咗」嘅數。
          // ★ #50：pk 同 finalize 寫入端同一個 periodKey helper 導出，格式保證一致。
          const snapDeleted = await tx.leaveBalanceSnapshot.deleteMany({
            where: { employeeId: { in: itemsRevert.map(i => i.employeeId) }, periodMonth: pk },
          })
          console.log(`[payroll-revert] 刪咗 ${snapDeleted.count} 筆 LeaveBalanceSnapshot`)

          // ★ cwm-tbledger-20260909 C3：退回要刪帳本快照 —— 唔刪嘅話總覽會顯示「已凍結」但實際已經退咗
          const ledgerDeleted = await tx.timeBankLedgerSnapshot.deleteMany({
            where: { employeeId: { in: itemsRevert.map(i => i.employeeId) }, periodMonth: pk },
          })
          console.log(`[payroll-revert] 刪咗 ${ledgerDeleted.count} 筆 TimeBankLedgerSnapshot`)

          // ★ cwm-tbcache-rosterdiff-20260909 A3：刪 ROSTER_DIFF 一樣要 invalidate —— 唔刪快取嘅話，
          //   退回之後條鏈仍然當嗰筆存在（方向相反，同一個病）。
          //   批次版：一次 deleteMany（幾十人逐個發 query 2026-08-15 撞過 transaction timeout）。
          //   ⚠️ 下界 = revert 月首日（由 pk 導出，同 rosterDiffNoteFilter 同一個 key，格式保證一致）；
          //   TimeBank.periodMonth 存月首日 —— run 月及之後全部清走，下游月份結轉要重算，正確
          //   （同 invalidateTimeBankFrom(it.employeeId, revertMonthStart, tx) 逐人版語義一致）。
          if (itemsRevert.length > 0) {
            const [ry, rm] = pk.split('-').map(Number)
            const revertMonthStart = new Date(`${ry}-${String(rm).padStart(2, '0')}-01T00:00:00+08:00`)
            await tx.timeBank.deleteMany({
              where: { employeeId: { in: itemsRevert.map(i => i.employeeId) }, periodMonth: { gte: revertMonthStart } },
            })
          }

          await tx.auditLog.create({
            data: {
              actorId: auditCtx.actorId,
              action: 'PAYROLL_REVERT_TO_DRAFT',
              entity: 'PayrollRun',
              entityId: params.id,
              beforeJson: JSON.stringify({ status: run.status }),
              afterJson: JSON.stringify({ status: 'DRAFT' }),
              notes: `退回草稿。原因：${body.reason}`,
            },
          })
        }

        // Manual audit inside same transaction
        await tx.auditLog.create({
          data: {
            actorId: auditCtx.actorId,
            action: 'UPDATE',
            entity: 'PayrollRun',
            entityId: result.id,
            afterJson: JSON.stringify(result),
            notes: `PayrollRun status changed: ${run.status} → ${status ?? 'unchanged'}${payDate !== undefined ? `; payDate → ${payDate || null}` : ''}${status === 'FINALIZED' && run.status === 'DRAFT' ? `；確認計糧: ${periodKey(run.periodMonth)}（凍結時間帳戶帳本 ${frozenCount} 人）` : ''}`,
            ipAddress: auditCtx.ip || null,
            userAgent: auditCtx.ua || null,
          },
        })

        return result
      }, { maxWait: 10_000, timeout: 120_000 })

      console.log('[payroll-run PUT]', { runId: params.id, status, durationMs: Date.now() - t0 })
      return NextResponse.json(updated)
    } catch (e: any) {
      // ★ 2026-08-17: 原本冇 catch，業務守衛的中文訊息變成空白 500
      console.error('[payroll-run PUT]', {
        runId: params.id,
        code: e?.code,
        message: e?.message,
        meta: e?.meta,
      })
      const isPrisma = typeof e?.code === 'string' && /^P\d{4}$/.test(e.code)
      return NextResponse.json(
        { error: isPrisma ? '系統錯誤，請重試' : (e?.message ?? '確認失敗'), code: e?.code ?? null },
        { status: isPrisma ? 500 : 400 },
      )
    }
  })
}

// DELETE /api/payroll-runs/[id] — Delete payroll run
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const run = await prisma.payrollRun.findUnique({ where: { id: params.id } })
      if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      if (run.status !== 'DRAFT') {
        return NextResponse.json({ error: 'Can only delete DRAFT payroll runs' }, { status: 400 })
      }

      // FIX #1: Use $transaction — delete + audit in same transaction
      await basePrisma.$transaction(async (tx) => {
        await tx.payrollRun.delete({ where: { id: params.id } })

        // Manual audit inside same transaction
        await tx.auditLog.create({
          data: {
            actorId: auditCtx.actorId,
            action: 'DELETE',
            entity: 'PayrollRun',
            entityId: params.id,
            notes: `PayrollRun deleted: ${params.id}`,
            ipAddress: auditCtx.ip || null,
            userAgent: auditCtx.ua || null,
          },
        })
      })

      return NextResponse.json({ success: true })
    } catch (e: any) {
      console.error('[payroll-run DELETE]', {
        runId: params.id,
        code: e?.code,
        message: e?.message,
        meta: e?.meta,
      })
      const isPrisma = typeof e?.code === 'string' && /^P\d{4}$/.test(e.code)
      return NextResponse.json(
        { error: isPrisma ? '系統錯誤，請重試' : (e?.message ?? '操作失敗'), code: e?.code ?? null },
        { status: isPrisma ? 500 : 400 },
      )
    }
  })
}
