// ★ cwm-empoverview-20261014：ADW 來源 —— 只用已確認計糧（草稿唔計）；員工總覽「工資歷史」同 ADW 一致
//   跑法: TZ=UTC npx tsx --test src/lib/adw-sources.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateADW, mergeWageHistory } from './adw'

test('工資歷史合併：已確認計糧 ＞ 歷史工資 ＞ 草稿；範圍外唔出；新到舊', () => {
  const rows = mergeWageHistory(
    [
      { periodMonth: '2026-07', totalWage: 17500, excludedDays: 0, excludedWage: 0, calendarDays: 31 },
      { periodMonth: '2026-08', totalWage: 99999, excludedDays: 0, excludedWage: 0, calendarDays: 31 },
      { periodMonth: '2026-10', totalWage: 11111, excludedDays: 0, excludedWage: 0, calendarDays: 31 },
      { periodMonth: '2025-01', totalWage: 1, excludedDays: 0, excludedWage: 0, calendarDays: 31 },
    ],
    [
      { periodMonth: '2026-08', status: 'FINALIZED', wage: 17820.004, excludedDays: 11, excludedWage: 6410 },
      { periodMonth: '2026-09', status: 'EXPORTED', wage: 18240, excludedDays: 9, excludedWage: 5250 },
      { periodMonth: '2026-10', status: 'DRAFT', wage: 18060, excludedDays: 10, excludedWage: 5830 },
      { periodMonth: '2026-11', status: 'DRAFT', wage: 1, excludedDays: 0, excludedWage: 0 },
    ],
    '2025-11', '2026-10',
  )
  assert.deepEqual(rows.map(r => [r.periodMonth, r.source, r.totalWage]), [
    ['2026-10', 'HISTORY', 11111], // 有歷史工資就唔用草稿
    ['2026-09', 'PAYROLL', 18240],
    ['2026-08', 'PAYROLL', 17820], // 已確認計糧蓋過歷史工資
    ['2026-07', 'HISTORY', 17500],
  ])
  const draftOnly = mergeWageHistory([], [{ periodMonth: '2026-10', status: 'DRAFT', wage: 5, excludedDays: 0, excludedWage: 0 }], '2026-01', '2026-12')
  assert.equal(draftOnly[0].source, 'DRAFT')
  assert.equal(draftOnly[0].calendarDays, 31)
})

test('calculateADW：計糧草稿唔計入（query 帶 status 篩選），已確認先計', async () => {
  const items = [
    { run: { periodMonth: new Date('2026-08-01T00:00:00+08:00'), status: 'FINALIZED' }, eoWage: 31000, excludedDays: 0, excludedWage: 0 },
    { run: { periodMonth: new Date('2026-09-01T00:00:00+08:00'), status: 'DRAFT' }, eoWage: 999999, excludedDays: 0, excludedWage: 0 },
  ]
  let seenWhere: any = null
  const db: any = {
    employee: { findUnique: async () => ({ joinDate: new Date('2026-08-01T00:00:00+08:00') }) },
    payrollItem: {
      findMany: async ({ where }: any) => {
        seenWhere = where
        const allowed: string[] | undefined = where.run?.status?.in
        return items.filter(i => !allowed || allowed.includes(i.run.status))
      },
    },
    wageHistory: { findMany: async () => [] },
  }
  const r = await calculateADW(db, 'e1', new Date('2026-10-01T12:00:00+08:00'))
  assert.deepEqual(seenWhere.run.status, { in: ['FINALIZED', 'EXPORTED'] })
  assert.deepEqual(r.sources.map(s => s.periodMonth), ['2026-08'])
  assert.equal(r.adw, 1000) // 31000 ÷ 31 日；9 月草稿 999999 冇計入
})
