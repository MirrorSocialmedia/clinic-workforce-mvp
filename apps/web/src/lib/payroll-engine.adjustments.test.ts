/**
 * ★★★ cwm-payadj-20261017 ②：計糧調整（MPF 前／MPF 後）— 引擎測試（mock db，同現有 engine test 寫法）
 * 跑法: npx tsx --test src/lib/payroll-engine.adjustments.test.ts
 *
 * 覆蓋 MD §2.7 全部 case：
 *  1. 圖示例子：15,000 + 500 + 500(前) − 800 − 1,000(後) + 120 = 14,320.00
 *  2. MPF 上限：月入 29,800 + 500(前) → MPF 封頂 1,500；+500(後) → MPF 唔變
 *  3. MPF 最低入息 7,100：7,000 + 200(前) → 開始扣；+200(後) → 唔扣
 *  4. eoWage：包 MPF 前、唔包 MPF 後
 *  5. 有 OT 嘅月薪員工（行 OT 重算區）：調整冇消失（最重要迴歸）
 *  6. 時薪：MPF 前入 eoWage；MPF 後唔入；MPF 恆 0
 *  7. 負數：−20,000(後) → netClamped
 *  8. 對帳 guard 唔 warn（spy console.warn）
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from './prisma'
import { calculatePayrollWithRules } from './payroll-engine'
import { adjHashOf } from './payroll/adjustments'

const EMP = 'emp-payadj-test'
const MONTH = new Date(Date.UTC(2026, 7, 15)) // 2026-08（HK）
const YM = '2026-08'

// ---- mock db（proxy — 未覆寫嘅 delegate 全部回空/null）-----------------------
type Any = any
const emptyDelegate: Any = new Proxy(function () { }, {
  get(_t, prop: string | symbol) {
    if (typeof prop === 'symbol') return undefined
    if (prop === 'count') return async () => 0
    if (prop === 'findFirst' || prop === 'findUnique') return async () => null
    if (prop === 'findMany') return async () => []
    if (prop === 'aggregate') return async () => ({ _count: 0, _avg: {}, _sum: {} })
    if (prop === 'groupBy') return async () => []
    if (prop === 'upsert') return async () => ({})
    return async () => ({})
  },
})
const overrides: Record<string, Any> = {}
const fakePrisma: Any = new Proxy({}, {
  get(_t, prop: string | symbol) {
    if (typeof prop === 'symbol') return undefined
    if (prop === '$transaction') return async (fn: Any) => fn(fakePrisma)
    if (prop === '$queryRaw' || prop === '$executeRaw') return async () => []
    if (!(prop in overrides)) overrides[prop] = emptyDelegate
    return overrides[prop]
  },
})

// ---- 場景 state ----------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0')
// ★ P()：香港牆鐘 → UTC instant（HKT = UTC+8）
const P = (day: number, h: number, m = 0): Date => new Date(Date.UTC(2026, 7, day, h, m) - 8 * 3600 * 1000)

let _pid = 0
const punch = (day: number, type: string, h: number, m = 0) => ({
  id: `p${++_pid}`, employeeId: EMP, clinicId: 'c1', punchType: type, punchTime: P(day, h, m), void: null,
})
const mkShift = (day: number) => ({
  id: `s-${day}`, employeeId: EMP, clinicId: 'c1', secondaryClinicId: null,
  date: new Date(`2026-08-${pad(day)}T00:00:00.000Z`),
  startTime: new Date(`2026-08-${pad(day)}T01:00:00.000Z`), // 09:00 HKT
  endTime: new Date(`2026-08-${pad(day)}T10:00:00.000Z`),   // 18:00 HKT
  status: 'SCHEDULED', template: null,
})

const state: { adj: Any[]; misc: Any[]; shifts: Any[]; punches: Any[] } = { adj: [], misc: [], shifts: [], punches: [] }
const saved: Record<string, Any> = {}

const setAdj = (rows: Array<{ amount: number; mpfTiming: 'PRE_MPF' | 'POST_MPF' }>) => {
  state.adj = rows.map((r, i) => ({
    id: `adja${i}0000000000000000001`,
    employeeId: EMP, periodMonth: YM, amount: String(r.amount), mpfTiming: r.mpfTiming, reason: `調${i}`,
  }))
}

before(() => {
  overrides.employee = {
    findUnique: async () => ({ id: EMP, name: '測試', joinDate: null, resignedAt: null, clinics: [], user: { name: '測試' } }),
  }
  overrides.payRule = {
    findFirst: async () => ({
      id: 'rule-test', employeeId: EMP, isActive: true,
      configJson: {
        base_type: 'monthly',
        modifiers: {
          lunch_break: { enabled: true, defaultMinutes: 60, minMinutes: 30 },
          overtime: { ot_min_minutes: 0, ot_round_minutes: 0 },
        },
      },
    }),
  }
  overrides.shift = { findMany: async () => state.shifts }
  overrides.punchRecord = { findMany: async () => state.punches, findFirst: async () => null }
  overrides.punchCorrection = { findMany: async () => [] }
  overrides.hKPublicHoliday = { findMany: async () => [], count: async () => 0 }
  overrides.leaveRequest = { findMany: async () => [] }
  overrides.timeBank = { findFirst: async () => null, upsert: async () => ({}) }
  overrides.timeBankEntry = { findMany: async () => [], findFirst: async () => null }
  overrides.expenseEntry = { findMany: async () => state.misc }
  overrides.consultationRevenue = { findFirst: async () => null }
  overrides.resignSettlement = { findFirst: async () => null }
  overrides.payrollRun = { findUnique: async () => null, findFirst: async () => null }
  overrides.payrollItem = { findUnique: async () => null, findFirst: async () => null }
  overrides.lunchDeductOverride = { findFirst: async () => null, findMany: async () => [] }
  // ★ 被測主體：計糧調整
  // ⚠️ 必跟住 where.periodMonth 過濾 — 否則 engine 用錯月份 key（例如 0-based month 拼）都假綠
  overrides.payrollAdjustment = { findMany: async (w?: any) => (w?.where?.periodMonth === YM ? state.adj : []) }

  for (const k of Object.keys(overrides)) {
    saved[k] = (prisma as Any)[k]
    Object.defineProperty(prisma, k, { value: overrides[k], configurable: true, writable: true })
  }
})

after(() => {
  for (const k of Object.keys(saved)) {
    Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
  }
})

// ---- config ---------------------------------------------------------------------
const monthlyCfg = (salary: number, o: { bonus?: number; otThreshold?: number } = {}): Any => ({
  base_type: 'monthly',
  monthly_salary: salary,
  deduction_rate: 1,
  mpf: { enabled: true, min: 7100, max: 30000, rate: 0.05 },
  ot_threshold: o.otThreshold ?? 160,
  ot_multiplier: 1.5,
  modifiers: {
    lunch_break: { enabled: true, defaultMinutes: 60, minMinutes: 30 },
    ...(o.bonus != null ? { attendance_bonus: { amount: o.bonus } } : {}),
    overtime: { mode: 'pay' },
  },
})

/** 一個乾淨工日（09:00–18:00；out 可遲 — 製造 OT） */
const cleanDay = (outH: number, outM = 0) => {
  _pid = 0
  state.shifts = [mkShift(3)]
  state.punches = [punch(3, 'CLOCK_IN', 9, 0), punch(3, 'CLOCK_OUT', outH, outM)]
}

