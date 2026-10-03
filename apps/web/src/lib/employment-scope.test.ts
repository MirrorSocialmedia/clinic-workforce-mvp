/**
 * ★ cwm-resignsweep-20261003：已離職員工範圍判斷
 * 跑法: TZ=UTC npx tsx --test src/lib/employment-scope.test.ts
 *
 * 語義：leaveDate = 最後工作日（HK 00:00）；resignedAt = 最後工作日 + 1（HK 00:00，exclusive）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { employedFromWhere, resignedFromDateStr, resignedDateError } from './employment-scope'

const hk = (d: string) => new Date(`${d}T00:00:00+08:00`)
// 9/9 最後工作日 → resignedAt = 9/10 HK 00:00
const RESIGNED = { status: 'RESIGNED', resignedAt: hk('2026-09-10'), leaveDate: hk('2026-09-09') }
const TODAY = '2026-10-03'

describe('resignedFromDateStr', () => {
  it('未離職 → null', () => {
    assert.equal(resignedFromDateStr({ status: 'ACTIVE', resignedAt: null, leaveDate: null }, TODAY), null)
    assert.equal(resignedFromDateStr({ status: 'PROBATION', resignedAt: null, leaveDate: null }, TODAY), null)
  })
  it('有 resignedAt → 生效日（最後工作日 + 1）', () => {
    assert.equal(resignedFromDateStr(RESIGNED, TODAY), '2026-09-10')
  })
  it('舊數據冇 resignedAt → leaveDate + 1', () => {
    assert.equal(resignedFromDateStr({ status: 'RESIGNED', resignedAt: null, leaveDate: hk('2026-08-31') }, TODAY), '2026-09-01')
  })
  it('兩樣都冇 → 聽日起擋', () => {
    assert.equal(resignedFromDateStr({ status: 'RESIGNED', resignedAt: null, leaveDate: null }, TODAY), '2026-10-04')
  })
})

describe('resignedDateError', () => {
  it('最後工作日當日 → 准（修正舊更）', () => {
    assert.equal(resignedDateError(RESIGNED, ['2026-09-09'], TODAY), null)
  })
  it('生效日或之後 → 擋，訊息講最早嗰日', () => {
    const e = resignedDateError(RESIGNED, ['2026-09-12', '2026-09-08', '2026-09-10'], TODAY)
    assert.ok(e)
    assert.match(e!, /2026-09-10 起唔再受僱/)
    assert.match(e!, /喺 2026-09-10 排更/)
  })
  it('未離職 → 乜都准', () => {
    assert.equal(resignedDateError({ status: 'ACTIVE', resignedAt: null, leaveDate: null }, ['2099-01-01'], TODAY), null)
  })
})

describe('employedFromWhere', () => {
  it('未離職、resignedAt > from、或舊數據 leaveDate >= from 都算仲受僱', () => {
    const from = hk('2026-09-01')
    const w = employedFromWhere(from) as any
    assert.deepEqual(w.OR, [
      { status: { not: 'RESIGNED' } },
      { resignedAt: { gt: from } },
      { resignedAt: null, leaveDate: { gte: from } },
    ])
  })
})
