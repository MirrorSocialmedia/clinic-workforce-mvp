/**
 * ★ cwm-attbatch-20260927：早退批量補鐘 route 測試（spec §8.1 — 17 case）
 * 跑法: npx tsx --test src/lib/timebank-makeup-batch-route.test.ts
 * 寫法跟 pl-mark-route.test.ts（fake prisma、createToken、直接 import route POST）
 *
 * 覆蓋：
 *   1  401 無 session
 *   2  403 冇 timebank_ops（零寫入）
 *   3  items 201 筆 → 400
 *   4  重複 (employeeId, date) → 400
 *   5  dryRun=false 冇 reason → 400
 *   6  正常 3 筆 → 3×SUCCESS + 3×TIMEBANK_MAKEUP + 1×TIMEBANK_MAKEUP_BATCH + 每員工 invalidate 一次
 *   7  其中 1 筆已有補鐘紀錄 → SKIPPED，其他照成功
 *   8  create 撞 P2002（race）→ SKIPPED
 *   9  1 筆計糧已鎖 → FAILED PAYROLL_LOCKED，其他成功
 *   10 重算 actual=0 → FAILED NO_EARLY_LEAVE，冇寫入
 *   11 重算 actual≠minutes → FAILED STALE，回傳 actualMinutes
 *   12 搵唔到更 → FAILED NO_SHIFT
 *   13 時薪員工 → FAILED HOURLY
 *   14 lock busy (55P03) → FAILED BUSY
 *   15 dry-run 全流程 → 零 create（timeBankEntry、auditLog 都冇）；計糧鎖用唯讀 helper
 *   16 同一 request 送兩次 → 第二次全部 SKIPPED
 *   17 寫入時 audit create 失敗 → 該筆 rollback，冇補鐘紀錄
 *   18 flagIfSelfEdit 寫 audit 時 throw（cwm-attfix-20260927 C.1）→ 仍然 200、summary.success 正確、有 TIMEBANK_MAKEUP_BATCH
 *   19 第 1 筆 BUSY 後，同一員工第 2 筆唔會再 call lockEmployee，直接 BUSY（cwm-attfix-20260927 C.2）
 *   20 超過 BATCH_DEADLINE_MS → 之後嘅項目 NOT_PROCESSED，唔會 call lockEmployee（cwm-deployguard-20260928 P3-3）
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { prisma, basePrisma } from './prisma'
import { createToken } from './auth'
import { POST } from '../app/api/timebank/makeup/batch/route'
import { toHKDateStr } from './hk-date'
import { BATCH_DEADLINE_MS } from './timebank-makeup'

type Any = any

// ---- fake state ----------------------------------------------------------------
interface EntryRec { id: string; employeeId: string; type: string; targetType: string | null; date: Date; minutes: number; note?: string }
interface Fresh {
  seq: number
  users: Record<string, Any>
  employees: Record<string, Any>
  userToEmployee: Record<string, string>
  payRules: Record<string, Any[]>
  shifts: Record<string, Any>
  punches: Array<{ id: string; employeeId: string; punchTime: Date; punchType: string }>
  existingMakeups: EntryRec[]
  lockedRuns: Array<{ id: string; status: string; periodMonth: Date; employees: string[] }>
  committed: Array<{ kind: string; rec: Any }>
  buffered: Array<{ kind: string; rec: Any }>
  basePrismaAudit: Any[]
  callLog: string[]
  invalidateCalls: string[]
  lockCalls: string[]
  busyEmps: Set<string>
  p2002: Set<string>
  failAudit: boolean
  failSelfEditAudit: boolean
}

const fresh = (): Fresh => ({
  seq: 0,
  users: {},
  employees: {},
  userToEmployee: {},
  payRules: {},
  shifts: {},
  punches: [],
  existingMakeups: [],
  lockedRuns: [],
  committed: [],
  buffered: [],
  basePrismaAudit: [],
  callLog: [],
  invalidateCalls: [],
  lockCalls: [],
  busyEmps: new Set(),
  p2002: new Set(),
  failAudit: false,
  failSelfEditAudit: false,
})

let state: Fresh = fresh()

function addShift(empId: string, dateStr: string, opts: { start?: string; end?: string; clockOut?: string | null } = {}) {
  const { start = '09:00', end = '17:00', clockOut = '16:30' } = opts
  // 預設 = 早退 30 分鐘（16:30 落 vs 17:00 收工）
  state.shifts[`${empId}|${dateStr}`] = {
    id: `sh-${empId}-${dateStr}`,
    employeeId: empId,
    date: new Date(`${dateStr}T00:00:00+08:00`),
    startTime: new Date(`${dateStr}T${start}:00+08:00`),
    endTime: new Date(`${dateStr}T${end}:00+08:00`),
    status: 'CONFIRMED',
  }
  if (clockOut) {
    state.punches.push({ id: `p-out-${empId}-${dateStr}`, employeeId: empId, punchTime: new Date(`${dateStr}T${clockOut}:00+08:00`), punchType: 'CLOCK_OUT' })
  }
}

function seedMakeup(empId: string, dateStr: string, targetType = 'EARLY_LEAVE') {
  state.existingMakeups.push({
    id: `seed-${empId}-${dateStr}`, employeeId: empId, type: 'MAKEUP', targetType,
    date: new Date(dateStr), minutes: -30, note: 'seed',
  })
}

function seedLocked(empId: string, ym: string, status = 'FINALIZED') {
  state.lockedRuns.push({
    id: `run-${empId}-${ym}`, status,
    periodMonth: new Date(`${ym}-01T00:00:00+08:00`),
    employees: [empId],
  })
}

function allEntries(): EntryRec[] {
  return [
    ...state.existingMakeups,
    ...state.committed.filter(c => c.kind === 'timeBankEntry').map(c => c.rec as EntryRec),
    ...state.buffered.filter(c => c.kind === 'timeBankEntry').map(c => c.rec as EntryRec),
  ]
}

function findEntry(where: Any, includeBuffered: boolean): EntryRec | null {
  const pool: EntryRec[] = [
    ...state.existingMakeups,
    ...state.committed.filter(c => c.kind === 'timeBankEntry').map(c => c.rec as EntryRec),
    ...(includeBuffered ? state.buffered.filter(c => c.kind === 'timeBankEntry').map(c => c.rec as EntryRec) : []),
  ]
  return pool.find(e =>
    e.employeeId === where?.employeeId &&
    (!where?.type || e.type === where.type) &&
    (where?.targetType === undefined ? true : e.targetType === where.targetType) &&
    (!where?.date || (e.date.getTime() >= where.date.gte.getTime() && e.date.getTime() <= where.date.lte.getTime()))
  ) ?? null
}

// ---- fake models ----------------------------------------------------------------
const shiftFor = (where: Any) => {
  const empId = where?.employeeId
  const dateStr = where?.date ? toHKDateStr(where.date) : null
  const sh = dateStr ? state.shifts[`${empId}|${dateStr}`] : null
  if (!sh) return null
  if (where?.status?.not && sh.status === where.status.not) return null
  return sh
}

const punchesFor = (where: Any) =>
  state.punches
    .filter(p =>
      p.employeeId === where?.employeeId &&
      p.punchTime.getTime() >= where?.punchTime?.gte?.getTime() &&
      p.punchTime.getTime() <= where?.punchTime?.lte?.getTime())
    .map(p => ({ id: p.id, employeeId: p.employeeId, punchTime: p.punchTime, punchType: p.punchType, clinicId: 'c1', void: null }))

const fakes: Record<string, Any> = {
  user: {
    findUnique: async (args: Any) => state.users[args?.where?.id] ?? null,
  },
  employee: {
    findMany: async (args: Any) => (args?.where?.id?.in ?? []).map((id: string) => state.employees[id]).filter(Boolean),
    findUnique: async (args: Any) =>
      args?.where?.userId
        ? (state.userToEmployee[args.where.userId] ? { id: state.userToEmployee[args.where.userId] } : null)
        : (state.employees[args?.where?.id] ?? null),
  },
  payRule: {
    findFirst: async (args: Any) => {
      const w = args?.where ?? {}
      const effToGte = w.OR?.find((o: Any) => o?.effectiveTo?.gte)?.effectiveTo
      const r = (state.payRules[w.employeeId] ?? [])
        .filter((x: Any) => x.effectiveFrom.getTime() <= w.effectiveFrom?.lte?.getTime())
        .filter((x: Any) => x.effectiveTo === null || (effToGte && x.effectiveTo.getTime() >= effToGte.getTime()))
        .sort((a: Any, b: Any) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || b.createdAt - a.createdAt)
        [0]
      return r ? { configJson: r.configJson } : null
    },
  },
  shift: { findFirst: async (args: Any) => shiftFor(args?.where) },
  punchRecord: { findMany: async (args: Any) => punchesFor(args?.where) },
  punchCorrection: { findMany: async () => [] },
  timeBankEntry: {
    findFirst: async (args: Any) => findEntry(args?.where, false),
    aggregate: async (args: Any) => ({
      _sum: { minutes: allEntries().filter(e => e.employeeId === args?.where?.employeeId).reduce((s, e) => s + e.minutes, 0) },
    }),
  },
  payrollRun: {
    findMany: async (args: Any) => {
      state.callLog.push('prisma.payrollRun.findMany')
      const w = args?.where ?? {}
      const monthTimes = (w.periodMonth?.in ?? []).map((d: Date) => d.getTime())
      const someEmp = w.items?.some?.employeeId
      return state.lockedRuns.filter(r =>
        monthTimes.includes(r.periodMonth.getTime()) &&
        (w.status?.in ?? []).includes(r.status) &&
        (someEmp ? r.employees.includes(someEmp) : true))
    },
  },
  auditLog: {
    create: async (args: Any) => {
      state.callLog.push(`prisma.auditLog.create:${args.data.action}`)
      // case 18：flagIfSelfEdit 寫 SELF_BALANCE_EDIT 時 throw（只限呢個 action，批次總結 audit 照寫）
      if (state.failSelfEditAudit && args.data.action === 'SELF_BALANCE_EDIT') throw new Error('self-edit audit boom')
      state.committed.push({ kind: 'auditLog', rec: args.data })
      return { id: `al-${++state.seq}` }
    },
  },
  // invalidateTimeBankFrom(empId, date, prisma) 用 tagged template：(strings, employeeId, monthStartISO)
  $executeRaw: async (_tpl: Any, ...vals: Any[]) => {
    state.invalidateCalls.push(vals[0] ?? '?')
    return 0
  },
  // $transaction 透傳 + commit/rollback 語義：fn 成功 → buffered 入 committed；throw → buffered 清空
  $transaction: async (fn: Any) => {
    state.buffered = []
    try {
      const r = await fn(fakeTx)
      state.committed.push(...state.buffered)
      return r
    } catch (e) {
      state.buffered = [] // rollback
      throw e
    }
  },
}

const fakeTx: Any = {
  // tagged template：(strings, ...values)；advisory lock 嘅 value = 'emp:<id>'
  $executeRaw: async (_tpl: Any, ...vals: Any[]) => {
    const lockVal = vals.find((v: Any) => typeof v === 'string' && v.startsWith('emp:'))
    if (lockVal) {
      state.lockCalls.push(lockVal) // case 19：計 lockEmployee 實際試咗幾多次
      if (state.busyEmps.has(lockVal.slice(4))) {
        const e: Any = new Error('canceling statement due to lock timeout (SQLSTATE 55P03)')
        e.code = '55P03'
        throw e
      }
    }
    return 0
  },
  // assertMonthsUnlockedTx：tagged template values = (employeeId, pms[])
  $queryRaw: async (_tpl: Any, ...vals: Any[]) => {
    const empId: string = vals[0]
    const pms: string[] = vals[1] ?? []
    const lockedYms = [...new Set(
      state.lockedRuns
        .filter(r => r.employees.includes(empId) && (r.status === 'FINALIZED' || r.status === 'EXPORTED'))
        .map(r => toHKDateStr(r.periodMonth).slice(0, 7)),
    )].filter(ym => pms.includes(ym))
    return lockedYms.map(ym => ({ id: `run-${empId}-${ym}`, status: 'FINALIZED', ym }))
  },
  timeBankEntry: {
    findFirst: async (args: Any) => findEntry(args?.where, true),
    create: async (args: Any) => {
      const d = args.data
      const k = `${d.employeeId}|${toHKDateStr(d.date)}`
      if (state.p2002.has(k)) {
        const e: Any = new Error('Unique constraint failed')
        e.code = 'P2002'
        throw e
      }
      const rec = { id: `tbe-${++state.seq}`, ...d }
      state.buffered.push({ kind: 'timeBankEntry', rec })
      state.callLog.push('tx.timeBankEntry.create')
      return rec
    },
    aggregate: async (args: Any) => ({
      _sum: { minutes: allEntries().filter(e => e.employeeId === args?.where?.employeeId).reduce((s, e) => s + e.minutes, 0) },
    }),
  },
  auditLog: {
    create: async (args: Any) => {
      state.callLog.push(`tx.auditLog.create:${args.data.action}`)
      if (state.failAudit) throw new Error('audit write boom')
      state.buffered.push({ kind: 'auditLog', rec: args.data })
      return { id: `al-${++state.seq}` }
    },
  },
  shift: { findFirst: async (args: Any) => shiftFor(args?.where) },
  punchRecord: { findMany: async (args: Any) => punchesFor(args?.where) },
  punchCorrection: { findMany: async () => [] },
}

const saved: Record<string, Any> = {}
before(() => {
  for (const k of Object.keys(fakes)) {
    saved[k] = (prisma as Any)[k]
    Object.defineProperty(prisma, k, { value: fakes[k], configurable: true, writable: true })
  }
  saved.baseAuditLog = (basePrisma as Any).auditLog
  Object.defineProperty(basePrisma, 'auditLog', {
    value: {
      create: async (args: Any) => {
        state.basePrismaAudit.push(args.data)
        return { id: `ba-${++state.seq}` }
      },
    },
    configurable: true, writable: true,
  })
})
after(() => {
  for (const k of Object.keys(fakes)) {
    Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
  }
  Object.defineProperty(basePrisma, 'auditLog', { value: saved.baseAuditLog, configurable: true, writable: true })
})
beforeEach(() => { state = fresh() })

// ---- 用戶 ------------------------------------------------------------------------
function addUser(userId: string, extra: Any = {}) {
  state.users[userId] = {
    tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null,
    clinics: [{ clinicId: 'c1' }],
    ...extra,
  }
}
function addEmployee(empId: string) { state.employees[empId] = { id: empId } }

const token = (userId: string, role: 'MANAGER' | 'OWNER' | 'EMPLOYEE') =>
  createToken({ userId, role, clinics: ['c1'], tokenVersion: 1 })

const makeReq = (tok: string | null, body: Any) =>
  new NextRequest('http://localhost/api/timebank/makeup/batch', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(tok ? { cookie: `session=${tok}` } : {}),
    },
    body: JSON.stringify(body),
  })

const item = (empId: string, date: string, minutes = 30) => ({ employeeId: empId, date, minutes })
const B = 'batch-test-1'

describe('timebank makeup batch route（cwm-attbatch-20260927 spec §8.1）', () => {
  it('1 401 無 session', async () => {
    addUser('u-manager'); addEmployee('emp1')
    const res = await POST(makeReq(null, { batchId: B, dryRun: true, items: [item('emp1', '2026-08-10')] }) as any)
    assert.equal(res.status, 401)
    assert.equal(state.committed.length, 0)
  })

  it('2 403 冇 timebank_ops（MANAGER deny）— 零寫入', async () => {
    addUser('u-manager-deny', { permissionsJson: JSON.stringify({ grant: [], deny: ['timebank_ops'] }) })
    addEmployee('emp1'); addShift('emp1', '2026-08-10')
    const res = await POST(makeReq(token('u-manager-deny', 'MANAGER'), { batchId: B, dryRun: false, reason: 'x', items: [item('emp1', '2026-08-10')] }) as any)
    assert.equal(res.status, 403)
    assert.match((await res.json()).error, /timebank_ops/)
    assert.equal(state.committed.length, 0)
    assert.equal(state.invalidateCalls.length, 0)
  })

  it('3 items 201 筆 → 400', async () => {
    addUser('u-manager')
    const items = Array.from({ length: 201 }, (_, i) => item(`emp${i}`, `2026-08-0${(i % 9) + 1}`, 10))
    const res = await POST(makeReq(token('u-manager', 'MANAGER'), { batchId: B, dryRun: true, items }) as any)
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /200/)
    assert.equal(state.committed.length, 0)
  })

  it('4 重複 (employeeId, date) → 400', async () => {
    addUser('u-manager'); addEmployee('emp1'); addShift('emp1', '2026-08-10')
    const res = await POST(makeReq(token('u-manager', 'MANAGER'), {
      batchId: B, dryRun: true, items: [item('emp1', '2026-08-10'), item('emp1', '2026-08-10')],
    }) as any)
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /重複/)
    assert.equal(state.committed.length, 0)
  })

  it('5 dryRun=false 冇 reason → 400', async () => {
    addUser('u-manager'); addEmployee('emp1'); addShift('emp1', '2026-08-10')
    const res = await POST(makeReq(token('u-manager', 'MANAGER'), { batchId: B, dryRun: false, items: [item('emp1', '2026-08-10')] }) as any)
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /原因/)
    assert.equal(state.committed.length, 0)
  })

  it('6 正常 3 筆 → 3×SUCCESS + 審計齊 + 每員工 invalidate 一次', async () => {
    addUser('u-manager')
    for (const [e, d] of [['emp1', '2026-08-10'], ['emp2', '2026-08-10'], ['emp3', '2026-08-11']] as const) {
      addEmployee(e); addShift(e, d)
    }
    const res = await POST(makeReq(token('u-manager', 'MANAGER'), {
      batchId: B, dryRun: false, reason: '2026-08 早退批量補鐘',
      items: [item('emp1', '2026-08-10'), item('emp2', '2026-08-10'), item('emp3', '2026-08-11')],
    }) as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.batchId, B)
    assert.equal(body.dryRun, false)
    assert.deepEqual(body.summary, { success: 3, skipped: 0, failed: 0 })
    assert.ok(body.results.every((r: Any) => r.status === 'SUCCESS'))

    const tbe = state.committed.filter(c => c.kind === 'timeBankEntry')
    assert.equal(tbe.length, 3)
    for (const e of tbe) {
      assert.equal(e.rec.type, 'MAKEUP')
      assert.equal(e.rec.targetType, 'EARLY_LEAVE')
      assert.equal(e.rec.minutes, -30)
      // unique index 口徑：UTC 午夜（makeupEntryDate）
      assert.equal(e.rec.date.toISOString(), `${toHKDateStr(e.rec.date)}T00:00:00.000Z`)
      assert.match(e.rec.note, /^補鐘：早退 30分$/)
      assert.equal(e.rec.createdBy, 'u-manager')
    }
    const mkAudits = state.committed.filter(c => c.kind === 'auditLog' && c.rec.action === 'TIMEBANK_MAKEUP')
    assert.equal(mkAudits.length, 3)
    const sample = mkAudits[0].rec
    assert.equal(sample.entity, 'TimeBank')
    assert.equal(sample.targetEmployeeId, sample.entityId)
    assert.deepEqual(JSON.parse(sample.notes), {
      delta: -30, date: '2026-08-10', reason: '2026-08 早退批量補鐘',
      targetType: 'EARLY_LEAVE', batchId: B, source: 'BATCH',
    })
    assert.equal(JSON.parse(sample.beforeJson).balanceMinutes, 0)
    assert.equal(JSON.parse(sample.afterJson).balanceMinutes, -30)
    const batchAudit = state.committed.find(c => c.kind === 'auditLog' && c.rec.action === 'TIMEBANK_MAKEUP_BATCH')
    assert.ok(batchAudit)
    assert.equal(batchAudit.rec.entityId, B)
    const batchNotes = JSON.parse(batchAudit.rec.notes)
    assert.equal(batchNotes.requested, 3)
    assert.deepEqual(batchNotes.failures, [])

    // invalidate：每個有成功嘅員工一次（最早成功日期）
    assert.deepEqual([...state.invalidateCalls].sort(), ['emp1', 'emp2', 'emp3'])
  })

  it('7 其中 1 筆已有補鐘紀錄 → SKIPPED，其他照成功', async () => {
    addUser('u-manager')
    addEmployee('emp1'); addShift('emp1', '2026-08-10'); seedMakeup('emp1', '2026-08-10')
    addEmployee('emp2'); addShift('emp2', '2026-08-10')
    const res = await POST(makeReq(token('u-manager', 'MANAGER'), {
      batchId: B, dryRun: false, reason: 'x', items: [item('emp1', '2026-08-10'), item('emp2', '2026-08-10')],
    }) as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.summary, { success: 1, skipped: 1, failed: 0 })
    const r1 = body.results.find((r: Any) => r.employeeId === 'emp1')
    assert.equal(r1.status, 'SKIPPED')
    assert.equal(body.results.find((r: Any) => r.employeeId === 'emp2').status, 'SUCCESS')
    assert.equal(state.committed.filter(c => c.kind === 'timeBankEntry').length, 1)
    assert.deepEqual(state.invalidateCalls, ['emp2'])
  })

  it('8 create 撞 P2002（模擬 race）→ SKIPPED，唔係 FAILED／500', async () => {
    addUser('u-manager'); addEmployee('emp1'); addShift('emp1', '2026-08-10')
    state.p2002.add('emp1|2026-08-10')
    const res = await POST(makeReq(token('u-manager', 'MANAGER'), {
      batchId: B, dryRun: false, reason: 'x', items: [item('emp1', '2026-08-10')],
    }) as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.results[0].status, 'SKIPPED')
    assert.equal(body.summary.failed, 0)
    assert.equal(state.committed.filter(c => c.kind === 'timeBankEntry').length, 0)
  })

  it('9 1 筆計糧已鎖 → FAILED PAYROLL_LOCKED，其他成功', async () => {
    addUser('u-manager')
    addEmployee('emp1'); addShift('emp1', '2026-08-10'); seedLocked('emp1', '2026-08')
    addEmployee('emp2'); addShift('emp2', '2026-08-10')
    const res = await POST(makeReq(token('u-manager', 'MANAGER'), {
      batchId: B, dryRun: false, reason: 'x', items: [item('emp1', '2026-08-10'), item('emp2', '2026-08-10')],
    }) as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    const r1 = body.results.find((r: Any) => r.employeeId === 'emp1')
    assert.equal(r1.status, 'FAILED')
    assert.equal(r1.code, 'PAYROLL_LOCKED')
    assert.match(r1.message, /2026-08/)
    assert.equal(body.results.find((r: Any) => r.employeeId === 'emp2').status, 'SUCCESS')
    // 寫入模式被擋 → 照寫 PAYROLL_LOCK_BLOCKED audit（assertMonthsUnlockedTx 自動）
    assert.equal(state.basePrismaAudit.filter(a => a.action === 'PAYROLL_LOCK_BLOCKED').length, 1)
  })

  it('10 重算 actual=0（17:00 準時落）→ FAILED NO_EARLY_LEAVE，冇寫入', async () => {
    addUser('u-manager'); addEmployee('emp1'); addShift('emp1', '2026-08-10', { clockOut: '17:00' })
    const res = await POST(makeReq(token('u-manager', 'MANAGER'), {
      batchId: B, dryRun: false, reason: 'x', items: [item('emp1', '2026-08-10')],
    }) as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.results[0].status, 'FAILED')
    assert.equal(body.results[0].code, 'NO_EARLY_LEAVE')
    assert.equal(state.committed.filter(c => c.kind === 'timeBankEntry').length, 0)
  })

  it('11 重算 actual(60) ≠ minutes(30) → FAILED STALE，回傳 actualMinutes', async () => {
    addUser('u-manager'); addEmployee('emp1'); addShift('emp1', '2026-08-10', { clockOut: '16:00' })
    const res = await POST(makeReq(token('u-manager', 'MANAGER'), {
      batchId: B, dryRun: false, reason: 'x', items: [item('emp1', '2026-08-10', 30)],
    }) as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.results[0].status, 'FAILED')
    assert.equal(body.results[0].code, 'STALE')
    assert.equal(body.results[0].actualMinutes, 60)
    assert.equal(state.committed.filter(c => c.kind === 'timeBankEntry').length, 0)
  })

  it('12 搵唔到更 → FAILED NO_SHIFT', async () => {
    addUser('u-manager'); addEmployee('emp1') // 無 shift
    const res = await POST(makeReq(token('u-manager', 'MANAGER'), {
      batchId: B, dryRun: false, reason: 'x', items: [item('emp1', '2026-08-10')],
    }) as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.results[0].status, 'FAILED')
    assert.equal(body.results[0].code, 'NO_SHIFT')
    assert.equal(state.committed.filter(c => c.kind === 'timeBankEntry').length, 0)
  })

  it('13 時薪員工 → FAILED HOURLY，冇寫入', async () => {
    addUser('u-manager'); addEmployee('emp1'); addShift('emp1', '2026-08-10')
    state.payRules['emp1'] = [{
      configJson: JSON.stringify({ base_type: 'hourly' }),
      effectiveFrom: new Date('2026-01-01T00:00:00+08:00'), effectiveTo: null, createdAt: 1,
    }]
    const res = await POST(makeReq(token('u-manager', 'MANAGER'), {
      batchId: B, dryRun: false, reason: 'x', items: [item('emp1', '2026-08-10')],
    }) as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.results[0].status, 'FAILED')
    assert.equal(body.results[0].code, 'HOURLY')
    // 冇補鐘紀錄、冇逐筆 audit（batch summary 照寫，属正常）
    assert.equal(state.committed.filter(c => c.kind === 'timeBankEntry').length, 0)
    assert.equal(state.committed.filter(c => c.kind === 'auditLog' && c.rec.action === 'TIMEBANK_MAKEUP').length, 0)
    assert.equal(state.invalidateCalls.length, 0)
  })

  it('14 lock busy（55P03）→ FAILED BUSY', async () => {
    addUser('u-manager'); addEmployee('emp1'); addShift('emp1', '2026-08-10')
    state.busyEmps.add('emp1')
    const res = await POST(makeReq(token('u-manager', 'MANAGER'), {
      batchId: B, dryRun: false, reason: 'x', items: [item('emp1', '2026-08-10')],
    }) as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.results[0].status, 'FAILED')
    assert.equal(body.results[0].code, 'BUSY')
    assert.equal(state.committed.filter(c => c.kind === 'timeBankEntry').length, 0)
  })

  it('15 dry-run 全流程 → 零 create（timeBankEntry、auditLog 都冇）；計糧鎖用唯讀 helper', async () => {
    addUser('u-manager')
    addEmployee('emp1'); addShift('emp1', '2026-08-10'); seedMakeup('emp1', '2026-08-10')
    addEmployee('emp2'); addShift('emp2', '2026-08-10'); seedLocked('emp2', '2026-08')
    addEmployee('emp3'); addShift('emp3', '2026-08-10', { clockOut: '17:00' })
    addEmployee('emp4'); addShift('emp4', '2026-08-10') // 正常 → WOULD_SUCCEED
    const res = await POST(makeReq(token('u-manager', 'MANAGER'), {
      batchId: B, dryRun: true,
      items: [item('emp1', '2026-08-10'), item('emp2', '2026-08-10'), item('emp3', '2026-08-10'), item('emp4', '2026-08-10')],
    }) as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.dryRun, true)
    const by = (emp: string) => body.results.find((r: Any) => r.employeeId === emp)
    assert.equal(by('emp1').status, 'SKIPPED')
    assert.equal(by('emp2').status, 'FAILED'); assert.equal(by('emp2').code, 'PAYROLL_LOCKED')
    assert.equal(by('emp3').status, 'FAILED'); assert.equal(by('emp3').code, 'NO_EARLY_LEAVE')
    assert.equal(by('emp4').status, 'WOULD_SUCCEED')
    assert.deepEqual(body.summary, { success: 1, skipped: 1, failed: 2 })

    // 零寫入：timeBankEntry create 零、auditLog create 零（tx 同 prisma 級都算）
    assert.equal(state.committed.length, 0)
    assert.ok(!state.callLog.some(c => c.includes('timeBankEntry.create')))
    assert.ok(!state.callLog.some(c => c.includes('auditLog.create')))
    // 計糧鎖走唯讀 helper（payrollRun.findMany），唔寫 PAYROLL_LOCK_BLOCKED
    assert.ok(state.callLog.includes('prisma.payrollRun.findMany'), 'dry-run 計糧鎖要行唯讀 helper')
    assert.ok(!state.callLog.includes('prisma.auditLog.create:TIMEBANK_MAKEUP_BATCH'))
    assert.equal(state.basePrismaAudit.length, 0)
    assert.equal(state.invalidateCalls.length, 0)
  })

  it('16 同一 request 送兩次 → 第二次全部 SKIPPED', async () => {
    addUser('u-manager'); addEmployee('emp1'); addShift('emp1', '2026-08-10')
    const payload = { batchId: B, dryRun: false, reason: 'x', items: [item('emp1', '2026-08-10')] }
    const r1 = await POST(makeReq(token('u-manager', 'MANAGER'), payload) as any)
    assert.equal(r1.status, 200)
    assert.equal((await r1.json()).results[0].status, 'SUCCESS')
    // 重送（例如 524 重試）—— 用新 batchId，同一筆
    const r2 = await POST(makeReq(token('u-manager', 'MANAGER'), { ...payload, batchId: 'batch-retry' }) as any)
    assert.equal(r2.status, 200)
    const b2 = await r2.json()
    assert.equal(b2.results[0].status, 'SKIPPED')
    assert.equal(b2.summary.failed, 0)
    // unique index 口徑：每人每日一筆 —— 只有 1 條補鐘紀錄
    assert.equal(state.committed.filter(c => c.kind === 'timeBankEntry').length, 1)
  })

  it('17 寫入時 audit create 失敗 → 該筆 rollback，冇補鐘紀錄', async () => {
    addUser('u-manager'); addEmployee('emp1'); addShift('emp1', '2026-08-10')
    state.failAudit = true
    const res = await POST(makeReq(token('u-manager', 'MANAGER'), {
      batchId: B, dryRun: false, reason: 'x', items: [item('emp1', '2026-08-10')],
    }) as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.results[0].status, 'FAILED')
    assert.equal(body.results[0].code, 'ERROR')
    // rollback：補鐘紀錄同 audit 一齊冇
    assert.equal(state.committed.filter(c => c.kind === 'timeBankEntry').length, 0)
    assert.equal(state.committed.filter(c => c.kind === 'auditLog' && c.rec.action === 'TIMEBANK_MAKEUP').length, 0)
    assert.equal(state.invalidateCalls.length, 0)
  })

  it('18 flagIfSelfEdit 寫 audit 時 throw → 仍然 200、summary.success 正確、有 TIMEBANK_MAKEUP_BATCH（cwm-attfix-20260927 C.1）', async () => {
    // actor 改自己：u-manager 嘅 employee = emp1
    addUser('u-manager'); state.userToEmployee['u-manager'] = 'emp1'
    addEmployee('emp1'); addShift('emp1', '2026-08-10')
    state.failSelfEditAudit = true
    const res = await POST(makeReq(token('u-manager', 'MANAGER'), {
      batchId: B, dryRun: false, reason: 'x', items: [item('emp1', '2026-08-10')],
    }) as any)
    // 審計寫失敗唔應該令已 commit 嘅批次回 500
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.results[0].status, 'SUCCESS')
    assert.deepEqual(body.summary, { success: 1, skipped: 0, failed: 0 })
    // 補鐘紀錄照寫、批次總結 audit 照寫
    assert.equal(state.committed.filter(c => c.kind === 'timeBankEntry').length, 1)
    assert.equal(state.committed.filter(c => c.kind === 'auditLog' && c.rec.action === 'TIMEBANK_MAKEUP').length, 1)
    const batchAudit = state.committed.find(c => c.kind === 'auditLog' && c.rec.action === 'TIMEBANK_MAKEUP_BATCH')
    assert.ok(batchAudit)
    // SELF_BALANCE_EDIT 本身冇寫到（throw 咗）
    assert.equal(state.committed.filter(c => c.kind === 'auditLog' && c.rec.action === 'SELF_BALANCE_EDIT').length, 0)
    assert.equal(state.invalidateCalls.length, 1)
  })

  it('19 第 1 筆 BUSY 後，同一員工第 2 筆唔會再 call lockEmployee，直接 BUSY（cwm-attfix-20260927 C.2）', async () => {
    addUser('u-manager')
    addEmployee('emp1'); addShift('emp1', '2026-08-10'); addShift('emp1', '2026-08-11')
    addEmployee('emp2'); addShift('emp2', '2026-08-10')
    state.busyEmps.add('emp1')
    const res = await POST(makeReq(token('u-manager', 'MANAGER'), {
      batchId: B, dryRun: false, reason: 'x',
      items: [item('emp1', '2026-08-10'), item('emp1', '2026-08-11'), item('emp2', '2026-08-10')],
    }) as any)
    assert.equal(res.status, 200)
    const body = await res.json()
    const byEmp1a = body.results.find((r: Any) => r.employeeId === 'emp1' && r.date === '2026-08-10')
    const byEmp1b = body.results.find((r: Any) => r.employeeId === 'emp1' && r.date === '2026-08-11')
    assert.equal(byEmp1a.status, 'FAILED'); assert.equal(byEmp1a.code, 'BUSY')
    // 第二筆：唔好再等 3s 鎖 —— 直接 BUSY
    assert.equal(byEmp1b.status, 'FAILED'); assert.equal(byEmp1b.code, 'BUSY')
    // lockEmployee 只實際試咗 1 次（emp1）；emp2 正常成功
    assert.deepEqual(state.lockCalls.filter(v => v === 'emp:emp1'), ['emp:emp1'])
    assert.deepEqual(state.lockCalls.filter(v => v === 'emp:emp2'), ['emp:emp2'])
    assert.equal(body.results.find((r: Any) => r.employeeId === 'emp2').status, 'SUCCESS')
    assert.deepEqual(body.summary, { success: 1, skipped: 0, failed: 2 })
  })

  it('20 超過 BATCH_DEADLINE_MS → 之後嘅項目 NOT_PROCESSED，唔會 call lockEmployee（cwm-deployguard-20260928 P3-3）', async () => {
    // 3 筆唔同員工；第 1 筆 entry create 之後先將 Date.now 推到 deadline 之後
    //（唔用呼叫次數計數推時間：requireAuth 嘅 jwt 驗證路徑可能亦有 Date.now，計數脆）
    addUser('u-manager')
    for (const [e, d] of [['emp1', '2026-08-10'], ['emp2', '2026-08-10'], ['emp3', '2026-08-11']] as const) {
      addEmployee(e); addShift(e, d)
    }
    const realNow = Date.now
    let advanced = false
    const realCreate = fakeTx.timeBankEntry.create
    fakeTx.timeBankEntry.create = async (args: Any) => {
      advanced = true
      return realCreate(args)
    }
    Date.now = () => realNow() + (advanced ? BATCH_DEADLINE_MS + 1_000 : 0)
    try {
      const res = await POST(makeReq(token('u-manager', 'MANAGER'), {
        batchId: B, dryRun: false, reason: 'x',
        items: [item('emp1', '2026-08-10'), item('emp2', '2026-08-10'), item('emp3', '2026-08-11')],
      }) as any)
      assert.equal(res.status, 200)
      const body = await res.json()
      // 第 1 筆正常成功；第 2、3 筆 deadline 之後 → NOT_PROCESSED
      assert.equal(body.results[0].status, 'SUCCESS')
      assert.equal(body.results[1].status, 'FAILED')
      assert.equal(body.results[1].code, 'NOT_PROCESSED')
      assert.equal(body.results[2].status, 'FAILED')
      assert.equal(body.results[2].code, 'NOT_PROCESSED')
      // 第 2、3 筆：冇 timeBankEntry.create、冇 advisory lock 呼叫
      assert.equal(state.committed.filter(c => c.kind === 'timeBankEntry').length, 1)
      assert.deepEqual(state.lockCalls, ['emp:emp1'])
      assert.deepEqual(body.summary, { success: 1, skipped: 0, failed: 2 })
      // 批次總結 audit 嘅 failures 包含兩筆 NOT_PROCESSED
      const batchAudit = state.committed.find(c => c.kind === 'auditLog' && c.rec.action === 'TIMEBANK_MAKEUP_BATCH')
      assert.ok(batchAudit)
      const batchNotes = JSON.parse(batchAudit.rec.notes)
      assert.equal(batchNotes.requested, 3)
      assert.equal(batchNotes.success, 1)
      assert.equal(batchNotes.failed, 2)
      assert.deepEqual(batchNotes.failures, [
        { employeeId: 'emp2', date: '2026-08-10', code: 'NOT_PROCESSED' },
        { employeeId: 'emp3', date: '2026-08-11', code: 'NOT_PROCESSED' },
      ])
    } finally {
      Date.now = realNow
      fakeTx.timeBankEntry.create = realCreate
    }
  })
})