const runM = (salary: number, adj: Array<{ amount: number; mpfTiming: 'PRE_MPF' | 'POST_MPF' }>,
  o: { bonus?: number; misc?: number; outH?: number; otThreshold?: number } = {}) => {
  setAdj(adj)
  state.misc = o.misc ? [{ amount: o.misc, description: 'misc' }] : []
  cleanDay(o.outH ?? 18)
  return calculatePayrollWithRules(EMP, MONTH, null, monthlyCfg(salary, { bonus: o.bonus, otThreshold: o.otThreshold }), {})
}

const d = (r: Any) => r.detail

describe('② 計糧調整 — 月薪', () => {
  it('1. 圖示例子：15,000 + 500(勤工) + 500(前) = 16,000；MPF 800；−1,000(後)；+120 雜項 → 14,320.00', async () => {
    const r = await runM(15000, [{ amount: 500, mpfTiming: 'PRE_MPF' }, { amount: -1000, mpfTiming: 'POST_MPF' }], { bonus: 500, misc: 120 })
    assert.equal(d(r).grossPay, 16000, '總薪酬 16,000')
    assert.equal(d(r).mpf, 800, '強積金 800')
    assert.equal(d(r).netPay, 14200, 'MPF 後 −1,000 → 14,200')
    assert.equal(r.totalPayable, 14320, '★ 實發 14,320.00（+120 雜項）')
    assert.equal(d(r).adjPreMpf, 500)
    assert.equal(d(r).adjPostMpf, -1000)
    assert.equal(d(r).adjustments.length, 2)
    assert.equal(d(r).adjHash, adjHashOf([
      { id: 'adja00000000000000000001', amount: 500, mpfTiming: 'PRE_MPF', reason: '調0' },
      { id: 'adja10000000000000000001', amount: -1000, mpfTiming: 'POST_MPF', reason: '調1' },
    ]), 'adjHash 落 detail（stale 偵測用）')
  })

  it('2a. MPF 上限：29,800 無調整 → MPF 1,490（未封頂）', async () => {
    const r = await runM(29800, [])
    assert.equal(d(r).mpf, 1490)
  })

  it('2b. MPF 上限：29,800 + 500(前) → gross 30,300 → MPF 封頂 1,500', async () => {
    const r = await runM(29800, [{ amount: 500, mpfTiming: 'PRE_MPF' }])
    assert.equal(d(r).grossPay, 30300)
    assert.equal(d(r).mpf, 1500, 'MPF 封頂 1,500')
  })

  it('2c. MPF 上限：再 + 500(後) → MPF 唔變（1,500）；淨額 +500', async () => {
    const r0 = await runM(29800, [{ amount: 500, mpfTiming: 'PRE_MPF' }])
    const r = await runM(29800, [{ amount: 500, mpfTiming: 'PRE_MPF' }, { amount: 500, mpfTiming: 'POST_MPF' }])
    assert.equal(d(r).mpf, d(r0).mpf, 'MPF 唔變')
    assert.equal(d(r).mpf, 1500)
    assert.equal(d(r).grossPay, d(r0).grossPay, 'MPF 後唔入 gross')
    assert.equal(d(r).netPay, d(r0).netPay + 500, '淨額 +500')
  })

  it('3a. MPF 最低入息 7,100：7,000 無調整 → 唔扣', async () => {
    const r = await runM(7000, [])
    assert.equal(d(r).mpf, 0)
  })

  it('3b. 7,000 + 200(前) → gross 7,200 ≥ 7,100 → 開始扣 360', async () => {
    const r = await runM(7000, [{ amount: 200, mpfTiming: 'PRE_MPF' }])
    assert.equal(d(r).grossPay, 7200)
    assert.equal(d(r).mpf, 360, '開始扣 MPF')
  })

  it('3c. 7,000 + 200(後) → gross 7,000 < 7,100 → 唔扣；淨額 +200', async () => {
    const r = await runM(7000, [{ amount: 200, mpfTiming: 'POST_MPF' }])
    assert.equal(d(r).grossPay, 7000)
    assert.equal(d(r).mpf, 0, 'MPF 後唔計入息 → 唔扣')
    assert.equal(d(r).netPay, 7200)
  })

  it('4. eoWage：包 MPF 前、唔包 MPF 後', async () => {
    const r0 = await runM(15000, [])
    const r = await runM(15000, [{ amount: 500, mpfTiming: 'PRE_MPF' }, { amount: 1000, mpfTiming: 'POST_MPF' }])
    assert.equal((d(r) as Any).eoWage, (d(r0) as Any).eoWage + 500, 'eoWage = 無調整 + 500（只包 PRE）')
    assert.notEqual((d(r) as Any).eoWage, (d(r0) as Any).eoWage + 1500, '唔包 POST')
  })
})

