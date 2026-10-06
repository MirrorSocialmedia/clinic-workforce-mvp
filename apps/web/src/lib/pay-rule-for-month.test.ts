/**
 * ★ cwm-tbmonthrule-20261006：findPayRulesForMonth（批量）必須同 findPayRuleForMonth（逐人）揀到同一條規則；
 *   rosterDiffApplies：兼職月份唔計編更差額（9 月兼職、10 月轉全職 —— 舊版用最新規則，扣咗 9 月成個月應返）。
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { findPayRuleForMonth, findPayRulesForMonth, isHourlyRule, rosterDiffApplies } from './pay-rule-for-month'

type Rule = { id: string; employeeId: string; payType: string; configJson: string; effectiveFrom: Date; effectiveTo: Date | null; isActive: boolean; createdAt: Date }
const HOURLY = JSON.stringify({ base_type: 'hourly' })
const MONTHLY = JSON.stringify({ base_type: 'monthly' })
const d = (s: string) => new Date(`${s}T00:00:00+08:00`)

const RULES: Rule[] = [
  // A：9 月或之前兼職（POST 換規則 → 舊規則停用＋effectiveTo），10 月起全職
  { id: 'a1', employeeId: 'A', payType: 'HOURLY', configJson: HOURLY, effectiveFrom: d('2026-07-01'), effectiveTo: new Date('2026-09-30T15:59:59Z'), isActive: false, createdAt: d('2026-07-01') },
  { id: 'a2', employeeId: 'A', payType: 'MONTHLY', configJson: MONTHLY, effectiveFrom: d('2026-10-01'), effectiveTo: null, isActive: true, createdAt: d('2026-09-28') },
  // B：一直月薪
  { id: 'b1', employeeId: 'B', payType: 'MONTHLY', configJson: MONTHLY, effectiveFrom: d('2026-01-01'), effectiveTo: null, isActive: true, createdAt: d('2026-01-01') },
  // C：從未生效嘅舊規則（effectiveTo < effectiveFrom）＋ 冇規則覆蓋 8 月
  { id: 'c1', employeeId: 'C', payType: 'HOURLY', configJson: HOURLY, effectiveFrom: d('2026-08-10'), effectiveTo: d('2026-08-01'), isActive: false, createdAt: d('2026-08-01') },
  { id: 'c2', employeeId: 'C', payType: 'MONTHLY', configJson: MONTHLY, effectiveFrom: d('2026-09-01'), effectiveTo: null, isActive: true, createdAt: d('2026-08-01') },
]

// 只實作 pay-rule-for-month 用到嘅 where 形狀
function match(r: Rule, w: any): boolean {
  if (w.employeeId !== undefined) {
    if (typeof w.employeeId === 'string' ? r.employeeId !== w.employeeId : !w.employeeId.in.includes(r.employeeId)) return false
  }
  if (w.isActive !== undefined && r.isActive !== w.isActive) return false
  if (w.effectiveFrom?.lte && !(r.effectiveFrom <= w.effectiveFrom.lte)) return false
  if (w.effectiveTo) {
    if (r.effectiveTo === null) return false
    if (w.effectiveTo.gte && !(r.effectiveTo >= w.effectiveTo.gte)) return false
  }
  if (w.OR && !w.OR.some((o: any) => (o.effectiveTo === null ? r.effectiveTo === null : r.effectiveTo !== null && r.effectiveTo >= o.effectiveTo.gte))) return false
  return true
}
const sorted = (rs: Rule[]) => [...rs].sort((a, b) => +b.effectiveFrom - +a.effectiveFrom || +b.createdAt - +a.createdAt)
const db = {
  payRule: {
    findFirst: async ({ where }: any) => sorted(RULES.filter(r => match(r, where)))[0] ?? null,
    findMany: async ({ where, take }: any) => sorted(RULES.filter(r => match(r, where))).slice(0, take ?? Infinity),
  },
}
const month = (pm: string) => {
  const [y, m] = pm.split('-').map(Number)
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  return { start: d(`${pm}-01`), end: new Date(+d(`${next}-01`) - 1) }
}

test('批量揀法 = 逐人揀法（每個員工 × 每個月）', async () => {
  for (const pm of ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11']) {
    const { start, end } = month(pm)
    const batch = await findPayRulesForMonth(db, ['A', 'B', 'C'], start, end)
    for (const emp of ['A', 'B', 'C']) {
      const one = await findPayRuleForMonth(db, emp, start, end)
      assert.strictEqual(batch.get(emp)?.id ?? null, one?.id ?? null, `${emp} ${pm}`)
    }
  }
})

test('兼職轉全職：9 月用兼職規則（唔計編更差額），10 月用全職規則', async () => {
  const sep = month('2026-09')
  const oct = month('2026-10')
  const rSep = (await findPayRulesForMonth(db, ['A'], sep.start, sep.end)).get('A')
  const rOct = (await findPayRulesForMonth(db, ['A'], oct.start, oct.end)).get('A')
  assert.strictEqual(rSep?.id, 'a1')
  assert.strictEqual(rOct?.id, 'a2')
  assert.strictEqual(rosterDiffApplies(rSep, false), false)
  assert.strictEqual(rosterDiffApplies(rOct, false), true)
})

test('rosterDiffApplies／isHourlyRule', () => {
  assert.strictEqual(rosterDiffApplies({ payType: 'MONTHLY', configJson: MONTHLY }, true), false) // 免考勤
  assert.strictEqual(rosterDiffApplies({ payType: 'MONTHLY', configJson: HOURLY }, false), false) // 設定係時薪
  assert.strictEqual(rosterDiffApplies({ payType: 'SPLIT', configJson: '{}' }, false), false)
  assert.strictEqual(rosterDiffApplies(null, false), false)
  assert.strictEqual(isHourlyRule({ configJson: '壞 JSON' }), false)
  assert.strictEqual(isHourlyRule({ configJson: HOURLY }), true)
})

test('從未生效嘅舊規則唔揀；冇規則覆蓋嗰個月 → 冇', async () => {
  const aug = month('2026-08')
  assert.strictEqual((await findPayRulesForMonth(db, ['C'], aug.start, aug.end)).has('C'), false)
  assert.strictEqual((await findPayRulesForMonth(db, [], aug.start, aug.end)).size, 0)
})
