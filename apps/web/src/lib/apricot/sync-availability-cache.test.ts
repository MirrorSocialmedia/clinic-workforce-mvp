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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { prisma, basePrisma } from '../prisma'
import { toHKDateStr, addDaysStr } from '../hk-date'
import {
  buildSlotGrid,
  runAvailabilityCacheSync,
  runAvailabilityHistorySync,
  resetCacheFailCounter,
  getCacheConsecutiveFails,
} from './sync-availability-cache'
import type { CacheCallFn } from './sync-availability-cache'
import type { OpenSchRow, BookingRow } from './availability'

type Any = any

// ★ cwc-rdchain-20260823-a1：phone-hash fixture key（同步 sync 時 phoneNum→hash 需要）
const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../testdata/phone-hash.fixture.json'), 'utf8'),
) as { key: string; hash: string }

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

// 多 booking raw：兩病人（A 兩筆同電話）、status 0/102/4/-7/未知 7、1 筆 isRemoved
// ★ cwc-rdchain-20260823-a1：module scope（§3.1/§3.2 兩個 describe 共用）
function richRaw(): Any {
  const day = TODAY
  const patA = { id: 7001, code: 'TKW001', fullName: 'CHAN A (test)', phoneNum: '91234567' }
  const patB = { id: 7002, code: 'TKW002', fullName: 'LEE B (test)', phoneNum: '98765432' }
  return {
    [day]: {
      appointments: {
        D001: {
          practitionerOpenSchs: { timeSlots: [{ startTime: 900, endTime: 1030 }] },
          bookingDetail: [
            { id: 'apt-h1', bookingTime: hkIso(day, 570), bookingEndTime: hkIso(day, 600), bookingStatus: 0, isRemoved: false, visitReasons: [{ des: 'FILLING' }], remarkByDoctor: '覆診跟進', clinicPatient: patA },
            { id: 'apt-h2', bookingTime: hkIso(day, 570), bookingEndTime: hkIso(day, 600), bookingStatus: 102, isRemoved: false, clinicPatient: patA },
            { id: 'apt-h3', bookingTime: hkIso(day, 600), bookingEndTime: hkIso(day, 630), bookingStatus: 4, isRemoved: false, clinicPatient: patB },
            { id: 'apt-h4', bookingTime: hkIso(day, 600), bookingEndTime: hkIso(day, 630), bookingStatus: -7, isRemoved: false, clinicPatient: patB },
            { id: 'apt-h5', bookingTime: hkIso(day, 630), bookingEndTime: hkIso(day, 660), bookingStatus: 7, isRemoved: false, clinicPatient: patB },
            { id: 'apt-h6', bookingTime: hkIso(day, 630), bookingEndTime: hkIso(day, 660), bookingStatus: 0, isRemoved: true, clinicPatient: patA },
          ],
        },
      },
    },
  }
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
// ★ cwc-rdchain-20260823-a1：兩索引表 upsert capture
const apptUpserts: Any[] = []
const patientUpserts: Any[] = []
let locked = true
let providerRows: Any[] = PROVIDERS
let clinicRows: Any[] = CLINICS
let callImpl: (path: string) => Promise<any> = async (path) => { calls.push({ path }); return hostileRaw() }

const fakes = {
  provider: { findMany: async () => providerRows },
  clinic: { findMany: async () => clinicRows },
  availabilityCache: {
    deleteMany: async (args: Any) => { deletes.push(args); return { count: 0 } },
    createMany: async (args: Any) => { creates.push(args); return { count: args.data.length } },
  },
  appointmentIndex: {
    upsert: async (args: Any) => { apptUpserts.push(args); return {} },
  },
  patientIndex: {
    upsert: async (args: Any) => { patientUpserts.push(args); return {} },
  },
  $transaction: async (ops: any[]) => { for (const op of ops) await op },
  $queryRaw: async () => [{ locked }],
}

let saved: [Any, string, Any][] = []
before(() => {
  tee()
  process.env.PHONE_HASH_KEY = FIXTURE.key // phoneNum→hash（extractIndexRows）需要
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
  apptUpserts.length = 0
  patientUpserts.length = 0
  locked = true
  providerRows = PROVIDERS
  clinicRows = CLINICS
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
    // bookedCount 對（★ cwc-rdchain-20260823-a1 MD §0 佔用規則：只計 status ∈ {0, 102}）：
    // 09:00 格 0、09:30 格 1（570–600 status 0）、10:00 格 0（600–645 係 status 4 完成 — 唔計）；
    // isRemoved 筆唔計
    const grid = allRows
      .filter(r => r.clinicId === 'cl-a')
      .map(r => ({ s: r.startTime, b: r.bookedCount }))
      .sort((a, b) => a.s.localeCompare(b.s))
    assert.deepEqual(grid, [
      { s: '09:00', b: 0 },
      { s: '09:30', b: 1 },
      { s: '10:00', b: 0 },
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

// ── cwc-rdchain-20260823-a1: bookedCount status 規則（MD §0）─────────────

describe('buildSlotGrid — bookedCount 只計 status ∈ {0, 102}（MD §0 佔用規則）', () => {
  it('0/102 計；4/-6/-7/未知值唔計', () => {
    const rows = buildSlotGrid(
      [sch(540, 600)],
      [bk(570, 600, 0), bk(570, 600, 102), bk(570, 600, 4), bk(570, 600, -6), bk(570, 600, -7), bk(570, 600, 7)],
    )
    assert.equal(rows.length, 2) // 09:00–10:00 = 兩格；booking 570–600 只重疊 09:30 格
    assert.equal(rows[0].bookedCount, 0)
    assert.equal(rows[1].bookedCount, 2, '只有 0 同 102 計')
  })

  it('mock 一單 -7 → 該 slot 佔用唔計（驗收字面）', () => {
    const rows = buildSlotGrid([sch(540, 600)], [bk(570, 600, -7)])
    assert.equal(rows[0].bookedCount, 0)
  })
})

// ── cwc-rdchain-20260823-a1: §3.1 高頻一 call 三表齊（白名單 v2）────────

describe('§3.1 高頻 — 一 call 三表齊（白名單 v2）', () => {
  it('AppointmentIndex upsert 全欄：phoneNum→hash 即棄 raw；visitReasons/remarks 保留；isRemoved 唔入', async () => {
    clinicRows = [CLINICS[0]]
    callImpl = async (path) => { calls.push({ path }); return richRaw() }
    const outcome = await runAvailabilityCacheSync({ callFn: callImpl, now: NOW })
    assert.equal(outcome.ok, true)

    // 5 筆 index 行（apt-h6 isRemoved 跳過）
    assert.equal(apptUpserts.length, 5)
    const u1 = apptUpserts.find(u => u.where.apricotApptId === 'apt-h1')!
    assert.equal(u1.create.patientApricotId, '7001')
    assert.equal(u1.create.patientCode, 'TKW001')
    assert.equal(u1.create.patientName, 'CHAN A (test)')
    assert.equal(u1.create.phoneHash, FIXTURE.hash, '91234567 → fixture 固定向量')
    assert.deepEqual(u1.create.visitReasons, ['FILLING'])
    assert.equal(u1.create.remarks, '覆診跟進')
    assert.equal(u1.create.providerApricotId, 'D001')
    assert.equal(u1.create.providerName, 'Dr. Test Lau')
    assert.equal(u1.create.date, TODAY)
    assert.equal(u1.create.startTime, '09:30')
    assert.equal(u1.create.endTime, '10:00')
    assert.equal(u1.create.bookingStatus, 0)
    assert.equal(u1.update.remarks, '覆診跟進') // update 路徑同欄（status 變化追跟用）
    assert.equal(u1.create.syncedAt.getTime(), NOW.getTime())

    // 🔴 raw phone 全零 hit（upsert args + log）
    const upsertJson = JSON.stringify([...apptUpserts, ...patientUpserts])
    assert.ok(!upsertJson.includes('91234567'), 'raw phoneNum 落咗 upsert args')
    assert.ok(!upsertJson.includes('98765432'), 'raw phoneNum 落咗 upsert args')
    for (const leak of ['91234567', '98765432', 'CHAN A', 'LEE B']) {
      assert.ok(!ALL_LOG().includes(leak), `log 出現 PII：${leak}`)
    }
  })

  it('PatientIndex 去重（同病人多筆 → 1 upsert）+ lastSeenAt = now + 0→-7 status 更新', async () => {
    clinicRows = [CLINICS[0]]
    callImpl = async (path) => { calls.push({ path }); return richRaw() }
    await runAvailabilityCacheSync({ callFn: callImpl, now: NOW })

    assert.equal(patientUpserts.length, 2) // patA（兩筆同電話）同 patB 各 1
    const upA = patientUpserts.find(u => u.where.patientApricotId === '7001')!
    assert.equal(upA.create.phoneHash, FIXTURE.hash)
    assert.equal(upA.create.lastSeenAt.getTime(), NOW.getTime())
    assert.equal(upA.update.lastSeenAt.getTime(), NOW.getTime())

    // 0→-7 status 追跟：apt-h4 落庫 status = -7（下次 run 嘅 4 單都會照樣 upsert 覆寫）
    const u4 = apptUpserts.find(u => u.where.apricotApptId === 'apt-h4')!
    assert.equal(u4.create.bookingStatus, -7)
  })

  it('bookedCount 只計 0/102：09:30 格 = 2（0+102）、10:00 格 = 0（4+-7）；10:30 後冇格（開診 10:30 止）', async () => {
    clinicRows = [CLINICS[0]]
    callImpl = async (path) => { calls.push({ path }); return richRaw() }
    await runAvailabilityCacheSync({ callFn: callImpl, now: NOW })

    const grid = creates.flatMap(c => c.data)
      .filter(r => r.clinicId === 'cl-a')
      .map(r => ({ s: r.startTime, b: r.bookedCount }))
      .sort((a, b) => a.s.localeCompare(b.s))
    assert.deepEqual(grid, [
      { s: '09:00', b: 0 },
      { s: '09:30', b: 2 },
      { s: '10:00', b: 0 },
    ])
  })

  it('unknown bookingStatus → ALERT unknown_booking_status（value 入 log）', async () => {
    clinicRows = [CLINICS[0]]
    callImpl = async (path) => { calls.push({ path }); return richRaw() }
    await runAvailabilityCacheSync({ callFn: callImpl, now: NOW })

    const log = ALL_LOG()
    assert.ok(log.includes('unknown_booking_status'), '應該有 unknown_booking_status ALERT 行')
    assert.ok(log.includes('value=7'), 'alert 要帶 value')
    // 未知值照存（唔剔）
    assert.ok(apptUpserts.some(u => u.where.apricotApptId === 'apt-h5'), '未知 status 筆要照存')
  })
})

// ── cwc-rdchain-20260823-a1: §3.2 低頻 history 段（MD §3.2/§3.4）──────

describe('§3.2 低頻 history 段（MD §3.2/§3.4）', () => {
  const START = addDaysStr(TODAY, -7)
  const END = addDaysStr(TODAY, -1)

  /** 窗口首日本筆 status 變化單（0→-7）＋ 窗口外（今日）一筆（必被 filter） */
  const historyCall: CacheCallFn = (path) => {
    calls.push({ path })
    const patA = { id: 7001, code: 'TKW001', fullName: 'CHAN A (test)', phoneNum: '91234567' }
    return Promise.resolve({
      [START]: {
        appointments: {
          D001: {
            practitionerOpenSchs: { timeSlots: [{ startTime: 900, endTime: 1030 }] },
            bookingDetail: [
              { id: 'apt-past-1', bookingTime: hkIso(START, 570), bookingEndTime: hkIso(START, 600), bookingStatus: -7, isRemoved: false, clinicPatient: patA },
            ],
          },
        },
      },
      // 窗口外（今日）— history mode 唔准 index（高頻先管今日）
      [TODAY]: {
        appointments: {
          D001: {
            practitionerOpenSchs: { timeSlots: [{ startTime: 900, endTime: 1030 }] },
            bookingDetail: [
              { id: 'apt-out-of-window', bookingTime: hkIso(TODAY, 570), bookingEndTime: hkIso(TODAY, 600), bookingStatus: 0, isRemoved: false, clinicPatient: patA },
            ],
          },
        },
      },
    })
  }

  it('窗口 -7 → 昨日；只 upsert 兩索引表（AvailabilityCache 零寫）；窗口外日唔 index', async () => {
    clinicRows = [CLINICS[0]]
    const o = await runAvailabilityHistorySync({ callFn: historyCall, now: NOW })
    assert.equal(o.ok, true)
    if (!o.ok) return
    assert.equal(o.start, START)
    assert.equal(o.end, END)

    const qs = new URL('/?' + calls[0].path.split('?')[1], 'http://x').searchParams
    assert.equal(qs.get('startDate'), START)
    assert.equal(qs.get('endDate'), END)

    // AvailabilityCache 零寫（delete/create 都無）
    assert.equal(deletes.length, 0)
    assert.equal(creates.length, 0)

    // 只 index 窗口內筆
    assert.equal(apptUpserts.length, 1)
    assert.equal(apptUpserts[0].where.apricotApptId, 'apt-past-1')
    assert.equal(apptUpserts[0].create.date, START)
    assert.equal(apptUpserts[0].create.bookingStatus, -7)
    assert.ok(!apptUpserts.some(u => u.where.apricotApptId === 'apt-out-of-window'), '窗口外日唔准 index')
    assert.equal(patientUpserts.length, 1)
  })

  it('低頻 fail 共用現有 alert（連續 3 次 → availability_sync_failed；同高頻同一計數器）', async () => {
    clinicRows = [CLINICS[0]]
    const failing: CacheCallFn = async () => { calls.push({ path: 'x' }); throw new Error('APRICOT_HTTP_500: mock down') }
    for (let i = 1; i <= 3; i++) {
      const o = await runAvailabilityHistorySync({ callFn: failing, now: NOW })
      assert.equal(o.ok, true)
      if (i === 3) assert.ok(ALL_LOG().includes('availability_sync_failed'), '第 3 次 fail 應該 ALERT')
    }
    assert.equal(getCacheConsecutiveFails(), 3)
    // 共用計數器：高頻恢復 → 歸零
    callImpl = async (path) => { calls.push({ path }); return richRaw() }
    await runAvailabilityCacheSync({ callFn: callImpl, now: NOW })
    assert.equal(getCacheConsecutiveFails(), 0)
  })

  it('AUTH_EXPIRED → 剩餘店唔再打（短路）', async () => {
    clinicRows = CLINICS
    const authCall: CacheCallFn = async () => { calls.push({ path: 'x' }); throw new Error('APRICOT_AUTH_EXPIRED: cookie 失效') }
    await runAvailabilityHistorySync({ callFn: authCall, now: NOW })
    assert.equal(calls.length, 1)
  })

  it('lock busy → { ok: false, skipped }（唔 crash、唔寫庫）', async () => {
    locked = false
    const o = await runAvailabilityHistorySync({ callFn: historyCall, now: NOW })
    assert.deepEqual(o, { ok: false, skipped: 'another apricot call in progress' })
    assert.equal(calls.length, 0)
    assert.equal(apptUpserts.length, 0)
  })
})