describe('② 計糧調整 — 時薪', () => {
  const hourlyCfg: Any = {
    base_type: 'hourly',
    hourly_rate: 100,
    mpf: { enabled: true, min: 7100, max: 30000, rate: 0.05 },
    modifiers: { lunch_break: { enabled: true, defaultMinutes: 60, minMinutes: 30 } },
  }
  const runH = (adj: Array<{ amount: number; mpfTiming: 'PRE_MPF' | 'POST_MPF' }>) => {
    setAdj(adj)
    state.misc = []
    cleanDay(18)
    return calculatePayrollWithRules(EMP, MONTH, null, hourlyCfg, {})
  }

  it('6. MPF 前入 eoWage；MPF 後唔入；MPF 恆 0', async () => {
    const r0 = await runH([])
    const rPre = await runH([{ amount: 500, mpfTiming: 'PRE_MPF' }])
    const rPost = await runH([{ amount: 1000, mpfTiming: 'POST_MPF' }])
    assert.equal(d(r0).mpf, 0, '時薪 MPF = 0')
    assert.equal(d(rPre).mpf, 0)
    assert.equal(d(rPost).mpf, 0)
    assert.equal(d(rPre).grossPay, d(r0).grossPay + 500, 'MPF 前入 gross')
    assert.equal((d(rPre) as Any).eoWage, (d(r0) as Any).eoWage + 500, 'MPF 前入 eoWage')
    assert.equal(d(rPost).grossPay, d(r0).grossPay, 'MPF 後唔入 gross')
    assert.equal((d(rPost) as Any).eoWage, (d(r0) as Any).eoWage, 'MPF 後唔入 eoWage')
    assert.equal(d(rPost).netPay, d(r0).netPay + 1000, 'MPF 後加落淨額')
  })
})

