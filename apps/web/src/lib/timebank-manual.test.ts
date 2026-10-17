// ★ cwm-tbmanual-20261017 ①：時間帳戶手動調整 —— 純函數驗證測試（MD §1.7）
// 跑法: TZ=UTC npx tsx --test src/lib/timebank-manual.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateManualAdjust, validateManualReverse,
  MANUAL_CONFIRM_THRESHOLD_MIN, MANUAL_MONTH_RE, fmtManualMinutes,
} from './timebank-manual'

const ok = (b: any) => {
  const v = validateManualAdjust(b)
  assert.ok(v.ok, `expect ok, got ${JSON.stringify(v)}`)
  return v
}
const err = (b: any, status: number, code: string) => {
  const v = validateManualAdjust(b)
  assert.equal(v.ok, false, `expect error, got ${JSON.stringify(v)}`)
  assert.equal((v as any).status, status, JSON.stringify(v))
  assert.equal((v as any).code, code, JSON.stringify(v))
}

const base = { employeeId: 'emp1', minutes: 150, effectiveMonth: '2026-10', reason: '測試' }

describe('validateManualAdjust — minutes', () => {
  it('正常整數（正／負／小於 480）', () => {
    assert.equal(ok(base).value.minutes, 150)
    assert.equal(ok({ ...base, minutes: -30 }).value.minutes, -30)
    assert.equal(ok({ ...base, minutes: 480 }).value.minutes, 480) // 480 唔使確認
  })
  it('0 → 400 BAD_INPUT', () => err({ ...base, minutes: 0 }, 400, 'BAD_INPUT'))
  it('小數 1.5 → 400', () => err({ ...base, minutes: 1.5 }, 400, 'BAD_INPUT'))
  it('數字字串 "150" 接受', () => assert.equal(ok({ ...base, minutes: '150' }).value.minutes, 150))
  it('數字字串 "-30" 接受', () => assert.equal(ok({ ...base, minutes: '-30' }).value.minutes, -30))
  it('非數字字串 "abc" → 400', () => err({ ...base, minutes: 'abc' }, 400, 'BAD_INPUT'))
  it('[5] 陣列 → 400（PR #81 教訓）', () => err({ ...base, minutes: [5] }, 400, 'BAD_INPUT'))
  it('{valueOf} object → 400（PR #81 教訓）', () => err({ ...base, minutes: { valueOf: () => 5 } }, 400, 'BAD_INPUT'))
  it('null / undefined / boolean → 400', () => {
    err({ ...base, minutes: null }, 400, 'BAD_INPUT')
    err({ ...base, minutes: undefined }, 400, 'BAD_INPUT')
    err({ ...base, minutes: true }, 400, 'BAD_INPUT')
  })
  it('超過 1,000,000 → 400', () => err({ ...base, minutes: 1_000_001, confirmLarge: true }, 400, 'BAD_INPUT'))
  it('整 1,000,000 → 接受（confirmLarge）', () => assert.equal(ok({ ...base, minutes: 1_000_000, confirmLarge: true }).value.minutes, 1_000_000))
})

describe('validateManualAdjust — 480 確認界線', () => {
  it('480（= 8 小時）唔使 confirm', () => assert.equal(ok({ ...base, minutes: 480 }).value.confirmLarge, false))
  it('481 → 409 CONFIRM_REQUIRED', () => err({ ...base, minutes: 481 }, 409, 'CONFIRM_REQUIRED'))
  it('-481 → 409 CONFIRM_REQUIRED', () => err({ ...base, minutes: -481 }, 409, 'CONFIRM_REQUIRED'))
  it('481 + confirmLarge:true → 接受', () => assert.equal(ok({ ...base, minutes: 481, confirmLarge: true }).value.minutes, 481))
  it('481 + confirmLarge:"true"（字串）→ 仍然 409', () => err({ ...base, minutes: 481, confirmLarge: 'true' }, 409, 'CONFIRM_REQUIRED'))
  it('常數 = 480', () => assert.equal(MANUAL_CONFIRM_THRESHOLD_MIN, 480))
})

