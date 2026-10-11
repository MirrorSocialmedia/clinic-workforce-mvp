/**
 * ★ cwm-doctorflag-20261011：付款方式規則「計醫生收入」→ 同步時快照落每筆 PaymentAllocation.countForDoctor
 *   跑法: TZ=UTC npx tsx --test src/lib/apricot/allocate-doctorflag.test.ts
 *   純函數（allocatePayment／resolveMethodRule 唔掂 DB）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allocatePayment, resolveMethodRule } from './allocate'

const rule = (method: string, countAsIncome: boolean, countForDoctor: boolean, from = '2025-12-31'): any => ({
  id: `r-${method}-${from}`, method, label: method, feePercent: 0, countAsIncome, countForDoctor,
  effectiveFrom: new Date(`${from}T00:00:00+08:00`), effectiveTo: null, createdBy: 't',
})
const RULES = [
  rule('CASH', true, true),
  rule('FREE_SP', false, true),
  rule('CREDIT', false, false),
  rule('OCTOPUS', true, false),
]
const bills = new Map([['b1', { providerExtId: 'P1', items: [] }]])
const pay = (method: string) => allocatePayment(
  { id: `pay-${method}`, paymentTime: '2026-10-08T10:00:00+08:00', amt: 100 },
  [{ methodRaw: method, methodNorm: method, amount: 100, payType: '' }],
  [{ billExtId: 'b1', billCode: 'B1', amount: 100 }],
  bills, 'C1', [{ billExtId: 'b1' }], RULES,
)

test('規則兩個旗分別快照落 allocation（四種組合）', async () => {
  const flags = async (m: string) => { const [a] = await pay(m); return [a.countAsIncome, a.countForDoctor] }
  assert.deepEqual(await flags('CASH'), [true, true])
  assert.deepEqual(await flags('FREE_SP'), [false, true])
  assert.deepEqual(await flags('CREDIT'), [false, false])
  assert.deepEqual(await flags('OCTOPUS'), [true, false])
})

test('冇規則 → needsReview（擋月結）＋兜底同舊口徑（計店舖＋計醫生）', async () => {
  const [a] = await pay('WECHAT')
  assert.equal(a.needsReview, true)
  assert.deepEqual([a.countAsIncome, a.countForDoctor], [true, true])
})

test('跟付款日生效嘅規則（改設定開新一條規則 → 之後嘅付款先用新旗）', () => {
  const rules = [rule('FREE_SP', false, true, '2025-12-31'), rule('FREE_SP', false, false, '2026-11-01')]
  assert.equal(resolveMethodRule('FREE_SP', new Date('2026-10-30T12:00:00+08:00'), rules).countForDoctor, true)
  assert.equal(resolveMethodRule('FREE_SP', new Date('2026-11-01T12:00:00+08:00'), rules).countForDoctor, false)
})
