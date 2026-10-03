/**
 * ★ cwm-probation-20261003：試用期提醒
 * 跑法: TZ=UTC npx tsx --test src/lib/probation.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { probationPassDateStr, probationLastDayStr, probationDueList, probationDueLabel } from './probation'
import { isInProbation } from './leave-calculation'

const hk = (d: string) => new Date(`${d}T00:00:00+08:00`)

describe('probation dates', () => {
  it('7/15 入職 → 10/15 滿、10/14 最後一日；同 isInProbation 一致', () => {
    assert.equal(probationPassDateStr(hk('2026-07-15')), '2026-10-15')
    assert.equal(probationLastDayStr(hk('2026-07-15')), '2026-10-14')
    assert.equal(isInProbation(hk('2026-07-15'), hk('2026-10-14')), true)
    assert.equal(isInProbation(hk('2026-07-15'), hk('2026-10-15')), false)
  })
  it('月尾入職遇短月：11/30 → 2/28 滿；跨年', () => {
    assert.equal(probationPassDateStr(hk('2026-11-30')), '2027-02-28')
    assert.equal(isInProbation(hk('2026-11-30'), hk('2027-02-28')), false)
    assert.equal(probationPassDateStr(hk('2026-10-01')), '2027-01-01')
  })
})

describe('probationDueList', () => {
  const emps = [
    { id: 'a', joinDate: hk('2026-07-15'), user: { name: '甲' } }, // 10/14 最後一日 → 仲有 11 日
    { id: 'b', joinDate: hk('2026-06-25'), user: { name: '乙' } }, // 9/24 → 已滿 9 日
    { id: 'c', joinDate: hk('2026-06-01'), user: { name: '丙' } }, // 8/31 → 已滿 33 日（唔顯示）
    { id: 'd', joinDate: hk('2026-09-20'), user: { name: '丁' } }, // 12/19 → 仲有 77 日（唔顯示）
    { id: 'e', joinDate: hk('2026-07-15'), status: 'RESIGNED', user: { name: '戊' } },
    { id: 'f', joinDate: null, user: { name: '己' } },
  ]
  it('只列最後一日喺 [今日−14, 今日+30]；已離職／冇入職日唔列；急嘅先', () => {
    const r = probationDueList(emps, '2026-10-03')
    assert.deepEqual(r.map(x => [x.id, x.daysLeft]), [['b', -9], ['a', 11]])
    assert.equal(probationDueLabel(r[0]), '已滿 9 日（9/24 最後一日）')
    assert.equal(probationDueLabel(r[1]), '仲有 11 日（10/14 最後一日）')
    assert.equal(probationDueLabel({ ...r[1], daysLeft: 0 }), '今日（10/14）係最後一日')
  })
})