describe('validateManualAdjust — 月份', () => {
  it('2026-10 合法', () => assert.equal(ok(base).value.effectiveMonth, '2026-10'))
  it('00 月 / 13 月 → 400', () => {
    err({ ...base, effectiveMonth: '2026-00' }, 400, 'BAD_INPUT')
    err({ ...base, effectiveMonth: '2026-13' }, 400, 'BAD_INPUT')
  })
  it('壞格式 → 400', () => {
    for (const m of ['2026-1', '2026/10', '26-10', '202610', '', '2026-10-01', 'abcd-10']) {
      err({ ...base, effectiveMonth: m }, 400, 'BAD_INPUT')
    }
  })
  it('regex 常數', () => {
    assert.ok(MANUAL_MONTH_RE.test('1999-01'))
    assert.ok(MANUAL_MONTH_RE.test('2999-12'))
    assert.ok(!MANUAL_MONTH_RE.test('2026-00'))
  })
})

describe('validateManualAdjust — 原因 / 員工', () => {
  it('正常 trim', () => assert.equal(ok({ ...base, reason: '  補返去年  ' }).value.reason, '補返去年'))
  it('空白原因 → 400', () => {
    err({ ...base, reason: '' }, 400, 'BAD_INPUT')
    err({ ...base, reason: '   ' }, 400, 'BAD_INPUT')
  })
  it('200 字接受、201 字 → 400', () => {
    assert.ok(ok({ ...base, reason: 'a'.repeat(200) }).ok)
    err({ ...base, reason: 'a'.repeat(201) }, 400, 'BAD_INPUT')
  })
  it('原因唔係字串 → 400', () => err({ ...base, reason: 123 }, 400, 'BAD_INPUT'))
  it('employeeId 缺／空白 → 400', () => {
    err({ ...base, employeeId: '' }, 400, 'BAD_INPUT')
    err({ ...base, employeeId: '   ' }, 400, 'BAD_INPUT')
    err({ minutes: 150, effectiveMonth: '2026-10', reason: 'x' }, 400, 'BAD_INPUT')
  })
  it('body 唔係 object → 400', () => {
    err(null, 400, 'BAD_INPUT')
    err('str', 400, 'BAD_INPUT')
    err([1], 400, 'BAD_INPUT')
  })
})

describe('validateManualReverse', () => {
  it('正常（reason 可選）', () => {
    const v = validateManualReverse({ entryId: 'abc123', reason: '錄錯' })
    assert.equal(v.ok, true)
    if (v.ok) { assert.equal(v.value.entryId, 'abc123'); assert.equal(v.value.reason, '錄錯') }
    const v2 = validateManualReverse({ entryId: 'abc123' })
    assert.equal(v2.ok, true)
    if (v2.ok) assert.equal(v2.value.reason, '')
  })
  it('entryId 缺 → 400', () => {
    const v = validateManualReverse({ reason: 'x' })
    assert.equal(v.ok, false); if (!v.ok) assert.equal(v.status, 400)
  })
  it('reason > 200 → 400', () => {
    const v = validateManualReverse({ entryId: 'abc123', reason: 'a'.repeat(201) })
    assert.equal(v.ok, false)
  })
  it('body 唔係 object → 400', () => {
    const v = validateManualReverse(null)
    assert.equal(v.ok, false)
  })
})

describe('fmtManualMinutes', () => {
  it('分鐘級', () => {
    assert.equal(fmtManualMinutes(30), '+30 分鐘')
    assert.equal(fmtManualMinutes(-30), '−30 分鐘')
  })
  it('小時＋分鐘（永遠顯示 0 分）', () => {
    assert.equal(fmtManualMinutes(540), '+9 小時 0 分')
    assert.equal(fmtManualMinutes(-65), '−1 小時 5 分')
  })
})
