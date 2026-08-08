import { calculateTimeBank } from './payroll-engine'
import { toHKDateStr } from './hk-date'

export type TimeAccountRow = {
  employeeId: string
  employeeName: string
  timeAccountMinutes: number | null   // null = 時薪／兼職，不設時間帳戶
  status: 'ok' | 'not_applicable' | 'error'  // ★ 三態：正常 / 時薪不適用 / 計算失敗
}

/**
 * 時間帳戶累計餘額 —— 全系統唯一入口。
 *
 * ★ 唔好再喺任何地方自己 sum TimeBankEntry —— 嗰張表只有手動調整
 *   （INIT_ADJUST / MAKEUP / CONVERT / RESTDAY_GRANT），
 *   由打卡算出嚟嘅遲到／早退／OT 完全唔喺入面。
 *   儀表板舊版就係咁做，令所有冇做過手動調整嘅員工永遠顯示 0。
 *
 * ★ 一定要傳每個員工自己嘅 pay rule config —— 傳空 {} 會令 OT 門檻／
 *   午休設定失效，同計糧單算出兩套數字。
 */
export async function getTimeAccountSummary(
  db: any,
  employees: Array<{
    id: string
    user?: { name?: string | null } | null
    payRules?: Array<{ configJson: string | null }> | null
  }>,
  monthDate?: Date,
): Promise<TimeAccountRow[]> {
  const md = monthDate
    ?? new Date(`${toHKDateStr(new Date()).slice(0, 7)}-01T00:00:00+08:00`)

  // ★ 2026-08-09: Batch concurrency-8 instead of serial
  const CONCURRENCY = 8
  type Task = { e: typeof employees[0]; cfg: any; i: number }
  const tasks: Task[] = []
  const rows: TimeAccountRow[] = new Array(employees.length)

  employees.forEach((e, i) => {
    let cfg: any = {}
    try { cfg = JSON.parse(e.payRules?.[0]?.configJson || '{}') } catch { /* 壞 JSON 當冇 config */ }

    if (cfg?.base_type === 'hourly') {
      rows[i] = { employeeId: e.id, employeeName: e.user?.name ?? '—', timeAccountMinutes: null, status: 'not_applicable' }
    } else {
      tasks.push({ e, cfg, i })
    }
  })

  for (let k = 0; k < tasks.length; k += CONCURRENCY) {
    const batch = tasks.slice(k, k + CONCURRENCY)
    await Promise.all(batch.map(async (t) => {
      try {
        const tb = await calculateTimeBank(t.e.id, md, t.cfg, db)
        rows[t.i] = {
          employeeId: t.e.id,
          employeeName: t.e.user?.name ?? '—',
          timeAccountMinutes: tb.timeAccountMinutes ?? null,
          status: 'ok',
        }
      } catch (err) {
        console.error(`[timebank-summary] employee ${t.e.id} failed`, err)
        rows[t.i] = {
          employeeId: t.e.id,
          employeeName: t.e.user?.name ?? '—',
          timeAccountMinutes: null,
          status: 'error',
        }
      }
    }))
  }

  return rows
}
