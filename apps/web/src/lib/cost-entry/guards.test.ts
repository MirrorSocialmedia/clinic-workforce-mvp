import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMoney, parseDay, checkCostDates, parseDiscountPct, assertClinicAllowed, CostGuardError } from './guards'

const err = (fn: () => unknown, status = 400) => assert.throws(fn, (e: any) => e instanceof CostGuardError && e.status === status)

test('parseMoney：空 → null；數字／字串 → 2 位小數；負數、亂碼、太大 → 400', () => {
  assert.equal(parseMoney(null), null)
  assert.equal(parseMoney(undefined), null)
  assert.equal(parseMoney(''), null)
  assert.equal(parseMoney('  '), null)
  assert.equal(parseMoney(0), 0)
  assert.equal(parseMoney('1,234.567'), 1234.57)
  assert.equal(parseMoney(280), 280)
  err(() => parseMoney(-300))
  err(() => parseMoney('abc'))
  err(() => parseMoney(NaN))
  err(() => parseMoney(Infinity))
  err(() => parseMoney(1e8))
})

test('parseDay：HK 日期字串；壞日期 → 400', () => {
  assert.equal(parseDay('2026-09-28', '到貨'), '2026-09-28')
  assert.equal(parseDay(new Date('2026-09-27T16:30:00Z'), '到貨'), '2026-09-28') // UTC 夜晚 = HK 第二日
  assert.equal(parseDay(null, '到貨'), null)
  assert.equal(parseDay('', '到貨'), null)
  err(() => parseDay('2026-13-45', '到貨'))
  err(() => parseDay('abc', '到貨'))
})

test('checkCostDates：預填預計到貨日照收（6 個月內）；打錯年份、到貨早過落單、將來落單 → 400', () => {
  checkCostDates('2026-08-30', '2026-09-02', '2026-10-06')
  checkCostDates('2026-10-06', '2026-10-06', '2026-10-06')
  checkCostDates('2026-09-01', null, '2026-10-06')
  checkCostDates('2026-10-01', '2026-10-20', '2026-10-06') // 預計到貨日
  checkCostDates('2026-10-01', '2027-04-06', '2026-10-06') // 6 個月內
  err(() => checkCostDates('2026-10-01', '2027-10-02', '2026-10-06')) // 打錯年份
  err(() => checkCostDates('2026-10-07', null, '2026-10-06'))
  err(() => checkCostDates('2026-10-01', '2025-10-02', '2026-10-06'))
})

test('parseDiscountPct：0–100', () => {
  assert.equal(parseDiscountPct(8.5), 8.5)
  assert.equal(parseDiscountPct('0'), 0)
  assert.equal(parseDiscountPct(100), 100)
  err(() => parseDiscountPct(150))
  err(() => parseDiscountPct(-1))
  err(() => parseDiscountPct('x'))
})

test('assertClinicAllowed：MANAGER 限所屬診所；OWNER 唔限', () => {
  assertClinicAllowed({ role: 'OWNER', clinics: [] }, 'A')
  assertClinicAllowed({ role: 'MANAGER', clinics: ['A', 'B'] }, 'A', 'B')
  err(() => assertClinicAllowed({ role: 'MANAGER', clinics: ['A'] }, 'A', 'C'), 403)
  err(() => assertClinicAllowed({ role: 'MANAGER', clinics: null }, 'A'), 403)
})
