/**
 * Availability cache sync tests（MD §B.2 + D 驗收 mock 版）— cw-extapi-20260823-a1
 *
 * 全 mock：callFn 注入（唔打真 Apricot）+ fake prisma（monkey-patch）。
 * 覆蓋：
 *   - buildSlotGrid：30 分鐘格 / 重疊 bookedCount / 尾格短格 / 壞時段
 *   - runAvailabilityCacheSync：六店順序 / 31 日窗口 / 決定性全店重寫 / AUTH_EXPIRED 短路
 *   - sanitize 白名單 🔴：hostile raw（ clinicPatient/visitReasons/diagnosis/createdBy
 *     全數塞入）→ cache row 零污染 + console 零 PII 內文
 *   - 連續 3 次 fail → ALERT 行（MD §B.2.6）
 *   - lock busy → skip
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, basePrisma } from '../prisma'
import { toHKDateStr, addDaysStr } from '../hk-date'
import {
  buildSlotGrid,
  runAvailabilityCacheSync,
  resetCacheFailCounter,
  getCacheConsecutiveFails,
} from './sync-availability-cache'
import type { OpenSchRow, BookingRow } from './availability'

type Any = any

// ── console 截取（PII 零洩漏斷言用）──────────────────────────────────
const logBuf: string[] = []
const realLog = console.log
const realErr = console.error
function tee(): void {
  const push = (s: string) => logBuf.push(s)
  console.log = (...a: any[]) => { push(a.map(String).join(' ')); realLog(...a) }
  console.error = (...a: any[]) => { push(a.map(String).join(' ')); realErr(...a) }
}
function resetLog(): void { logBuf.length = 0 }
const ALL_LOG = () => logBuf.join('\n')

// ── 時間輔助：HK 分鐘 → UTC ISO（同 mock-apricot hkIso 同算）──────────
const NOW = new Date('2026-08-23T05:00:00.000Z') // HK = 2026-08-23 13:00
const TODAY = toHKDateStr(NOW) // 2026-08-23
const DAY30 = addDaysStr(TODAY, 30)

function hkIso(dateStr: string, min: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, Math.floor(min / 60), min % 60) - 8 * 3600_000).toISOString()
}
function sch(startTime: number, endTime: number): OpenSchRow {
  return { date: TODAY, startTime: `${String(Math.floor(startTime / 60)).padStart(2, '0')}:${String(startTime % 60).padStart(2, '0')}`, endTime: `${String(Math.floor(endTime / 60)).padStart(2, '0')}:${String(endTime % 60).padStart(2, '0')}` }
}
function bk(minStart: number, minEnd: number, status = 0): BookingRow {
  return { date: TODAY, startMin: minStart, endMin: minEnd, status }
}

// ── hostile raw（MD 紅線：raw 帶晒病人資料）─────────────────────────
// 佢係 getOverviewAppointments 真實 response 形狀 + 全部 PII 欄塞滿。
// 假值 only（D 驗收：fixture 用假值）— 唔含任何真人/真電話/真 HKID。
function hostileRaw(): Any {
  return {
    meta: { note: 'non-date-key-must-be-filtered' },
    [TODAY]: {
      appointments: {
        D001: {
          practitioner: { id: 'D001', code: 'LAU', fullName: 'Dr. Test Lau' },
          practitionerOpenSchs: { day: 'FRI', timeSlots: [{ startTime: 900, endTime: 1030 }] }, // 09:00–10:30（HHMM int — 同真實 shape-1）
          bookingDetail: [
            {
              bookingTime: hkIso(TODAY, 570),
              bookingEndTime: hkIso(TODAY, 600),
              bookingStatus: 0,
              isRemoved: false,
              createdBy: 'JOAN TEST NURSE',
              visitReasons: [{ code: 'RV01', des: 'FOLLOW-UP' }],
              remarkByDoctor: 'after mos & implant pain (test)',
              diagnosis: 'DENTAL PAIN (test dx)',
              clinicPatient: {
                id: 1,
                fullName: 'CHAN TAK-WAH (test)',
                personalIdentifier: 'A123456(7)',
                address: '12 FAKE STREET, TSING YI',
                phoneNum: '91234567',
                email: 'patient-test@example.com',
                dateOfBirth: '1975-04-01',
                medicalHistory: 'HYPERTENSION (test)',
                drugHistory: 'ASPIRIN (test)',
                emergencyContact: { name: 'CHAN MOK (test)', phone: '98765432' },
                phoneList: [{ number: '91234567' }],
                bloodType: 'A+',
                occupation: 'ENGINEER',
              },
            },
            {
              // 600–645 跨 10:00–10:30 格
              bookingTime: hkIso(TODAY, 600),
              bookingEndTime: hkIso(TODAY, 645),
              bookingStatus: 4,
              isRemoved: false,
            },
            {
              // isRemoved → 必排除
              bookingTime: hkIso(TODAY, 570),
              bookingEndTime: hkIso(TODAY, 600),
              bookingStatus: 0,
              isRemoved: true,
            },
          ],
        },
        D002: {
          practitioner: { id: 'D002', code: 'TONG', fullName: 'Dr. Test Tong' },
          practitionerOpenSchs: { timeSlots: [] }, // 無開診 → 零行
          bookingDetail: [],
        },
      },
      blocks: [],
      groupClasses: [],
    },
  }
}

// ── fake prisma ──────────────────────────────────────────────────────
const PROVIDERS = [
  { apricotId: 'D001', name: 'Dr. Test Lau' },
  { apricotId: 'D002', name: 'Dr. Test Tong' },
]
const CLINICS = [
  { id: 'cl-a', name: 'Test Clinic A', apricotClinicId: '9001' },
  { id: 'cl-b', name: 'Test Clinic B', apricotClinicId: '9002' },
]

const calls: { path: string }[] = []
const deletes: Any[] = []
const creates: Any[] = []
let locked = true
let providerRows: Any[] = PROVIDERS
let callImpl: (path: string) => Promise<any> = async (path) => { calls.push({ path }); return hostileRaw() }

const fakes = {
  provider: { findMany: async () => providerRows },
  clinic: { findMany: async () => CLINICS },
  availabilityCache: {
    deleteMany: async (args: Any) => { deletes.push(args); return { count: 0 } },
    createMany: async (args: Any) => { creates.push(args); return { count: args.data.length } },
  },
  $transaction: async (ops: any[]) => { for (const op of ops) await op },
  $queryRaw: async () => [{ locked }],
}

let saved: [Any, string, Any][] = []
before(() => {
  tee()
  for (const obj of [prisma, basePrisma]) {
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
  console.log = realLog
  console.error = realErr
})
beforeEach(() => {
  calls.length = 0
  deletes.length = 0
  creates.length = 0
  locked = true
  providerRows = PROVIDERS
  callImpl = async (path) => { calls.push({ path }); return hostileRaw() }
  resetCacheFailCounter()
  resetLog()
})

// ── buildSlotGrid（純函數）───────────────────────────────────────────

describe('buildSlotGrid — 30 分鐘 slot grid', () => {
  it('09:00–18:00 → 18 格；09:30 格被 09:30–10:00 預約佔', () => {
    const rows = buildSlotGrid([sch(540, 1080)], [bk(570, 600)])
    assert.equal(rows.length, 18)
    assert.deepEqual(rows[0], { date: TODAY, startTime: '09:00', endTime: '09:30', isOpen: true, bookedCount: 0 })
    assert.equal(rows[1].bookedCount, 1) // 09:30–10:00
    assert.equal(rows[2].bookedCount, 0)
  })

  it('跨格預約 10:00–10:45 → 10:00 同 10:30 兩格都計', () => {
    const rows = buildSlotGrid([sch(540, 1080)], [bk(600, 645)])
    assert.equal(rows[2].bookedCount, 1) // 10:00–10:30
    assert.equal(rows[3].bookedCount, 1) // 10:30–11:00
    assert.equal(rows[4].bookedCount, 0)
  })

  it('尾格可以短於 30 分鐘（09:00–09:45）', () => {
    const rows = buildSlotGrid([sch(540, 585)], [])
    assert.deepEqual(
      rows.map(r => [r.startTime, r.endTime]),
      [['09:00', '09:30'], ['09:30', '09:45']],
    )
  })

  it('多時段（上午 + 晚）各自分格；isRemoved 唔計（extractor 已剔，呢度唔重複）', () => {
    const rows = buildSlotGrid([sch(540, 600), sch(1200, 1260)], [bk(1230, 1260)])
    assert.equal(rows.length, 4)
    assert.equal(rows[3].bookedCount, 1) // 20:30–21:00
  })

  it('壞時段（end <= start）→ 零格', () => {
    assert.deepEqual(buildSlotGrid([{ date: TODAY, startTime: '10:00', endTime: '10:00' }], []), [])
  })
})

// ── runAvailabilityCacheSync（全 mock）───────────────────────────────

describe('runAvailabilityCacheSync — MD §B.2', () => {
  it('兩店順序 sync；31 日窗口；query 參數齊（doctorIds 全部 apricotId != null）', async () => {
    const outcome = await runAvailabilityCacheSync({ callFn: callImpl, now: NOW })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.start, TODAY)
    assert.equal(outcome.end, DAY30)
    assert.equal(outcome.results.length, 2)

    assert.equal(calls.length, 2)
    const qs = new URL('/?' + calls[0].path.split('?')[1], 'http://x').searchParams
    assert.equal(qs.get('startDate'), TODAY)
    assert.equal(qs.get('endDate'), DAY30)
    assert.equal(qs.get('openSchClinicId'), '9001')
    assert.equal(qs.getAll('clinicIds').join(','), '9001')
    assert.deepEqual(qs.getAll('doctorIds').sort(), ['D001', 'D002']) // 全部 apricotId != null（唔 filter isActive）
  })

  it('決定性全店重寫：deleteMany(where={clinicId}) → createMany；syncedAt = now', async () => {
    const outcome = await runAvailabilityCacheSync({ callFn: callImpl, now: NOW })
    assert.equal(outcome.ok, true)
    assert.equal(deletes.length, 2)
    assert.deepEqual(deletes[0], { where: { clinicId: 'cl-a' } })
    assert.deepEqual(deletes[1], { where: { clinicId: 'cl-b' } })

    assert.equal(creates.length, 2)
    const rowsA = creates[0].data
    assert.ok(rowsA.length >= 1)
    const row0 = rowsA[0]
    assert.equal(row0.clinicId, 'cl-a')
    assert.equal(row0.providerApricotId, 'D001')
    assert.equal(row0.providerName, 'Dr. Test Lau') // 快照 = 本系統 Provider.name
    assert.ok(['09:00', '09:30', '10:00'].includes(row0.startTime))
    assert.equal(row0.isOpen, true)
    assert.ok(row0.syncedAt.getTime() === NOW.getTime())
  })

  it('D 驗收（sanitize 紅線）：hostile raw → cache 零污染 + log 零 PII 內文', async () => {
    await runAvailabilityCacheSync({ callFn: callImpl, now: NOW })

    const allRows = creates.flatMap(c => c.data)
    const cacheJson = JSON.stringify(allRows)
    for (const leak of [
      'clinicPatient', 'personalIdentifier', 'A123456(7)', 'medicalHistory',
      'visitReasons', 'phoneNum', '91234567', '98765432', 'createdBy',
      'JOAN TEST NURSE', 'diagnosis', 'DENTAL PAIN', 'address', 'FAKE STREET',
      'dateOfBirth', 'emergencyContact', 'bloodType', 'occupation', 'email',
      'remarkByDoctor',
    ]) {
      assert.ok(!cacheJson.includes(leak), `cache 出現 PII：${leak}`)
    }
    const logJson = ALL_LOG()
    for (const leak of ['A123456(7)', '91234567', 'clinicPatient', 'JOAN TEST NURSE', 'CHAN TAK-WAH', 'HYPERTENSION']) {
      assert.ok(!logJson.includes(leak), `log 出現 PII：${leak}`)
    }
    // bookedCount 對：09:00 格 0、09:30 格 1（570–600）、10:00 格 1（600–645）；isRemoved 筆唔計
    const grid = allRows
      .filter(r => r.clinicId === 'cl-a')
      .map(r => ({ s: r.startTime, b: r.bookedCount }))
      .sort((a, b) => a.s.localeCompare(b.s))
    assert.deepEqual(grid, [
      { s: '09:00', b: 0 },
      { s: '09:30', b: 1 },
      { s: '10:00', b: 1 },
    ])
  })

  it('連續 3 次 run fail → 第 3 次有 ALERT 行；恢復後計數歸零（MD §B.2.6）', async () => {
    const failingCall: Any = async (path: string) => { calls.push({ path }); throw new Error('APRICOT_HTTP_500: mock down') }
    for (let i = 1; i <= 3; i++) {
      const o = await runAvailabilityCacheSync({ callFn: failingCall, now: NOW })
      assert.equal(o.ok, true) // run 本身完成（店級 fail 入 results）
      if (i === 3) {
        assert.ok(ALL_LOG().includes('availability_sync_failed'), '第 3 次 fail 應該有 ALERT 行')
      } else {
        assert.ok(!ALL_LOG().includes('availability_sync_failed'), `第 ${i} 次唔應該 ALERT`)
      }
    }
    assert.equal(getCacheConsecutiveFails(), 3)
    // 恢復
    await runAvailabilityCacheSync({ callFn: callImpl, now: NOW })
    assert.equal(getCacheConsecutiveFails(), 0)
  })

  it('AUTH_EXPIRED → 剩餘店唔再打（短路）', async () => {
    const authCall: Any = async (path: string) => {
      calls.push({ path })
      throw new Error('APRICOT_AUTH_EXPIRED: cookie 失效')
    }
    await runAvailabilityCacheSync({ callFn: authCall, now: NOW })
    assert.equal(calls.length, 1) // 只打咗第一家就斷
  })

  it('lock busy → { ok: false, skipped }（唔 crash、唔寫庫）', async () => {
    locked = false
    const o = await runAvailabilityCacheSync({ callFn: callImpl, now: NOW })
    assert.deepEqual(o, { ok: false, skipped: 'another apricot call in progress' })
    assert.equal(calls.length, 0)
    assert.equal(creates.length, 0)
  })

  it('冇 provider 有 apricotId → 該店 fail（唔硬造空 grid）', async () => {
    providerRows = []
    const o = await runAvailabilityCacheSync({ callFn: callImpl, now: NOW })
    assert.equal(o.ok, true)
    if (!o.ok) return
    for (const r of o.results) {
      if ('error' in r) assert.match(r.error, /冇任何 provider 有 apricotId/)
    }
    assert.equal(creates.length, 0)
  })
})
