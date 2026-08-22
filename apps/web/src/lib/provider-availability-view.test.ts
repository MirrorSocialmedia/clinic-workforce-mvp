/**
 * ★ cw-pa P4: 醫生時間表 page 層純邏輯測試
 * 跑法: cd apps/web && npx tsx --test src/lib/provider-availability-view.test.ts
 * Node 22 內建 test runner（node:test），唔加新 dependency（照 P1 availability.test.ts 慣例）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseHHmm,
  fmtMin,
  formatHKTime,
  providerColor,
  isValidHexColor,
  soft,
  FALLBACK_PALETTE,
  hkTodayStr,
  addDays,
  weekdayOf,
  shortDoctor,
  buildShortNames,
  buildDays,
  isWeekEmpty,
  computeAxis,
  syncChipState,
  syncChip,
  defaultClinicId,
  dayEmptyText,
  type AvailabilityResp,
  type Range,
} from './provider-availability-view'

// ─── fixture ───

const FROM = '2026-08-20' // 星期四
const D0 = '2026-08-20'
const D1 = '2026-08-21'
const D2 = '2026-08-22'
const D3 = '2026-08-23'
const D4 = '2026-08-24'

function mkResp(over: Partial<AvailabilityResp> = {}): AvailabilityResp {
  return {
    clinic: { id: 'c1', name: 'Syn Clinic' },
    from: FROM,
    to: addDays(FROM, 6),
    sync: { lastSyncAt: '2026-08-20T06:00:00.000Z', stale: false },
    providers: [
      {
        id: 'pa',
        name: 'Dr A',
        color: '#FF0000',
        openSch: [
          { date: D0, start: '09:00', end: '18:00' },
          { date: D1, start: '09:30', end: '12:00' },
        ],
        // ★ 2026-08-21 拍板⑤：逐筆（11:15–11:45 ×4 + 14:00–15:00 ×2）
        booked: [
          { date: D0, start: '11:15', end: '11:45', status: 0 },
          { date: D0, start: '11:15', end: '11:45', status: 0 },
          { date: D0, start: '11:15', end: '11:45', status: 0 },
          { date: D0, start: '11:15', end: '11:45', status: 4 },
          { date: D0, start: '14:00', end: '15:00', status: 0 },
          { date: D0, start: '14:00', end: '15:00', status: 0 },
        ],
        weekBookings: 6,
        leaveDates: [],
      },
      { id: 'pb', name: 'Dr B', color: null, openSch: [], booked: [], weekBookings: 0, leaveDates: [] },
      {
        id: 'pc',
        name: 'Dr C',
        color: null,
        openSch: [{ date: D2, start: '08:30', end: '10:00' }],
        booked: [],
        weekBookings: 0,
        leaveDates: [],
      },
      {
        id: 'pd',
        name: 'Dr D',
        color: null,
        openSch: [
          { date: D0, start: '9:00', end: '18:00' }, // ★ 格式錯 → drop
          { date: D3, start: '13:00', end: '17:00' },
        ],
        booked: [{ date: D0, start: '10:00', end: '09:00', status: 3 }], // ★ end<=start → drop
        weekBookings: 1,
        leaveDates: [],
      },
    ],
    ...over,
  }
}

// ─── parseHHmm / fmtMin ───

describe('parseHHmm — HH:mm → 分鐘數', () => {
  it('正常值（spec §7.2 #9 同源場景）', () => {
    assert.equal(parseHHmm('09:00'), 540)
    assert.equal(parseHHmm('18:00'), 1080)
    assert.equal(parseHHmm('20:00'), 1200)
    assert.equal(parseHHmm('00:30'), 30)
    assert.equal(parseHHmm('00:00'), 0)
    assert.equal(parseHHmm('23:59'), 1439)
  })
  it('無效值 → null（唔會 throw）', () => {
    assert.equal(parseHHmm('24:00'), null)
    assert.equal(parseHHmm('09:60'), null)
    assert.equal(parseHHmm('9:00'), null)
    assert.equal(parseHHmm('900'), null) // Apricot 原始格式唔係呢度嘅入參
    assert.equal(parseHHmm(''), null)
    assert.equal(parseHHmm('ab:cd'), null)
    assert.equal(parseHHmm('09:00:00'), null)
    assert.equal(parseHHmm(null), null)
    assert.equal(parseHHmm(undefined), null)
    assert.equal(parseHHmm(900 as any), null)
  })
  it('parse/fmt round-trip', () => {
    for (const s of ['00:00', '00:30', '09:00', '11:45', '18:00', '20:00', '23:59']) {
      assert.equal(fmtMin(parseHHmm(s) as number), s)
    }
  })
})

describe('fmtMin — 分鐘數 → HH:mm', () => {
  it('基本值', () => {
    assert.equal(fmtMin(0), '00:00')
    assert.equal(fmtMin(30), '00:30')
    assert.equal(fmtMin(540), '09:00')
    assert.equal(fmtMin(1200), '20:00')
  })
})

describe('formatHKTime — ISO → HK HH:mm', () => {
  it('UTC+8 轉換', () => {
    assert.equal(formatHKTime('2026-08-20T06:00:00.000Z'), '14:00')
    assert.equal(formatHKTime('2026-08-20T15:59:00.000Z'), '23:59')
    assert.equal(formatHKTime('2026-08-20T16:30:00.000Z'), '00:30') // 跨 midnight
  })
  it('無效 ISO → --:--', () => {
    assert.equal(formatHKTime('not-a-date'), '--:--')
  })
})

// ─── 顏色 ───

describe('providerColor — Provider.color 優先，冇值先 hash（§6.2 #5）', () => {
  it('有有效 color → 直接回傳', () => {
    assert.equal(providerColor('any-seed', '#FF8800'), '#FF8800')
    assert.equal(providerColor('any-seed', '#059669'), '#059669')
  })
  it('null / 無 color → hash 入 palette', () => {
    assert.ok(FALLBACK_PALETTE.includes(providerColor('seed', null)))
    assert.ok(FALLBACK_PALETTE.includes(providerColor('seed', undefined)))
  })
  it('格式錯 color → 唔會采用，fallback hash', () => {
    assert.ok(FALLBACK_PALETTE.includes(providerColor('s1', 'red')))
    assert.ok(FALLBACK_PALETTE.includes(providerColor('s2', '#12345')))
    assert.ok(FALLBACK_PALETTE.includes(providerColor('s3', '#gggggg')))
    assert.equal(isValidHexColor('#12345'), false)
    assert.equal(isValidHexColor('#AABBCC'), true)
  })
  it('hash 穩定：同 seed 同一色', () => {
    assert.equal(providerColor('seed-x', null), providerColor('seed-x', null))
  })
  it('唔同 seed 唔會全部撞同一色', () => {
    const colors = new Set(Array.from({ length: 10 }, (_, i) => providerColor(`seed-${i}`, null)))
    assert.ok(colors.size >= 2, `expected >=2 distinct colors, got ${colors.size}`)
  })
})

describe('soft — 8 位 hex alpha 淺底', () => {
  it('加 22 alpha', () => {
    assert.equal(soft('#6366f1'), '#6366f122')
    assert.equal(soft('#059669'), '#05966922')
  })
})

// ─── 日期 ───

describe('addDays / weekdayOf / hkTodayStr', () => {
  it('加減日', () => {
    assert.equal(addDays(FROM, 0), '2026-08-20')
    assert.equal(addDays(FROM, 6), '2026-08-26')
    assert.equal(addDays(FROM, -7), '2026-08-13')
    assert.equal(addDays('2026-08-30', 6), '2026-09-05') // 跨月
    assert.equal(addDays('2026-12-31', 1), '2027-01-01') // 跨年
  })
  it('星期幾（2026-08-20 = 星期四）', () => {
    assert.equal(weekdayOf('2026-08-20'), '四')
    assert.equal(weekdayOf('2026-08-19'), '三')
    assert.equal(weekdayOf('2026-08-23'), '日')
  })
  it('hkTodayStr 格式 + 合理範圍', () => {
    const t = hkTodayStr()
    assert.match(t, /^\d{4}-\d{2}-\d{2}$/)
    const diff = Math.abs(new Date(`${t}T00:00:00+08:00`).getTime() - Date.now())
    assert.ok(diff < 2 * 24 * 3600 * 1000, 'today 應喺 ±2 日內')
  })
})

// ─── 醫生簡稱（§6.5 2026-08-21 拍板③：Dr + 姓 + 動態同姓防撞）───

describe('shortDoctor — Dr + 姓', () => {
  it('中文名 → Dr + 姓（「譚家杰醫生」→「Dr 譚」）', () => {
    assert.equal(shortDoctor('譚家杰醫生'), 'Dr 譚')
    assert.equal(shortDoctor('譚家杰'), 'Dr 譚')   // 無「醫生」後綴都成立
    assert.equal(shortDoctor('李医生'), 'Dr 李')   // 簡體姓（「李」U+674E 喺 \u4e00-\u9fa5 範圍內）
  })
  it('英文名原樣（包括已有 Dr 前綴）', () => {
    assert.equal(shortDoctor('Dr A'), 'Dr A')
    assert.equal(shortDoctor('John Smith'), 'John Smith')
    assert.equal(shortDoctor('A'), 'A')
  })
})

describe('buildShortNames — 動態同姓防撞', () => {
  it('單姓（各唯一）→ 一字', () => {
    const m = buildShortNames(['譚家杰醫生', '陳大文醫生'])
    assert.equal(m.get('譚家杰醫生'), 'Dr 譚')
    assert.equal(m.get('陳大文醫生'), 'Dr 陳')
  })
  it('同姓 ≥2 → 嗰啲醫生用兩字（Dr 譚家），其他姓不受影響', () => {
    const m = buildShortNames(['陳大文醫生', '陳小文醫生', '李医生', 'Dr A'])
    assert.equal(m.get('陳大文醫生'), 'Dr 陳大')
    assert.equal(m.get('陳小文醫生'), 'Dr 陳小')
    assert.equal(m.get('李医生'), 'Dr 李')   // 李姓只 1 個 → 照返一字
    assert.equal(m.get('Dr A'), 'Dr A')      // 英文名完全唔變
  })
  it('同姓 ≥3 → 全部兩字', () => {
    const m = buildShortNames(['陳一醫生', '陳二醫生', '陳三醫生'])
    assert.equal(m.get('陳一醫生'), 'Dr 陳一')
    assert.equal(m.get('陳二醫生'), 'Dr 陳二')
    assert.equal(m.get('陳三醫生'), 'Dr 陳三')
  })
  it('複姓（歐陽）→「Dr 歐」（已知限制）；兩個同複姓 → 兩字仍然撞（記錄行為）', () => {
    const m = buildShortNames(['歐陽峰醫生'])
    assert.equal(m.get('歐陽峰醫生'), 'Dr 歐')
    const m2 = buildShortNames(['歐陽峰醫生', '歐陽華醫生'])
    assert.equal(m2.get('歐陽峰醫生'), 'Dr 歐陽')
    assert.equal(m2.get('歐陽華醫生'), 'Dr 歐陽') // ★ 仍撞 — MD：要白名單先處理，呢度唔做
  })
  it('中英混排：英文名唔參與同姓計數', () => {
    const m = buildShortNames(['陳大文醫生', 'John Smith', '陳小文醫生'])
    assert.equal(m.get('John Smith'), 'John Smith')
    assert.equal(m.get('陳大文醫生'), 'Dr 陳大')
  })
  it('空列表 → 空 Map', () => {
    assert.equal(buildShortNames([]).size, 0)
  })
})

// ─── buildDays（P3 flat shape → 7 日渲染 shape）───

const R = (s: number, e: number, status?: number): Range => ({ s, e, ...(status !== undefined ? { status } : {}) })


describe('buildDays — flat providers[] → 7 日', () => {
  const days = buildDays(mkResp())

  it('7 日，日期 from..from+6 順序正確', () => {
    assert.equal(days.length, 7)
    assert.deepEqual(
      days.map(d => d.date),
      [D0, D1, D2, D3, '2026-08-24', '2026-08-25', addDays(D0, 6)],
    )
    assert.equal(days[0].date, D0)
    assert.equal(days[6].date, addDays(FROM, 6))
  })

  it('有 data 醫生出現喺正確日；無 data 醫生（Dr B）全週唔出現', () => {
    assert.deepEqual(days[0].providers.map(p => p.providerId), ['pa'])
    assert.deepEqual(days[1].providers.map(p => p.providerId), ['pa'])
    assert.deepEqual(days[2].providers.map(p => p.providerId), ['pc'])
    assert.deepEqual(days[3].providers.map(p => p.providerId), ['pd'])
    for (let i = 4; i < 7; i++) assert.equal(days[i].providers.length, 0)
    for (const d of days) assert.ok(!d.providers.some(p => p.providerId === 'pb'))
  })

  it('HH:mm → s/e 分鐘 + status 保留 + total = 當日預約筆數（逐筆回）', () => {
    const a0 = days[0].providers[0]
    assert.deepEqual(a0.open, [R(540, 1080)])
    assert.deepEqual(a0.busy, [
      R(675, 705, 0), R(675, 705, 0), R(675, 705, 0), R(675, 705, 4),
      R(840, 900, 0), R(840, 900, 0),
    ])
    assert.equal(a0.total, 6)
    assert.equal(a0.weekBookings, 6)
    assert.equal(a0.name, 'Dr A')
    assert.equal(a0.color, '#FF0000')
    const a1 = days[1].providers[0]
    assert.deepEqual(a1.open, [R(570, 720)])
    assert.deepEqual(a1.busy, [])
    assert.equal(a1.total, 0)
    assert.equal(a1.weekBookings, 6) // 承傳同 ProviderAvail（逐日 total 先係當日）
  })

  it('格式錯 / end<=start entry 被 drop；同醫生其他有效 entry 照收', () => {
    // Dr D: D0 兩筆都無效（'9:00' 格式錯 + end<start）→ D0 唔出現
    assert.ok(!days[0].providers.some(p => p.providerId === 'pd'))
    // D3 有效 → 出現
    const d3 = days[3].providers.find(p => p.providerId === 'pd')
    assert.ok(d3)
    assert.deepEqual(d3!.open, [R(780, 1020)])
    assert.equal(d3!.total, 0)
  })

  it('isWeekEmpty — 全空 / 有 open / 有 booked / 有休假', () => {
    assert.equal(isWeekEmpty(mkResp()), false)
    assert.equal(
      isWeekEmpty(mkResp({ providers: [{ id: 'x', name: 'X', color: null, openSch: [], booked: [], weekBookings: 0, leaveDates: [] }] })),
      true,
    )
    assert.equal(
      isWeekEmpty(
        mkResp({ providers: [{ id: 'x', name: 'X', color: null, openSch: [], booked: [{ date: D0, start: '09:00', end: '09:30', status: 0 }], weekBookings: 1, leaveDates: [] }] }),
      ),
      false,
    )
    // ★ cw-pta：全週只有休假（無 open/booked）→ 唔算空（要畫斜紋，唔好寫「未接通」）
    assert.equal(
      isWeekEmpty(
        mkResp({ providers: [{ id: 'x', name: 'X', color: null, openSch: [], booked: [], weekBookings: 0, leaveDates: [D0, D1] }] }),
      ),
      false,
    )
    assert.equal(isWeekEmpty(mkResp({ providers: [] })), true)
  })
})

// ─── buildDays — 休假顯示（cw-pta spec §4 / 驗收 #15 #16 #17）───

describe('buildDays — 休假（onLeave / leaveConflict / #15 唔消失）', () => {
  const respLeave = mkResp({
    providers: [
      // #15：放假但 Apricot 完全無開診 → 都要出現（唔好令佢消失）
      { id: 'pl', name: 'Dr Leave', color: null, openSch: [], booked: [], weekBookings: 0, leaveDates: [D1, D2, D3] },
      // 衝突：放假 + 該日有開診
      { id: 'pc1', name: 'Dr Conflict', color: null, openSch: [{ date: D0, start: '09:00', end: '12:00' }], booked: [], weekBookings: 0, leaveDates: [D0] },
      // 衝突：放假 + 該日只有預約（無開診時段）
      { id: 'pb1', name: 'Dr BookedOnly', color: null, openSch: [], booked: [{ date: D4, start: '10:00', end: '10:30', status: 0 }], weekBookings: 1, leaveDates: [D4] },
      // 正常：無假
      { id: 'pnl', name: 'Dr Normal', color: null, openSch: [{ date: D0, start: '09:00', end: '18:00' }], booked: [], weekBookings: 0, leaveDates: [] },
    ],
  })
  const days = buildDays(respLeave)

  it('★#15：放假但完全無開診嘅醫生要補返入該日 providers（onLeave=true，open/busy 空）', () => {
    for (const d of [D1, D2, D3]) {
      const day = days.find(x => x.date === d)!
      const p = day.providers.find(x => x.providerId === 'pl')
      assert.ok(p, `#15: Dr Leave 必須出現喺 ${d}`)
      assert.equal(p!.onLeave, true)
      assert.equal(p!.leaveConflict, false)
      assert.deepEqual(p!.open, [])
      assert.deepEqual(p!.busy, [])
      assert.equal(p!.total, 0)
    }
    // 冇假嘅日唔出現
    assert.ok(!days.find(x => x.date === D0)!.providers.some(p => p.providerId === 'pl'))
    assert.ok(!days.find(x => x.date === addDays(D0, 6))!.providers.some(p => p.providerId === 'pl'))
  })

  it('★#16：放假 + 有開診 → onLeave=true + leaveConflict=true（斜紋做底、紅框、label 用 UI 層畫）', () => {
    const p = days[0].providers.find(x => x.providerId === 'pc1')
    assert.ok(p)
    assert.equal(p!.onLeave, true)
    assert.equal(p!.leaveConflict, true)
    assert.deepEqual(p!.open, [R(540, 720)]) // 開診照畫（open 唔会被吃掉）
  })

  it('放假 + 只有預約（無 open）→ 都算衝突', () => {
    const day = days.find(x => x.date === D4)!
    const p = day.providers.find(x => x.providerId === 'pb1')
    assert.ok(p)
    assert.equal(p!.onLeave, true)
    assert.equal(p!.leaveConflict, true)
    assert.equal(p!.total, 1)
  })

  it('無假 → onLeave=false、leaveConflict=false（回歸：完全冇斜紋）', () => {
    const p = days[0].providers.find(x => x.providerId === 'pnl')
    assert.ok(p)
    assert.equal(p!.onLeave, false)
    assert.equal(p!.leaveConflict, false)
  })

  it('跨日休假 8/22–8/24 → 三日都有（同 expandLeavesToSet 行為一致）', () => {
    const leaveDays = days.filter(d => d.providers.some(p => p.providerId === 'pl')).map(d => d.date)
    assert.deepEqual(leaveDays, [D1, D2, D3])
  })
})

// ─── computeAxis ───

describe('computeAxis — 掃 open+busy，保底 09:00–21:00（2026-08-22 §1.1）', () => {
  // ── 現有 4 條（更新為新語義：busy 一齊掃 + 09:00/21:00 保底，唔係機械改數字）──
  it('無 data（無 open 無 busy）→ 保底 [540, 1260]', () => {
    // fallback 由 08:00–21:00 改為 09:00–21:00（診所實際營業範圍）
    assert.deepEqual(computeAxis(buildDays(mkResp({ providers: [] }))), [540, 1260])
  })
  it('跟資料 range 對齊整點；hi 被 21:00 保底拉上', () => {
    const days = buildDays(mkResp())
    // Dr A D0: 540–1080；Dr A D1: 570–720；Dr C D2: 510–600；Dr D D3: 780–1020
    // lo=510（08:30 開診）→ floor 480（早於 09:00 → 保留 480，保底唔係封頂）
    // hi=1080（18:00）< 21:00 → 保底拉上 1260（軸唔再縮晒貼住資料）
    assert.deepEqual(computeAxis(days), [480, 1260])
  })
  it('只有 busy（無 open）→ busy 一齊掃（唔再 fallback），hi 保底 21:00', () => {
    const days = buildDays(
      mkResp({ providers: [{ id: 'x', name: 'X', color: null, openSch: [], booked: [{ date: D0, start: '09:00', end: '09:30', status: 0 }], weekBookings: 1, leaveDates: [] }] }),
    )
    // busy 09:00–09:30 = 540–570 → lo floor 540，hi ceil 600 → 保底 [540, 1260]
    assert.deepEqual(computeAxis(days), [540, 1260])
  })
  it('非整點 open → floor/ceil，hi 保底 21:00', () => {
    const days = buildDays(
      mkResp({ providers: [{ id: 'x', name: 'X', color: null, openSch: [{ date: D0, start: '09:30', end: '18:15' }], booked: [], weekBookings: 0, leaveDates: [] }] }),
    )
    // lo=570 → floor 540；hi=1095 → ceil 1140，保底拉上 1260
    assert.deepEqual(computeAxis(days), [540, 1260])
  })
  // ── 新增 5 條（2026-08-22 §1.1：漏預約 bug —— 預約超出開診時段會被軸外切走）──
  it('預約超開診（open 10:00–20:00 + busy 20:15–20:45）→ hi=1260（21:00），個塊完整畫出', () => {
    const days = buildDays(
      mkResp({ providers: [{ id: 'x', name: 'X', color: null, openSch: [{ date: D0, start: '10:00', end: '20:00' }], booked: [{ date: D0, start: '20:15', end: '20:45', status: 0 }], weekBookings: 1, leaveDates: [] }] }),
    )
    // busy 1245 超出 open 1200 —— 唔掃 busy 軸頂就係 20:00，塊被 overflow 切走
    // lo=600（10:00）→ 保底拉低 540（軸一定由 09:00 或之前開始）
    assert.deepEqual(computeAxis(days), [540, 1260])
  })
  it('全空（days=[]）→ fallback [540, 1260]', () => {
    assert.deepEqual(computeAxis([]), [540, 1260])
  })
  it('單個 10:00–10:30 預約（無 open）→ 軸仍然 09:00–21:00，唔縮成兩粒鐘', () => {
    const days = buildDays(
      mkResp({ providers: [{ id: 'x', name: 'X', color: null, openSch: [], booked: [{ date: D0, start: '10:00', end: '10:30', status: 0 }], weekBookings: 1, leaveDates: [] }] }),
    )
    // busy 600–630 → lo floor 600 → 保底拉低到 540；hi ceil 660 → 保底拉上 1260
    assert.deepEqual(computeAxis(days), [540, 1260])
  })
  it('有 21:30 預約 → 軸撐到 22:00（保底唔係封頂）', () => {
    const days = buildDays(
      mkResp({ providers: [{ id: 'x', name: 'X', color: null, openSch: [{ date: D0, start: '10:00', end: '20:00' }], booked: [{ date: D0, start: '21:00', end: '21:30', status: 0 }], weekBookings: 1, leaveDates: [] }] }),
    )
    // hi=1290 → ceil 1320（22:00）；21:00 保底係底唔係頂
    // lo=600（10:00）→ 保底拉低 540
    assert.deepEqual(computeAxis(days), [540, 1320])
  })
  it('有 08:00 開診 → lo=480（保底唔係封頂）', () => {
    const days = buildDays(
      mkResp({ providers: [{ id: 'x', name: 'X', color: null, openSch: [{ date: D0, start: '08:00', end: '12:00' }], booked: [], weekBookings: 0, leaveDates: [] }] }),
    )
    // lo=480（08:00）< 09:00 → 保留 480；hi=720 → 保底拉上 1260
    assert.deepEqual(computeAxis(days), [480, 1260])
  })
})

// ─── sync chip（§7.3 #20 + task brief）───

describe('syncChip — 三態顯示', () => {
  it('lastSyncAt=null → 未同步過（API 呢個情況 stale=true，但 UI 唔好寫「延遲」）', () => {
    assert.equal(syncChipState({ lastSyncAt: null, stale: true }), 'never')
    assert.deepEqual(syncChip({ lastSyncAt: null, stale: true }), { tone: 'gray', label: '未同步過' })
  })
  it('stale → 同步延遲（最後成功：HH:mm）', () => {
    const chip = syncChip({ lastSyncAt: '2026-08-20T06:00:00.000Z', stale: true })
    assert.equal(chip.tone, 'warn')
    assert.equal(chip.label, '同步延遲（最後成功：14:00）')
  })
  it('fresh → Apricot HH:mm', () => {
    const chip = syncChip({ lastSyncAt: '2026-08-20T15:59:00.000Z', stale: false })
    assert.equal(chip.tone, 'ok')
    assert.equal(chip.label, 'Apricot 23:59')
  })
})

// ─── 其他 ───

describe('defaultClinicId — 診所選擇 default', () => {
  it('優先第一間已接通 Apricot 嘅店', () => {
    assert.equal(
      defaultClinicId([{ id: 'c1', name: 'A', connected: false }, { id: 'c2', name: 'B', connected: true }, { id: 'c3', name: 'C', connected: true }]),
      'c2',
    )
    assert.equal(defaultClinicId([{ id: 'c9', name: 'A', connected: true }, { id: 'c1', name: 'B', connected: true }]), 'c9')
  })
  it('冇接通 → 第一間；空清單 → ""', () => {
    assert.equal(defaultClinicId([{ id: 'c1', name: 'A', connected: false }, { id: 'c2', name: 'B', connected: false }]), 'c1')
    assert.equal(defaultClinicId([]), '')
  })
})

describe('dayEmptyText — 某日無任何醫生 data', () => {
  it('有同步過 → 休診；從冇同步 → 未同步', () => {
    assert.equal(dayEmptyText('2026-08-20T00:00:00.000Z'), '休診')
    assert.equal(dayEmptyText(null), '未同步')
  })
})
