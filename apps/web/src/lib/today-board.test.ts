/**
 * ★ cwm-attfix-20260927：今日出勤看板 buildTodayBoard 測試（spec §B.5 — 7 case）
 * 跑法: npx tsx --test src/lib/today-board.test.ts
 * 寫法跟 pl-mark-route.test.ts（直接 override prisma 方法，唔真連 DB）
 *
 * 覆蓋（B 修正：調鋪員工誤報「漏落班卡」+ 同店分更錯認上班卡）：
 *   1  調鋪更 A→B（10:00–20:00），A 店 10:00 上班卡，B 店 20:05 落班卡，now=21:00
 *      → A 店卡 LEFT，missingOut = 0（舊代碼誤報 MISSING_OUT）
 *   2  同上但 B 店冇落班卡，now=21:00 → MISSING_OUT（真正漏卡照樣報）
 *   3  同上，now=20:20（未夠 30 分鐘寬限）→ ARRIVED，唔係 MISSING_OUT
 *   4  非調鋪更，員工喺第三間店 C 有落班卡 → 唔會當成 A 店落班卡 → MISSING_OUT
 *      （punch 查詢 clinicIds 只有 [A]）
 *   5  同店分更 10:00–14:00、16:00–20:00；10:00 上班、14:00 落班；now=16:30
 *      → 第一更 LEFT；第二更 NOT_ARRIVED（舊代碼會錯認第一更 10:00 上班卡 → ARRIVED）
 *   6  調鋪更，上班卡本身就喺 B 店打（A 店冇卡）→ 照樣認到上班卡（LEFT）
 *   7  斷言 getEffectivePunches 底層 punchRecord.findMany 收到嘅 clinicIds
 *      （調鋪 = [A,B]；非調鋪 = [A]），唔係單一 clinicId string
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from './prisma'
import { buildTodayBoard } from './today-board'

type Any = any

// ---- fixtures -------------------------------------------------------------
const cA = 'cA' // 上午店（primary / 顯示卡嘅店）
const cB = 'cB' // 下午店（secondary / 調鋪）
const cC = 'cC' // 第三間無關店
const D = '2026-09-27'
const dayStart = new Date(`${D}T00:00:00+08:00`)
const dayEnd = new Date(`${D}T23:59:59.999+08:00`)
const at = (hm: string) => new Date(`${D}T${hm}:00+08:00`)

interface PunchSeed { id: string; employeeId: string; clinicId: string; punchTime: Date; punchType: string }
let shifts: Any[] = []
let punches: PunchSeed[] = []
// getEffectivePunches 底層 punchRecord.findMany 收到嘅 where（case 7 斷言用）
let punchFindWheres: Any[] = []

const mkShift = (id: string, emp: string, start: string, end: string, secondary?: string) => ({
  id, employeeId: emp, date: dayStart,
  startTime: at(start), endTime: at(end),
  clinicId: cA, secondaryClinicId: secondary ?? null, status: 'CONFIRMED',
  employee: { user: { name: `emp-${emp}` } },
})
const mkPunch = (id: string, emp: string, clinic: string, time: string, punchType: 'CLOCK_IN' | 'CLOCK_OUT'): PunchSeed =>
  ({ id, employeeId: emp, clinicId: clinic, punchTime: at(time), punchType })

const board = (now: Date) => buildTodayBoard(cA, dayStart, dayEnd, now)
const person = (b: Any, startHM: string) =>
  b.people.find((p: Any) => p.shiftStart === at(startHM).toISOString())

// clinicId filter 口徑同 punch-query.ts 一致：string = 單店；{ in } = 多店
const clinicMatch = (w: Any, v: string): boolean => {
  if (w === undefined || w === null) return true
  if (typeof w === 'string') return v === w
  if (Array.isArray(w.in)) return w.in.includes(v)
  return true
}

const fakes: Record<string, Any> = {
  shift: {
    findMany: async (args: Any) => {
      const w = args?.where ?? {}
      return shifts.filter(s =>
        s.clinicId === w.clinicId &&
        !(w.status?.notIn ?? []).includes(s.status) &&
        s.date.getTime() >= w.date.gte.getTime() && s.date.getTime() < w.date.lt.getTime())
    },
  },
  punchRecord: {
    findMany: async (args: Any) => {
      const w = args?.where ?? {}
      punchFindWheres.push(w)
      return punches
        .filter(p =>
          p.punchTime.getTime() >= w.punchTime.gte.getTime() &&
          p.punchTime.getTime() <= w.punchTime.lte.getTime() &&
          (!w.employeeId?.in || w.employeeId.in.includes(p.employeeId)) &&
          clinicMatch(w.clinicId, p.clinicId))
        .sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime())
        .map(p => ({ ...p, void: null }))
    },
  },
  punchCorrection: { findMany: async () => [] },
  leaveRequest: { findMany: async () => [] },
}

const saved: Record<string, Any> = {}
before(() => {
  for (const k of Object.keys(fakes)) {
    saved[k] = (prisma as Any)[k]
    Object.defineProperty(prisma, k, { value: fakes[k], configurable: true, writable: true })
  }
})
after(() => {
  for (const k of Object.keys(fakes)) {
    Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
  }
})
describe('buildTodayBoard（cwm-attfix-20260927 spec §B.5）', () => {
  // 每個 case 重置 fixture
  beforeEach(() => { shifts = []; punches = []; punchFindWheres = [] })

  it('1 調鋪 A→B：A 上班卡 + B 落班卡（now=21:00）→ LEFT，missingOut=0', async () => {
    shifts = [mkShift('sh1', 'e1', '10:00', '20:00', cB)]
    punches = [mkPunch('p1', 'e1', cA, '10:00', 'CLOCK_IN'), mkPunch('p2', 'e1', cB, '20:05', 'CLOCK_OUT')]
    const b = await board(at('21:00'))
    assert.equal(person(b, '10:00')?.status, 'LEFT')
    assert.equal(b.missingOut, 0)
  })

  it('2 調鋪 A→B：B 冇落班卡（now=21:00，過咗 30 分鐘寬限）→ MISSING_OUT（真漏卡照報）', async () => {
    shifts = [mkShift('sh1', 'e1', '10:00', '20:00', cB)]
    punches = [mkPunch('p1', 'e1', cA, '10:00', 'CLOCK_IN')]
    const b = await board(at('21:00'))
    assert.equal(person(b, '10:00')?.status, 'MISSING_OUT')
    assert.equal(b.missingOut, 1)
  })

  it('3 調鋪 A→B：B 冇落班卡但 now=20:20（未夠 30 分鐘寬限）→ ARRIVED', async () => {
    shifts = [mkShift('sh1', 'e1', '10:00', '20:00', cB)]
    punches = [mkPunch('p1', 'e1', cA, '10:00', 'CLOCK_IN')]
    const b = await board(at('20:20'))
    assert.equal(person(b, '10:00')?.status, 'ARRIVED')
    assert.equal(b.missingOut, 0)
  })

  it('4 非調鋪更：第三間店 C 嘅落班卡唔會當成 A 店落班卡 → MISSING_OUT；punch 查詢 clinicIds=[A]', async () => {
    shifts = [mkShift('sh1', 'e1', '10:00', '17:00')] // 無 secondary
    punches = [
      mkPunch('p1', 'e1', cA, '10:00', 'CLOCK_IN'),
      mkPunch('p2', 'e1', cC, '17:30', 'CLOCK_OUT'),
    ]
    const b = await board(at('18:00'))
    assert.equal(person(b, '10:00')?.status, 'MISSING_OUT')
    // getEffectivePunches 收到嘅 clinicIds 只有 [A] → C 店張卡根本攞唔到
    const w = punchFindWheres[punchFindWheres.length - 1]
    assert.ok(typeof w.clinicId === 'object' && Array.isArray(w.clinicId.in), 'clinicIds 形態（{ in }），唔係單店 string')
    assert.deepEqual([...w.clinicId.in].sort(), [cA])
  })

  it('5 同店分更 10–14 / 16–20：10:00 入 14:00 出，now=16:30 → 第一更 LEFT、第二更 NOT_ARRIVED', async () => {
    shifts = [mkShift('sh1', 'e1', '10:00', '14:00'), mkShift('sh2', 'e1', '16:00', '20:00')]
    punches = [mkPunch('p1', 'e1', cA, '10:00', 'CLOCK_IN'), mkPunch('p2', 'e1', cA, '14:00', 'CLOCK_OUT')]
    const b = await board(at('16:30'))
    assert.equal(person(b, '10:00')?.status, 'LEFT')
    // 舊代碼逐張更單獨 match：第二更會攞到 10:00 嗰張上班卡 → 錯判 ARRIVED
    assert.equal(person(b, '16:00')?.status, 'NOT_ARRIVED')
  })

  it('6 調鋪 A→B：上班卡本身就喺 B 店打（A 店冇卡）→ 照樣認到上班卡', async () => {
    shifts = [mkShift('sh1', 'e1', '10:00', '20:00', cB)]
    punches = [mkPunch('p1', 'e1', cB, '10:00', 'CLOCK_IN'), mkPunch('p2', 'e1', cB, '20:00', 'CLOCK_OUT')]
    const b = await board(at('21:00'))
    assert.equal(person(b, '10:00')?.status, 'LEFT')
    assert.equal(b.missingOut, 0)
  })

  it('7 getEffectivePunches 參數：調鋪 = clinicIds [A,B]、無 clinicId string', async () => {
    shifts = [mkShift('sh1', 'e1', '10:00', '20:00', cB)]
    punches = [mkPunch('p1', 'e1', cA, '10:00', 'CLOCK_IN'), mkPunch('p2', 'e1', cB, '20:05', 'CLOCK_OUT')]
    await board(at('21:00'))
    assert.equal(punchFindWheres.length, 1)
    const w = punchFindWheres[0]
    // getEffectivePunches 將 clinicIds 轉做 where.clinicId = { in: [...] }（punch-query.ts L51-52）
    assert.ok(typeof w.clinicId === 'object' && Array.isArray(w.clinicId.in))
    assert.deepEqual([...w.clinicId.in].sort(), [cA, cB])
    assert.ok(!Array.isArray(w.employeeId) || w.employeeId.in.length === 1)
  })
})
