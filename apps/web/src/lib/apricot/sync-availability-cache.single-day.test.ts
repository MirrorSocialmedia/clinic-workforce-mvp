/**
 * 單日即時 sync tests（MD §4）— cw-apricotwrite-20260823-a1
 *
 * 全 mock：callFn 注入 + fake prisma。
 * 覆蓋：
 *   - startDate = endDate = 該日（一 call）
 *   - 決定性重寫只限該店該日（其他日 cache row 唔郁）
 *   - sanitize 照行（hostile raw 塞 PII → cache row 零污染）
 *   - syncAvailabilityCacheSingleDay 唔自己攞 lock（caller 同鎖）
 *   - runAvailabilityCacheSync({ clinicId, dateOnly }) = MD §4 字面簽名（有 lock 版）
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../prisma'
import {
  syncAvailabilityCacheSingleDay,
  runAvailabilityCacheSync,
} from './sync-availability-cache'
import type { CacheCallFn } from './sync-availability-cache'

type Any = any

const DATE = '2026-09-01'
const OTHER_DATE = '2026-09-02'

interface Call { path: string }
const calls: Call[] = []
const mockCall: CacheCallFn = (path) => {
  calls.push({ path })
  return Promise.resolve(overviewRaw(path))
}

function overviewRaw(path: string): Any {
  const qs = new URLSearchParams(path.split('?')[1] ?? '')
  const dateStr = qs.get('startDate') ?? DATE
  const [y, m, d] = dateStr.split('-').map(Number)
  const utc = (hkMin: number) => new Date(Date.UTC(y, m - 1, d, 0, 0) + hkMin * 60_000 - 8 * 3600_000).toISOString()
  return {
    [dateStr]: {
      appointments: {
        'prov-1': {
          practitionerOpenSchs: { timeSlots: [{ startTime: 900, endTime: 1200 }] },
          bookingDetail: [{ bookingTime: utc(540), bookingEndTime: utc(570), bookingStatus: 0, isRemoved: false }],
        },
      },
    },
  }
}

const cacheRows: Any[] = [
  { clinicId: 'cl-1', providerApricotId: 'prov-1', providerName: 'Dr. T', date: OTHER_DATE, startTime: '10:00', endTime: '10:30', isOpen: true, bookedCount: 0, syncedAt: new Date('2026-08-20T00:00:00Z') },
]
const deleteManyWheres: Any[] = []
let queryRawCount = 0

const fakes = {
  $queryRaw: async (strings: Any) => {
    queryRawCount += 1
    const sql = typeof strings === 'object' && strings.join ? strings.join('?') : String(strings)
    return [{ locked: /try_advisory_lock/.test(sql) ? true : null }]
  },
  provider: { findMany: async () => [{ apricotId: 'prov-1', name: 'Dr. T' }] },
  clinic: { findUnique: async () => ({ id: 'cl-1', apricotClinicId: 'apr-clinic-1' }) },
  availabilityCache: {
    deleteMany: async (args: Any) => {
      deleteManyWheres.push(args.where)
      for (let i = cacheRows.length - 1; i >= 0; i--) {
        const r = cacheRows[i]
        if (r.clinicId === args.where.clinicId && (!args.where.date || r.date === args.where.date)) cacheRows.splice(i, 1)
      }
      return { count: 0 }
    },
    createMany: async ({ data }: Any) => { cacheRows.push(...data); return { count: data.length } },
  },
  $transaction: async (arg: Any) => (Array.isArray(arg) ? Promise.all(arg) : arg()),
}

let saved: [Any, string, Any][] = []
before(() => {
  for (const obj of [prisma]) {
    for (const k of Object.keys(fakes) as (keyof typeof fakes)[]) {
      saved.push([obj, k, (obj as Any)[k]])
      Object.defineProperty(obj, k, { value: fakes[k], configurable: true, writable: true })
    }
  }
})
after(() => {
  for (const [obj, k, orig] of saved) {
    Object.defineProperty(obj, k, { value: orig, configurable: true, writable: true })
  }
})
beforeEach(() => {
  calls.length = 0
  cacheRows.length = 1
  cacheRows[0] = { clinicId: 'cl-1', providerApricotId: 'prov-1', providerName: 'Dr. T', date: OTHER_DATE, startTime: '10:00', endTime: '10:30', isOpen: true, bookedCount: 0, syncedAt: new Date('2026-08-20T00:00:00Z') }
  deleteManyWheres.length = 0
  queryRawCount = 0
})

describe('§4 單日即時 sync', () => {
  it('startDate = endDate = 該日（一 call）+ 只決定性重寫該店該日', async () => {
    const r = await syncAvailabilityCacheSingleDay({ id: 'cl-1', apricotClinicId: 'apr-clinic-1' }, DATE, { callFn: mockCall, now: new Date('2026-08-23T05:00:00Z') })
    assert.equal(r.dayRefreshed, true)
    assert.ok(r.syncedAt)

    assert.equal(calls.length, 1, '應該只一 call')
    const qs = new URLSearchParams(calls[0].path.split('?')[1])
    assert.equal(qs.get('startDate'), DATE)
    assert.equal(qs.get('endDate'), DATE)
    assert.equal(qs.get('openSchClinicId'), 'apr-clinic-1')

    // 重寫範圍 = 該店 + 該日（deleteMany where 有 date）
    assert.deepEqual(deleteManyWheres[0], { clinicId: 'cl-1', date: DATE })
    // 新 row 全部係該日
    const newRows = cacheRows.filter((c) => c.date === DATE)
    assert.ok(newRows.length > 0, '該日 slot 缺失')
    assert.ok(newRows.every((c) => c.clinicId === 'cl-1'))
    // 其他日 row 原封不動
    const other = cacheRows.find((c) => c.date === OTHER_DATE)
    assert.ok(other, '其他日 row 被誤刪')
    assert.equal(other.syncedAt.toISOString(), '2026-08-20T00:00:00.000Z')
    // bookedCount 反映 booking（09:00-09:30 → 10:00 格未佔、09:00 格佔）
    const firstSlot = newRows.find((c) => c.startTime === '09:00')
    assert.equal(firstSlot?.bookedCount, 1)
  })

  it('syncAvailabilityCacheSingleDay 唔自己攞 lock（caller 同鎖 — 重攞會 pool deadlock）', async () => {
    await syncAvailabilityCacheSingleDay({ id: 'cl-1', apricotClinicId: 'apr-clinic-1' }, DATE, { callFn: mockCall })
    assert.equal(queryRawCount, 0, 'no-lock 版唔准打 advisory lock')
  })

  it('runAvailabilityCacheSync({ clinicId, dateOnly }) = MD §4 字面簽名（有 lock 版）', async () => {
    const r = await runAvailabilityCacheSync({ clinicId: 'cl-1', dateOnly: DATE, callFn: mockCall, now: new Date('2026-08-23T05:00:00Z') })
    assert.equal(r.dayRefreshed, true)
    assert.ok(r.syncedAt)
    assert.ok(queryRawCount >= 1, '應該攞 lock')
    assert.equal(calls.length, 1)
    const qs = new URLSearchParams(calls[0].path.split('?')[1])
    assert.equal(qs.get('startDate'), DATE)
    assert.equal(qs.get('endDate'), DATE)
  })

  it('🔴 sanitize：hostile raw（塞 PII）→ cache row 零污染', async () => {
    const hostile: CacheCallFn = (path) => {
      calls.push({ path })
      const qs = new URLSearchParams(path.split('?')[1] ?? '')
      const dateStr = qs.get('startDate') ?? DATE
      return Promise.resolve({
        [dateStr]: {
          appointments: {
            'prov-1': {
              practitionerOpenSchs: { timeSlots: [{ startTime: 900, endTime: 1200 }] },
              bookingDetail: [{
                bookingTime: '2026-08-31T21:00:00.000Z',
                bookingEndTime: '2026-08-31T21:30:00.000Z',
                bookingStatus: 0,
                isRemoved: false,
                clinicPatient: { phoneNum: '98765432', personalIdentifier: 'ABC12345(6)' },
                visitReasons: [{ des: 'secret' }],
                diagnosis: 'secret',
                createdBy: 'secret-staff',
                remarks: 'secret-notes',
              }],
            },
          },
        },
      })
    }
    await syncAvailabilityCacheSingleDay({ id: 'cl-1', apricotClinicId: 'apr-clinic-1' }, DATE, { callFn: hostile })
    const rows = cacheRows.filter((c) => c.date === DATE)
    assert.ok(rows.length > 0)
    const json = JSON.stringify(rows)
    for (const p of ['clinicPatient', 'phoneNum', '98765432', 'personalIdentifier', 'visitReasons', 'diagnosis', 'createdBy', 'remarks']) {
      assert.ok(!json.includes(p), `cache row 含 PII：${p}`)
    }
  })
})
