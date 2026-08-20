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
  freeGaps,
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
        booked: [
          { date: D0, start: '11:15', end: '11:45', count: 4 },
          { date: D0, start: '14:00', end: '15:00', count: 2 },
        ],
      },
      { id: 'pb', name: 'Dr B', color: null, openSch: [], booked: [] },
      {
        id: 'pc',
        name: 'Dr C',
        color: null,
        openSch: [{ date: D2, start: '08:30', end: '10:00' }],
        booked: [],
      },
      {
        id: 'pd',
        name: 'Dr D',
        color: null,
        openSch: [
          { date: D0, start: '9:00', end: '18:00' }, // ★ 格式錯 → drop
          { date: D3, start: '13:00', end: '17:00' },
        ],
        booked: [{ date: D0, start: '10:00', end: '09:00', count: 3 }], // ★ end<=start → drop
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

// ─── freeGaps ───

const R = (s: number, e: number, count?: number): Range => ({ s, e, ...(count !== undefined ? { count } : {}) })

describe('freeGaps — open − busy（>=30 分鐘先顯示）', () => {
  it('中間一段 busy → 兩邊 gap', () => {
    const gaps = freeGaps([R(540, 1080)], [R(600, 660)])
    assert.deepEqual(gaps, [R(540, 600), R(660, 1080)])
  })
  it('相鄰 busy → 之間無 gap', () => {
    const gaps = freeGaps([R(540, 1080)], [R(600, 660), R(660, 720)])
    assert.deepEqual(gaps, [R(540, 600), R(720, 1080)])
  })
  it('<30 分鐘碎 gap 過濾', () => {
    const gaps = freeGaps([R(540, 1080)], [R(555, 570), R(585, 600)])
    assert.deepEqual(gaps, [R(600, 1080)])
  })
  it('busy 完全蓋住 open → 無 gap', () => {
    const gaps = freeGaps([R(540, 720), R(900, 1080)], [R(540, 1080)])
    assert.deepEqual(gaps, [])
  })
})

// ─── buildDays（P3 flat shape → 7 日渲染 shape）───

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

  it('HH:mm → s/e 分鐘 + count 保留 + total = 當日預約總數', () => {
    const a0 = days[0].providers[0]
    assert.deepEqual(a0.open, [R(540, 1080)])
    assert.deepEqual(a0.busy, [R(675, 705, 4), R(840, 900, 2)])
    assert.equal(a0.total, 6)
    assert.equal(a0.name, 'Dr A')
    assert.equal(a0.color, '#FF0000')
    const a1 = days[1].providers[0]
    assert.deepEqual(a1.open, [R(570, 720)])
    assert.deepEqual(a1.busy, [])
    assert.equal(a1.total, 0)
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

  it('isWeekEmpty — 全空 / 有 open / 有 booked', () => {
    assert.equal(isWeekEmpty(mkResp()), false)
    assert.equal(
      isWeekEmpty(mkResp({ providers: [{ id: 'x', name: 'X', color: null, openSch: [], booked: [] }] })),
      true,
    )
    assert.equal(
      isWeekEmpty(
        mkResp({ providers: [{ id: 'x', name: 'X', color: null, openSch: [], booked: [{ date: D0, start: '09:00', end: '09:30', count: 1 }] }] }),
      ),
      false,
    )
    assert.equal(isWeekEmpty(mkResp({ providers: [] })), true)
  })
})

// ─── computeAxis ───

describe('computeAxis — floor/ceil 整點，fallback 08:00–21:00', () => {
  it('無 data → [480, 1260]', () => {
    assert.deepEqual(computeAxis(buildDays(mkResp({ providers: [] }))), [480, 1260])
  })
  it('跟資料 range 對齊整點', () => {
    const days = buildDays(mkResp())
    // Dr A D0: 540–1080；Dr A D1: 570–720；Dr C D2: 510–600；Dr D D3: 780–1020
    assert.deepEqual(computeAxis(days), [480, 1080])
  })
  it('只有 busy（無 open）→ fallback', () => {
    const days = buildDays(
      mkResp({ providers: [{ id: 'x', name: 'X', color: null, openSch: [], booked: [{ date: D0, start: '09:00', end: '09:30', count: 1 }] }] }),
    )
    assert.deepEqual(computeAxis(days), [480, 1260])
  })
  it('非整點 open → floor/ceil', () => {
    const days = buildDays(
      mkResp({ providers: [{ id: 'x', name: 'X', color: null, openSch: [{ date: D0, start: '09:30', end: '18:15' }], booked: [] }] }),
    )
    assert.deepEqual(computeAxis(days), [540, 1140])
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
