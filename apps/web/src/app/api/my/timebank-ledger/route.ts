export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { buildTimeBankLedger, type LedgerMonth } from '@/lib/timebank-ledger'
import { getTimeAccountSummary } from '@/lib/timebank-summary'
import { toHKDateStr } from '@/lib/hk-date'
import { PAY_RULE_SELECT } from '@/lib/pay-rule-latest'

// ★ 呢條 route 只可以呼叫 lib/ 嘅共用函數，唔可以自己由原始表格砌計算（同管理端帳本同一 builder，坑②）。
//
// GET /api/my/timebank-ledger — ★ cwm-payrollcols-20260918 C：員工手機端逐月帳本
// ★★★ 只准睇自己 —— 一律由 session.userId 反查 employeeId，唔收任何 query param
//   （收咗 employeeId 就變成「改個 id 睇同事」）。
//
// 回傳：{ employeeId, notApplicable, reconciled, months（舊→新，固定 6 個月）,
//        chainBreaks, currentBalance, balanceMatchesLatestClosing }
// · reconciled = 每月加得埋（reconciles）＋ 月鏈接得返（chainBreaks 空）— 由 server 算好，前端唔好自己砌
// · currentBalance 同總覽頂部同一來源（getTimeAccountSummary）；balanceMatchesLatestClosing = C4 一致性旗
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  // ★★★ 只准睇自己
  const emp = await prisma.employee.findUnique({
    where: { userId: auth.session.userId },
    select: {
      id: true,
      // ★ 同管理端帳本同一口徑：pay rule 用 PAY_RULE_SELECT（唔 filter isActive 會攞停用舊規則）
      payRules: PAY_RULE_SELECT,
    },
  })
  if (!emp) return jsonNoStore({ error: '搵唔到員工記錄' }, { status: 404 })

  // pay rule config — 同總覽頂部 / getTimeAccountSummary 同一來源
  let cfg: any = {}
  try { cfg = JSON.parse(emp.payRules?.[0]?.configJson || '{}') } catch { /* 壞 JSON 當冇 config */ }
  const notApplicable = cfg?.base_type === 'hourly' // 時薪／兼職 → 不設時間帳戶

  // ★ 固定 6 個月（舊→新，含本月）— 純 HK 字串算術（同管理端 route 同一 idiom，check-dates 合規）
  const monthKeys: string[] = []
  {
    const [yy, mm] = toHKDateStr(new Date()).slice(0, 7).split('-').map(Number)
    for (let i = 5; i >= 0; i--) {
      const t = yy * 12 + (mm - 1) - i
      monthKeys.push(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`)
    }
  }

  const out: LedgerMonth[] = []
  for (const pmKey of monthKeys) {
    // ★ snapshot 優先 — finalize 凍結咗直接解 linesJson（同管理端 D2 口徑）
    const snap = await prisma.timeBankLedgerSnapshot.findUnique({
      where: { employeeId_periodMonth: { employeeId: emp.id, periodMonth: pmKey } },
    })
    if (snap) {
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
      out.push({ periodMonth: pmKey, opening: 0, closing: 0, lines: [], reconciles: true, frozen: false })
    } else {
      // 未確認計糧 → 即時算（共用 builder）
      out.push(await buildTimeBankLedger(prisma, emp.id, pmKey, cfg))
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

  // ★ C4：「帳本已對數」= 每月加得埋 ＋ 月鏈接得返（server 算好，前端唔好自己砌）
  const reconciled = out.every(m => m.reconciles) && chainBreaks.length === 0

  // currentBalance — 同總覽頂部同一來源；再對埋最新月期末（C4 一致性）
  const summaryRows = await getTimeAccountSummary(prisma, [{ id: emp.id, payRules: emp.payRules }])
  const row = summaryRows[0]
  const currentBalance: number | null = row?.status === 'ok' ? row.timeAccountMinutes : null
  const lastMonth = out[out.length - 1]
  const balanceMatchesLatestClosing = currentBalance !== null && lastMonth !== undefined
    && currentBalance === lastMonth.closing

  return jsonNoStore({
    employeeId: emp.id,
    notApplicable,
    reconciled,
    months: out,
    chainBreaks,
    currentBalance,
    balanceMatchesLatestClosing,
  })
}
