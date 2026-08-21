export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { resolveAccessibleCompanyIds, companyInScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'
import { hkDateStart, hkDateEnd, toHKDateStr } from '@/lib/hk-date'
import { resolveLeaveTable, isInProbation, serviceMonths } from '@/lib/leave-calculation'
import { countMonthlyLeaveDays } from '@/lib/payroll-engine'
import {
  serviceYearRange,
  overlapsRange,
  formatTakenDates,
  entitledForServiceYear,
} from '@/lib/leave-summary'

// ============================================================
// GET /api/scheduling-leave-summary — 排班頁月視圖底部假期總覽（2026-08-21）
//
// ?companyId=&periodMonth=YYYY-MM →
//   { periodMonth, rows: [{ employeeId, name, syStart, syEnd, entitled, usedDays,
//                           remainThisYear, balanceRemaining, inProbation,
//                           underOneYear, takenDates, restQuota,
//                           restBalanceRemaining, lastMonthRestRemaining }] }
//
// 一條 API 一次過回（MD §3.3 —— 唔好前端逐樣拼）：
//   ① 全部 ACTIVE 員工（homeClinic 屬該公司）+ joinDate + PayRule table
//   ② 各人服務年度區間內嘅 APPROVED ANNUAL_LEAVE（最闊範圍一次拉，逐人 filter）
//   ③ ANNUAL_LEAVE LeaveBalance（累積制 year=0 —— where 唔加 year filter）
//   ④ 該月 restQuota（countMonthlyLeaveDays(...).total，跟月份變）
//
// R/PL（本月 REST_DAY）唔喺度 —— 排班頁已有月視圖 leaveRequests，前端 aggregate。
//
// 權限：scheduling（RBAC 雙表登記）。
// 公司 scope：同 scheduling-memo precedent —— OWNER 全公司；其他角色只限自己被指派診所所屬公司。
// ============================================================

const PERIOD_MONTH_RE = /^\d{4}-\d{2}$/

/** 一位小數 —— usedDays / balanceRemaining 會係碎數（半日假等），唔好出長 float 尾數（應得喺 §6.1 後係整數） */
const r1 = (n: number) => Math.round(n * 10) / 10

function parseConfig(json: string | null | undefined): any {
  if (!json) return null
  try { return JSON.parse(json) } catch { return null }
}

export async function GET(req: NextRequest) {
  const auth = await requirePerm(req, 'scheduling')
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const sp = new URL(req.url).searchParams
  const companyId = sp.get('companyId')
  const periodMonth = sp.get('periodMonth') ?? ''

  // ★ 純顯示用途：參數缺失/格式錯 → 空 rows（唔好 400 攞走整頁，同 scheduling-memo GET 一致）
  if (!companyId || !PERIOD_MONTH_RE.test(periodMonth)) {
    return jsonNoStore({ periodMonth, rows: [] })
  }

  // ★ 公司 scope —— MANAGER 唔可以拉其他公司嘅員工假期資料
  const scope = await resolveAccessibleCompanyIds(session.userId, session.role)
  if (!companyInScope(scope, companyId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const now = new Date()

  const employees = await prisma.employee.findMany({
    where: { status: 'ACTIVE', homeClinic: { companyId } },
    select: {
      id: true,
      joinDate: true,
      user: { select: { name: true } },
      // ★ 一個員工可以有幾條 isActive PayRule（加薪歷史）——
      //   orderBy effectiveFrom desc + take 1 攞最新嗰條（2026-08-21 鐵律 8）
      payRules: {
        where: { isActive: true },
        orderBy: { effectiveFrom: 'desc' },
        take: 1,
        select: { configJson: true },
      },
    },
  })
  if (employees.length === 0) return jsonNoStore({ periodMonth, rows: [] })

  const empIds = employees.map(e => e.id)
  const ranges = employees.map(e => serviceYearRange(e.joinDate, now))

  // ★ 每個員工嘅服務年度區間唔同 → 一次過拉「最闊」範圍再逐人 filter
  //   （26 人逐個 query = 26 條；拉闊少少更快。MD §3.3）
  //   ★ 日期守則：range 查詢，禁 DateTime 精確相等（MD §3.3 正路寫法）
  const minStart = ranges.map(r => r.start).sort()[0]
  const maxEnd = ranges.map(r => r.end).sort()[ranges.length - 1]

  const annual = await prisma.leaveRequest.findMany({
    where: {
      employeeId: { in: empIds },
      status: 'APPROVED',
      leaveType: { systemKey: 'ANNUAL_LEAVE' },
      startDate: { lte: hkDateEnd(maxEnd) },
      endDate: { gte: hkDateStart(minStart) },
    },
    select: { employeeId: true, startDate: true, endDate: true, days: true },
  })

  // ★ 年假 LeaveBalance 累積制（year=0）—— where 唔好加 year filter（會攞唔到）
  const balances = await prisma.leaveBalance.findMany({
    where: { employeeId: { in: empIds }, leaveType: { systemKey: 'ANNUAL_LEAVE' } },
    select: { employeeId: true, remaining: true },
  })
  const balanceByEmp = new Map<string, number>()
  for (const b of balances) {
    balanceByEmp.set(b.employeeId, (balanceByEmp.get(b.employeeId) ?? 0) + b.remaining)
  }

  // ★ 2026-08-22 §6.2.3：REST_DAY 剩餘（「剩餘」欄 —— 拍板 (c) 即時值）
  //   REST_DAY 每曆年一行（每月發放／請假都扣當曆年 row —— leave-requests route deductYear）。
  //   ★ 唔加 year filter，按員工加總：上年未用完餘額仍係佢哋嘅休息日，加總先係真「當前剩餘」
  //   （同上面 ANNUAL_LEAVE 嘅 balanceByEmp 加總語義一致；年假 year=0 累積制每人一行，加總＝原值）。
  const restBalances = await prisma.leaveBalance.findMany({
    where: { employeeId: { in: empIds }, leaveType: { systemKey: 'REST_DAY' } },
    select: { employeeId: true, remaining: true },
  })
  const restByEmp = new Map<string, number>()
  for (const b of restBalances) {
    restByEmp.set(b.employeeId, (restByEmp.get(b.employeeId) ?? 0) + b.remaining)
  }

  // ★ 2026-08-22 §6.2.3：lastMonthRestRemaining —— 上月 LeaveBalanceSnapshot（REST_DAY）。
  //   上月 periodKey 要處理跨年（view "2026-01" → snapshot "2025-12"）。
  //   ★ 查唔到（上月未 finalize 過）= null → 前端顯「—」；
  //     絕唔好 fallback 當前值 —— 會令「上月剩」同「剩餘」一模一樣，用戶當真係本月冇用過假。
  const [spy, spm] = periodMonth.split('-').map(Number)
  const prevMonthKey = spm === 1 ? `${spy - 1}-12` : `${spy}-${String(spm - 1).padStart(2, '0')}`
  const prevSnapshots = await prisma.leaveBalanceSnapshot.findMany({
    where: { periodMonth: prevMonthKey, employeeId: { in: empIds }, leaveType: { systemKey: 'REST_DAY' } },
    select: { employeeId: true, remaining: true },
  })
  const lastMonthRestByEmp = new Map<string, number>()
  for (const s of prevSnapshots) lastMonthRestByEmp.set(s.employeeId, s.remaining)

  // ★ restQuota = countMonthlyLeaveDays(y, m, restDays, 公眾假期).total —— 唔好寫死 10
  //   （2026 年 4/9/12 月 PH 去重後係 8 或 9；restDays 由各自 PayRule 攞，預設週六日）
  const [py, pm] = periodMonth.split('-').map(Number)
  const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate()
  const phs = await prisma.hKPublicHoliday.findMany({
    where: {
      date: {
        gte: hkDateStart(`${periodMonth}-01`),
        lte: hkDateEnd(`${periodMonth}-${String(lastDay).padStart(2, '0')}`),
      },
    },
  })
  const phSet = new Set(phs.map(h => toHKDateStr(h.date)))

  const rows = employees.map((emp, i) => {
    const cfg = parseConfig(emp.payRules[0]?.configJson)
    // ★ resolveLeaveTable 內建「自訂 vs 法定取大」—— 唔好自己再比較一次
    const table = resolveLeaveTable(cfg?.modifiers?.annual_leave?.table ?? null)
    const sy = ranges[i]
    // ★ 2026-08-22 §6.1：本年度應得「全額」（annualLeaveEntitlement 表查詢，唔再 prorata）
    const entitled = entitledForServiceYear(sy.index, table)

    const taken = annual.filter(lr => lr.employeeId === emp.id && overlapsRange(lr, sy.start, sy.end))
    // ⚠️ 跨服務年度嘅假期：全部 days 落當前年度（罕見，第一版唔按日切分，已記低）
    const usedDays = taken.reduce((s, lr) => s + (lr.days ?? 0), 0)
    // ★ 拍板②A：本年度餘 —— 同 LeaveBalance.remaining（累積制，含上年結轉）係兩數
    const remainThisYear = Math.max(0, entitled - usedDays)

    // ★ rest_days 優先 modifiers（RuleComposer 現行寫法），fallback 頂層（舊資料 / grant-restdays 讀法）
    const restDays: number[] = cfg?.modifiers?.working_days?.rest_days ?? cfg?.working_days?.rest_days ?? [6, 0]
    const restQuota = countMonthlyLeaveDays(py, pm - 1, restDays, phSet).total

    return {
      employeeId: emp.id,
      name: emp.user?.name ?? '?',
      syStart: sy.start,
      syEnd: sy.end,
      entitled: r1(entitled),
      usedDays: r1(usedDays),
      remainThisYear: r1(remainThisYear),
      balanceRemaining: r1(balanceByEmp.get(emp.id) ?? 0),
      inProbation: isInProbation(emp.joinDate, now),
      underOneYear: serviceMonths(emp.joinDate, now) < 12,
      takenDates: formatTakenDates(taken),
      restQuota,
      // ★ 2026-08-22 §6.2.4（拍板 (c)）：「剩餘」= 當前 LeaveBalance.remaining（REST_DAY 即時值，
      //   唔係「上月剩 − R − PL」推導 —— 後者未計本月發放）
      restBalanceRemaining: r1(restByEmp.get(emp.id) ?? 0),
      // ★ 上月快照；查唔到 = null（前端顯「—」，零 fallback）
      lastMonthRestRemaining: lastMonthRestByEmp.has(emp.id) ? r1(lastMonthRestByEmp.get(emp.id)!) : null,
    }
  })

  return jsonNoStore({ periodMonth, rows })
}