describe('② 計糧調整 — OT 重算區迴歸（最重要）', () => {
  it('5. 有 OT 嘅月薪員工：調整（前+後）冇消失 — OT 重算覆寫 netPay 都包 + adjPost', async () => {
    // 基線（無調整）
    // ⚠️ otThreshold: 8 — 單日 fixture 做 10 小時（09:00–20:00 扣午膳），OT 門檻制要超過門檻先有 OT
    const r0 = await runM(15000, [], { bonus: 500, outH: 20, otThreshold: 8 }) // 18:00 後做 2 小時 → OT
    assert.ok(d(r0).otHours > 0, `fixture 必須真係有 OT（otHours=${d(r0).otHours}）— 否則呢個 test 冇行 OT 重算區`)
    // 有調整（前 +500、後 −1,000）
    const r = await runM(15000, [{ amount: 500, mpfTiming: 'PRE_MPF' }, { amount: -1000, mpfTiming: 'POST_MPF' }], { bonus: 500, outH: 20, otThreshold: 8 })

    assert.equal(d(r).adjPreMpf, 500, 'PRE 仲喺 detail')
    assert.equal(d(r).adjPostMpf, -1000, 'POST 仲喺 detail')

    // PRE 必入 gross（OT 重算用 detail.grossPay 做 base）
    assert.equal(d(r).grossPay, d(r0).grossPay + 500, 'OT 重算後 gross = 基線 + 500（PRE）')
    // MPF 跟新 gross
    assert.equal(d(r).mpf, Math.round(d(r).grossPay * 0.05 * 100) / 100, 'OT 重算後 MPF = 5% 新 gross')
    // ★ 生死點：net = gross − mpf − 1,000（POST 冇消失）
    const expectedNet = Math.round((d(r).grossPay - d(r).mpf - 1000) * 100) / 100
    assert.equal(d(r).netPay, expectedNet, 'OT 重算區 netPay 包 + adjPost')
    assert.equal(r.totalPayable, expectedNet, 'totalPayable 同步')
  })
})

describe('② 計糧調整 — 邊界', () => {
  it('7. 負數：−20,000(後) → netClamped（淨額歸零）', async () => {
    const r = await runM(15000, [{ amount: -20000, mpfTiming: 'POST_MPF' }])
    assert.equal(d(r).netPay, 0, 'netPay clamp 到 0')
    assert.equal(r.totalPayable, 0)
    assert.equal(d(r).netClamped, true, 'netClamped 標記')
  })
})

describe('② 計糧調整 — 對帳 guard', () => {
  it('8. 有調整（前+後）+ OT — 逐項對帳 guard 唔 warn', async () => {
    const warns: string[] = []
    const orig = console.warn
    console.warn = (...a: any[]) => { warns.push(a.join(' ')) }
    try {
      await runM(15000, [{ amount: 500, mpfTiming: 'PRE_MPF' }, { amount: -1000, mpfTiming: 'POST_MPF' }], { bonus: 500, misc: 120, outH: 20 })
    } finally {
      console.warn = orig
    }
    const mismatch = warns.filter(w => w.includes('逐項加總對唔上'))
    assert.equal(mismatch.length, 0, `對帳 guard 唔應該 warn：${mismatch.join(' | ')}`)
  })
})
