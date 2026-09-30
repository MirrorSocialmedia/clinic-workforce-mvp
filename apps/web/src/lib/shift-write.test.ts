/**
 * ★ 2026-09-30 S-06 排更驗證 + S-02 通知訊息 helpers 測試（cwm-shift Part F）
 * 跑法: TZ=UTC npx tsx --test src/lib/shift-write.test.ts
 *
 * 覆蓋：
 *   - isValidDateStr：YYYY-MM-DD 真日期（2026-02-30 唔准靜靜滾去 03-02）
 *   - shiftTimesError：>0 且 ≤16h（end ≤ start 經 buildShiftTimes 會當跨夜 +1 日 → 16h 上限擋）
 *   - shiftAddedMsg / shiftRestoredMsg / shiftReplacedMsg：訊息格式
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildShiftTimes,
  isValidDateStr,
  shiftTimesError,
  MAX_SHIFT_MINUTES,
  SHIFT_STATUS_WRITABLE,
} from './shift-write'
import { shiftAddedMsg, shiftRestoredMsg, shiftReplacedMsg, buildNotification } from './notification-messages'

const D = (s: string) => new Date(`${s}T00:00:00+08:00`)
const nameOf = () => 'A 店'

describe('isValidDateStr（S-06 真日期驗證）', () => {
  it('合法 YYYY-MM-DD → true', () => {
    assert.equal(isValidDateStr('2026-03-01'), true)
    assert.equal(isValidDateStr('2024-02-29'), true) // 閏年
  })

  it('格式錯 → false', () => {
    for (const bad of ['2026/03/01', '26-03-01', '2026-3-1', '20260301', '', '2026-03-01T00:00:00Z', 'not-a-date']) {
      assert.equal(isValidDateStr(bad), false, `should reject ${JSON.stringify(bad)}`)
    }
    assert.equal(isValidDateStr(null), false)
    assert.equal(isValidDateStr(20260301), false)
  })

  it('假日期唔准靜靜滾 → false（2026-02-30 / 2026-04-31 / 2026-13-01）', () => {
    assert.equal(isValidDateStr('2026-02-30'), false)
    assert.equal(isValidDateStr('2026-02-29'), false) // 非閏年
    assert.equal(isValidDateStr('2026-04-31'), false)
    assert.equal(isValidDateStr('2026-13-01'), false)
    assert.equal(isValidDateStr('2026-00-10'), false)
  })
})

describe('shiftTimesError（S-06 時長合理性）', () => {
  it('正常白更 09:00–18:00 → null', () => {
    const t = buildShiftTimes('2026-10-05', '09:00', '18:00')
    assert.equal(shiftTimesError(t), null)
  })

  it('正常跨夜更 22:00–07:00（9h）→ null', () => {
    const t = buildShiftTimes('2026-10-05', '22:00', '07:00')
    assert.equal(shiftTimesError(t), null)
  })

  it('exactly 16h 上限 → null；超 16h → 錯誤', () => {
    const ok16 = { startTime: D('2026-10-05'), endTime: new Date(D('2026-10-05').getTime() + MAX_SHIFT_MINUTES * 60000) }
    assert.equal(shiftTimesError(ok16), null)
    const over = { startTime: D('2026-10-05'), endTime: new Date(D('2026-10-05').getTime() + (MAX_SHIFT_MINUTES + 1) * 60000) }
    assert.match(shiftTimesError(over)!, /16 小時上限/)
  })

  it('end ≤ start 打錯時分 → 錯誤訊息', () => {
    // 直接比較（無 buildShiftTimes +1 日）：end 早過 start（epoch 偏移，TZ 無關）
    const base = D('2026-10-05').getTime()
    const reversed = { startTime: new Date(base + 9 * 3600e3), endTime: new Date(base + 8 * 3600e3) }
    assert.equal(shiftTimesError(reversed), '收工時間要遲過開工時間')
    // 經 buildShiftTimes：09:00–09:00 → 24h 跨夜 → 撞 16h 上限
    const same = buildShiftTimes('2026-10-05', '09:00', '09:00')
    assert.match(shiftTimesError(same)!, /24 小時/)
    // 打錯 21:00 收工做 08:00（同日被當跨夜 +1 日 = 11h — 呢種唔擋，屬合理跨夜口徑；
    //   真打錯 21:00–08:00(=11h) 唔撞上限，靠人工核）
    const overnight11 = buildShiftTimes('2026-10-05', '21:00', '08:00')
    assert.equal(shiftTimesError(overnight11), null)
  })

  it('Invalid Date → 時間格式錯誤', () => {
    assert.equal(shiftTimesError({ startTime: new Date('nope'), endTime: new Date('nope') }), '時間格式錯誤（需要 HH:MM）')
  })
})

describe('SHIFT_STATUS_WRITABLE（S-06）', () => {
  it('POST 只准 DRAFT/CONFIRMED', () => {
    assert.deepEqual([...SHIFT_STATUS_WRITABLE], ['DRAFT', 'CONFIRMED'])
  })
})

describe('新增／還原／取代 通知訊息（S-02/S-03）', () => {
  const shift = {
    date: D('2026-10-05'),
    startTime: new Date('2026-10-05T10:00:00+08:00'),
    endTime: new Date('2026-10-05T18:00:00+08:00'),
    clinicId: 'c1',
  }

  it('shiftAddedMsg 格式', () => {
    assert.equal(shiftAddedMsg(shift, nameOf), '10月05日 A 店 10:00-18:00 新增更次')
  })

  it('shiftRestoredMsg 格式（講明忽略頭先取消通知）', () => {
    assert.equal(shiftRestoredMsg(shift, nameOf), '10月05日 A 店 10:00-18:00 更次已恢復（請忽略頭先嘅取消通知）')
  })

  it('shiftReplacedMsg 格式', () => {
    assert.equal(shiftReplacedMsg(shift, nameOf), '10月05日 A 店 10:00-18:00 更次已被新更次取代')
  })

  it('buildNotification 多項 → 匯總 + details JSON', () => {
    const n = buildNotification('e1', ['a', 'b'], 's1')
    assert.equal(n.employeeId, 'e1')
    assert.equal(n.type, 'SHIFT_CHANGED')
    assert.equal(n.content, '你的排班有 2 項更新')
    assert.deepEqual(JSON.parse(n.details as string), ['a', 'b'])
    assert.equal(n.relatedId, 's1')
    const one = buildNotification('e1', ['a'])
    assert.equal(one.content, 'a')
    assert.equal(one.relatedId, null)
  })
})
