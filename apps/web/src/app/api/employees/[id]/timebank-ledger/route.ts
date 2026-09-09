export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope, canSeeConfidential } from '@/lib/scope-helpers'
import { buildTimeBankLedger, type LedgerMonth } from '@/lib/timebank-ledger'
import { getTimeAccountSummary } from '@/lib/timebank-summary'
import { toHKDateStr } from '@/lib/hk-date'
import { PAY_RULE_SELECT } from '@/lib/pay-rule-latest'

// ★ 呢條 route 只可以呼叫 lib/ 嘅共用函數，唔可以自己由原始表格砌計算。
//
// GET /api/employees/:id/timebank-ledger?months=6 — 時間帳戶帳本（凍結式）
// 回傳：{ employeeId, notApplicable, months（舊→新）, chainBreaks, currentBalance, balanceMatchesLatestClosing, audit }
//
// D2 口徑：
// · 每月 snapshot 優先 —— 有 TimeBankLedgerSnapshot（finalize 凍結）直接解 linesJson（frozen:true），
//   冇就先前 buildTimeBankLedger 即時算（frozen:false）。
// · 月鏈對數：上月期末 必須 = 本月期初，唔夾 → chainBreaks 精確回報斷點。
// · currentBalance 同總覽頂部同一來源（getTimeAccountSummary），再對埋最新月期末（唔等 = mismatch flag）。
// · audit = AuditLog 嘅 TIMEBANK_* 操作記錄（append-only，有 actor / before / after）。
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  // months clamp 1–24（防 NaN / 0 / 負數）
  const rawMonths = parseInt(new URL(req.url).searchParams.get('months') || '6', 10)
  const months = Math.min(Number.isFinite(rawMonths) && rawMonths >= 1 ? rawMonths : 6, 24)

  const emp = await prisma.employee.findUnique({
    where: { id: params.id },
    select: {
      payConfidential: true,
      homeClinicId: true,
      // ★ 覆核 P0-2：必須同 overview/route.ts 一模一樣 —— 唔 filter isActive 會攞到停用嘅舊規則，
      //   令帳本同總覽頂部出兩個唔同嘅數。口徑已抽常數統一（lib/pay-rule-latest，P1-2）。
      payRules: PAY_RULE_SELECT,
    },
  })

  if (!emp) return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

  // ★ Scope check: EMPLOYEE with employee_overview can only see same home-clinic employees
  // forPerms: 員工總覽帳本 → homeOnly（只限主屬診所）— 照抄 overview/history
  const allowed = await resolveClinicScope(session, auth.perms ?? [], {
    homeOnly: ['employee_overview'],
  })
  if (allowed !== null && emp.homeClinicId && !allowed.includes(emp.homeClinicId)) {
    return NextResponse.json({ error: '只可以查看主屬診所嘅員工' }, { status: 403 })
  }

  // ★ Confidential check via unified helper (2026-08-03)
  if (!(await canSeeConfidential(session, auth.perms ?? [], emp))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // pay rule config — 同總覽頂部 / getTimeAccountSummary 同一來源
  let cfg: any = {}
  try { cfg = JSON.parse(emp.payRules?.[0]?.configJson || '{}') } catch { /* 壞 JSON 當冇 config */ }
  const notApplicable = cfg?.base_type === 'hourly' // 時薪／兼職 → 不設時間帳戶

  // ★ 月鍵由舊到新（含本月）—— 自己接鏈，唔靠 TimeBank 快取；
  //   純 HK 字串算術（避月份方法嘅時區歧義，check-dates.sh）
  const now = new Date()
  const [yy, mm] = toHKDateStr(now).slice(0, 7).split('-').map(Number)
  const monthKeys: string[] = []
  for (let i = months - 1; i >= 0; i--) {
    const t = yy * 12 + (mm - 1) - i
    monthKeys.push(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`)
  }

  const out: LedgerMonth[] = []
  for (const pmKey of monthKeys) {
    const snap = await prisma.timeBankLedgerSnapshot.findUnique({
      where: { employeeId_periodMonth: { employeeId: params.id, periodMonth: pmKey } },
    })
    if (snap) {
      // ★ snapshot 優先 —— finalize 凍結咗，直接解 linesJson
      let lines: any[] = []
      try { lines = JSON.parse(snap.linesJson) } catch { lines = [] }
      const sum = lines.reduce((s: number, l: any) => s + (Number(l.minutes) || 0), 0)
      out.push({
        periodMonth: pmKey,
        opening: snap.opening,
        closing: snap.closing,
        lines,
        // 凍結後都要重算對數 —— snapshot 加唔埋就標紅（唔好盲信）
        reconciles: snap.opening + sum === snap.closing,
        frozen: true,
        frozenAt: snap.frozenAt.toISOString(),
        engineVersion: snap.engineVersion,
      })
    } else if (notApplicable) {
      // 時薪：無時間帳戶（同總覽頂部口徑），回空月
      out.push({ periodMonth: pmKey, opening: 0, closing: 0, lines: [], reconciles: true, frozen: false })
    } else {
      // 未確認計糧 → 即時算
      out.push(await buildTimeBankLedger(prisma, params.id, pmKey, cfg))
    }
  }

  // ★ 月與月接得返？上月期末 必須 = 本月期初
  const chainBreaks: Array<{ from: string; to: string; prevClosing: number; thisOpening: number }> = []
  for (let i = 1; i < out.length; i++) {
    if (out[i].opening !== out[i - 1].closing) {
      chainBreaks.push({
        from: out[i - 1].periodMonth,
        to: out[i].periodMonth,
        prevClosing: out[i - 1].closing,
        thisOpening: out[i].opening,
      })
    }
  }

  // currentBalance — 同總覽頂部同一來源；再對埋最新月期末
  const summaryRows = await getTimeAccountSummary(prisma, [{ id: params.id, payRules: emp.payRules }])
  const row = summaryRows[0]
  const currentBalance: number | null = row?.status === 'ok' ? row.timeAccountMinutes : null
  const lastMonth = out[out.length - 1]
  const balanceMatchesLatestClosing = currentBalance !== null && lastMonth !== undefined
    && currentBalance === lastMonth.closing

  // D3 操作記錄 — AuditLog append-only（TIMEBANK_*，actor + before/after）
  const rangeStart = new Date(`${monthKeys[0]}-01T00:00:00+08:00`)
  const auditRows = await prisma.auditLog.findMany({
    where: {
      targetEmployeeId: params.id,
      action: { startsWith: 'TIMEBANK_' },
      createdAt: { gte: rangeStart },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { actor: { select: { name: true } } },
  })
  const audit = auditRows.map(r => ({
    id: r.id,
    actorId: r.actorId,
    actorName: r.actor?.name ?? null,
    action: r.action,
    entity: r.entity,
    entityId: r.entityId,
    beforeJson: r.beforeJson,
    afterJson: r.afterJson,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
  }))

  return NextResponse.json({
    employeeId: params.id,
    notApplicable,
    months: out,
    chainBreaks,
    currentBalance,
    balanceMatchesLatestClosing,
    audit,
  })
}
