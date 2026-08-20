// ★ cw-pa P1-B: PII 白名單測試（test-first — 呢個檔案喺 availability.ts 實裝之前寫）
// 跑法: npx tsx --test src/lib/apricot/availability.test.ts
// Node 22 內建 test runner，唔加新 dependency。
//
// 呢個 response 係目前見過最危險嘅 Apricot JSON（§一）：一筆預約入面有
// HKID / 病歷 / 緊急聯絡人 / 求診原因 / 醫生病情備註 / 員工姓名。
// 白名單提取係唯一防線 —— 斷言輸出只有 primitive，零 sub-object，零 PII 值。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractOpenSch,
  extractBookings,
  utcIsoToHkMin,
  hhmmIntToStr,
} from './availability'

// ---- fixture（照 spec §0 / §一 結構；所有病人資料為合成樣本，唔係真人）----

const DATE = '2026-08-19'

// 🔴 完整 clinicPatient —— 每欄都要試過「唔會洩漏」
const CLINIC_PATIENT = {
  id: 9001,
  code: 'PT0001',
  fullName: '陳大文',
  personalIdentifier: 'A123456(7)', // HKID
  address: '12 Fake Street, Mei Foo',
  phoneNum: '91234567',
  email: 'patient@example.com',
  dateOfBirth: '1975-04-01',
  bloodType: 'A+',
  gender: 'M',
  occupation: 'Engineer',
  medicalHistory: '其他，請註明: 高血壓',
  drugHistory: { historyDes: '其他，請註明: 阿士匹靈' },
  emergencyContact: { name: 'Chan Tai Man', phone: '98765432', relation: '母子' },
  phoneList: [{ number: '91234567' }],
  billOsAmt: 1234.5,
}

/** 一筆帶晒所有敏感欄嘅 booking（除特別指明） */
function mkBooking(over: Record<string, unknown> = {}) {
  return {
    id: 'b-' + Math.random().toString(36).slice(2, 8),
    code: 'AP0001',
    cpId: 'cp-123',
    patientId: 9001,
    bookingStatus: 0,
    isRemoved: false,
    createdBy: 'JOAN NURSE',
    lastModifiedBy: 'JOAN NURSE',
    visitReasons: [{ code: 'RV', des: 'PAIN' }],
    remarkByDoctor: 'after mos & implant pain',
    clinicPatient: CLINIC_PATIENT,
    ...over,
  }
}

const NODE = {
  practitioner: {
    id: '695e6e511e430c48022a7690',
    code: 'LAU',
    fullName: 'Dr. Lau Ho Yin, Samson',
    nickname: 'Dr. Lau',
  },
  practitionerOpenSchs: {
    day: 'WED',
    timeSlots: [{ startTime: 900, endTime: 1800 }],
  },
  bookingDetail: [
    // §7.2 #10: 第一筆 09:30–10:00 HK = 01:30Z–02:00Z UTC，status 0
    mkBooking({
      bookingTime: '2026-08-19T01:30:00Z',
      bookingEndTime: '2026-08-19T02:00:00Z',
    }),
    // §7.2 #12: 11:15–11:45 HK（03:15Z–03:45Z）四筆並排 — 全部要保留（唔准 dedupe）
    mkBooking({ bookingTime: '2026-08-19T03:15:00Z', bookingEndTime: '2026-08-19T03:45:00Z' }),
    mkBooking({ bookingTime: '2026-08-19T03:15:00Z', bookingEndTime: '2026-08-19T03:45:00Z' }),
    mkBooking({ bookingTime: '2026-08-19T03:15:00Z', bookingEndTime: '2026-08-19T03:45:00Z', bookingStatus: 4 }),
    mkBooking({ bookingTime: '2026-08-19T03:15:00Z', bookingEndTime: '2026-08-19T03:45:00Z' }),
    // §7.2 #15: isRemoved=true — 唔會入庫
    mkBooking({
      bookingTime: '2026-08-19T04:00:00Z',
      bookingEndTime: '2026-08-19T04:30:00Z',
      isRemoved: true,
    }),
    // 無效時段（e <= s）— 跳過
    mkBooking({ bookingTime: '2026-08-19T05:00:00Z', bookingEndTime: '2026-08-19T05:00:00Z' }),
    // §7.2 #14（反方向）：HK 日期係 08-20（00:30–01:00 HK = 16:30Z 前一日），
    // 但 node 日期係 08-19 → 跨日檢查必須拒
    mkBooking({ bookingTime: '2026-08-19T16:30:00Z', bookingEndTime: '2026-08-19T17:00:00Z' }),
    // §7.2 #16: bookingStatus 缺省 → -1（保留時間）
    mkBooking({
      bookingTime: '2026-08-19T06:00:00Z',
      bookingEndTime: '2026-08-19T06:30:00Z',
      bookingStatus: undefined,
    }),
  ],
}

// 固定 id 版本（deepStrictEqual 用）— mkBooking 用 random id 會令 deepEqual 失敗，
// 所以主斷言用呢個手搓版。
const NODE_DETERMINISTIC = {
  practitioner: NODE.practitioner,
  practitionerOpenSchs: NODE.practitionerOpenSchs,
  bookingDetail: [
    { ...mkBooking({ id: 'b1', bookingTime: '2026-08-19T01:30:00Z', bookingEndTime: '2026-08-19T02:00:00Z' }) },
    { ...mkBooking({ id: 'b2', bookingTime: '2026-08-19T03:15:00Z', bookingEndTime: '2026-08-19T03:45:00Z' }) },
    { ...mkBooking({ id: 'b3', bookingTime: '2026-08-19T03:15:00Z', bookingEndTime: '2026-08-19T03:45:00Z' }) },
    { ...mkBooking({ id: 'b4', bookingTime: '2026-08-19T03:15:00Z', bookingEndTime: '2026-08-19T03:45:00Z', bookingStatus: 4 }) },
    { ...mkBooking({ id: 'b5', bookingTime: '2026-08-19T03:15:00Z', bookingEndTime: '2026-08-19T03:45:00Z' }) },
    { ...mkBooking({ id: 'b6', bookingTime: '2026-08-19T04:00:00Z', bookingEndTime: '2026-08-19T04:30:00Z', isRemoved: true }) },
    { ...mkBooking({ id: 'b7', bookingTime: '2026-08-19T05:00:00Z', bookingEndTime: '2026-08-19T05:00:00Z' }) },
    { ...mkBooking({ id: 'b8', bookingTime: '2026-08-19T16:30:00Z', bookingEndTime: '2026-08-19T17:00:00Z' }) },
    { ...mkBooking({ id: 'b9', bookingTime: '2026-08-19T06:00:00Z', bookingEndTime: '2026-08-19T06:30:00Z', bookingStatus: undefined }) },
  ],
}

/** fixture 入面必需要「試過唔會洩漏」嘅 PII 值（key 名 + 值） */
const MUST_NOT_LEAK = [
  // key 名
  'clinicPatient', 'visitReasons', 'remarkByDoctor', 'personalIdentifier',
  'medicalHistory', 'drugHistory', 'emergencyContact', 'phoneList', 'billOsAmt',
  'createdBy', 'lastModifiedBy', 'cpId', 'patientId', 'dateOfBirth',
  'phoneNum', 'bloodType', 'occupation',
  // 值
  'A123456(7)', '陳大文', '12 Fake Street', '91234567', 'patient@example.com',
  '1975-04-01', 'A+', 'Engineer', '高血壓', '阿士匹靈',
  'Chan Tai Man', '98765432', '母子', '1234.5',
  'PAIN', 'after mos & implant pain', 'JOAN NURSE',
]

function assertNoPii(output: unknown, label: string) {
  const json = JSON.stringify(output)
  for (const marker of MUST_NOT_LEAK) {
    assert.ok(!json.includes(marker), `${label} 疑似洩漏 PII：${marker}`)
  }
}

function assertPrimitiveOnly(items: unknown[], allowedKeys: string[], label: string) {
  for (const item of items) {
    assert.equal(typeof item, 'object', `${label}: 每项都要係 object`)
    assert.ok(item !== null && !Array.isArray(item), `${label}: 唔可以係 array/null`)
    const obj = item as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    assert.deepEqual(keys, [...allowedKeys].sort(), `${label}: keys 只准 ${allowedKeys}，實際 ${keys}`)
    // 每個 value 都要 primitive（零 sub-object）
    for (const [k, v] of Object.entries(obj)) {
      const t = typeof v
      assert.ok(
        t === 'string' || t === 'number' || t === 'boolean',
        `${label}[${k}]: 只准 primitive（string/number/boolean），實際 ${t}`,
      )
    }
  }
}

// ---- tests ----------------------------------------------------------------

describe('extractBookings — PII 白名單', () => {
  it('§7.2 #10：Dr. Lau 第一筆預約 → startMin 570 / endMin 600', () => {
    const single = { ...NODE_DETERMINISTIC, bookingDetail: [NODE_DETERMINISTIC.bookingDetail[0]] }
    const rows = extractBookings(DATE, single)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].startMin, 570) // 09:30
    assert.equal(rows[0].endMin, 600)   // 10:00
    assert.equal(rows[0].status, 0)
    assert.equal(rows[0].date, DATE)
  })

  it('§7.2 #10/#12/#16：完整輸出 — 6 筆（isRemoved / e<=s / 跨日 已剔）', () => {
    const rows = extractBookings(DATE, NODE_DETERMINISTIC)
    assert.equal(rows.length, 6, '9 筆輸入 → 6 筆輸出（剔 isRemoved 1、e<=s 1、跨日 1）')
    assert.deepEqual(rows, [
      { date: DATE, startMin: 570, endMin: 600, status: 0 },   // 09:30–10:00
      { date: DATE, startMin: 675, endMin: 705, status: 0 },   // 11:15–11:45 ×1
      { date: DATE, startMin: 675, endMin: 705, status: 0 },   // ×2
      { date: DATE, startMin: 675, endMin: 705, status: 4 },   // ×3（status 4 保留）
      { date: DATE, startMin: 675, endMin: 705, status: 0 },   // ×4 — 唔准 dedupe
      { date: DATE, startMin: 840, endMin: 870, status: -1 },  // 14:00–14:30 HK (06:00Z) status 缺省 → -1
    ])
  })

  it('★★★ 每項只有 4 個 primitive key，零 sub-object（§7.1 #3b）', () => {
    const rows = extractBookings(DATE, NODE_DETERMINISTIC)
    assert.ok(rows.length > 0)
    assertPrimitiveOnly(rows, ['date', 'startMin', 'endMin', 'status'], 'extractBookings')
  })

  it('★★★ 零 PII 值：clinicPatient/visitReasons/remarkByDoctor/員工姓名 全部唔會出現', () => {
    const rows = extractBookings(DATE, NODE_DETERMINISTIC)
    assertNoPii(rows, 'extractBookings')
    // 連 openSch 一齊試
    assertNoPii(extractOpenSch(DATE, NODE_DETERMINISTIC), 'extractOpenSch')
  })

  it('§7.2 #15：isRemoved=true 唔會入庫', () => {
    const rows = extractBookings(DATE, NODE)
    assert.ok(!rows.some(r => r.startMin === 240 && r.endMin === 270), '04:00–04:30 (isRemoved) 唔應該出現')
  })

  it('§7.2 #14：HK 00:00–08:00 跨日預約落正確嘅日', () => {
    // node 日期 08-20，預約係 08-20 00:30–01:00 HK（UTC 落喺 08-19 16:30Z）
    const node20 = {
      ...NODE_DETERMINISTIC,
      bookingDetail: [
        mkBooking({
          id: 'bx',
          bookingTime: '2026-08-19T16:30:00Z',
          bookingEndTime: '2026-08-19T17:00:00Z',
        }),
      ],
    }
    const rows = extractBookings('2026-08-20', node20)
    assert.deepEqual(rows, [{ date: '2026-08-20', startMin: 30, endMin: 60, status: 0 }],
      'UTC 前一日 16:30Z = HK 當日 00:30 — 要落 08-20 而唔係被跨日檢查誤殺')
  })

  it('§7.2 #14（反方向）：HK 日期同 node 日期唔同 → 剔', () => {
    // node 日期 08-19，預約係 08-20 00:30 HK（UTC 08-19 16:30Z）→ 唔屬於 08-19
    const rows = extractBookings(DATE, NODE_DETERMINISTIC)
    assert.ok(!rows.some(r => r.startMin === 30 && r.endMin === 60), '跨日筆唔應該落 08-19')
  })

  it('缺欄 / 壞格式：bookingDetail 唔係 array → []', () => {
    assert.deepEqual(extractBookings(DATE, {}), [])
    assert.deepEqual(extractBookings(DATE, { bookingDetail: 'oops' }), [])
    assert.deepEqual(extractBookings(DATE, null), [])
  })

  it('壞時間戳：bookingTime 唔係合法 ISO → 該筆剔走，其餘保留', () => {
    const node = {
      ...NODE_DETERMINISTIC,
      bookingDetail: [
        mkBooking({ id: 'bg', bookingTime: 'not-a-date', bookingEndTime: '2026-08-19T02:00:00Z' }),
        mkBooking({ id: 'bk', bookingTime: '2026-08-19T01:30:00Z', bookingEndTime: '2026-08-19T02:00:00Z' }),
      ],
    }
    const rows = extractBookings(DATE, node)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].startMin, 570)
  })
})

describe('extractOpenSch — 只抽 date/startTime/endTime', () => {
  it('HHMM 整數 → HH:mm 字串（§7.2 #9）', () => {
    const rows = extractOpenSch(DATE, NODE_DETERMINISTIC)
    assert.deepEqual(rows, [{ date: DATE, startTime: '09:00', endTime: '18:00' }])
  })

  it('每項只有 3 個 primitive key（零 sub-object）', () => {
    const rows = extractOpenSch(DATE, NODE_DETERMINISTIC)
    assertPrimitiveOnly(rows, ['date', 'startTime', 'endTime'], 'extractOpenSch')
  })

  it('壞 slot（9999 / 999）剔走；其餘保留', () => {
    const node = {
      practitionerOpenSchs: {
        day: 'WED',
        timeSlots: [
          { startTime: 2000, endTime: 2100 },
          { startTime: 9999, endTime: 1800 },
          { startTime: 900, endTime: 999 },
        ],
      },
    }
    const rows = extractOpenSch(DATE, node)
    assert.deepEqual(rows, [{ date: DATE, startTime: '20:00', endTime: '21:00' }])
  })

  it('practitionerOpenSchs 唔係 object / timeSlots 唔係 array → []', () => {
    assert.deepEqual(extractOpenSch(DATE, {}), [])
    assert.deepEqual(extractOpenSch(DATE, { practitionerOpenSchs: [] }), [])
    assert.deepEqual(extractOpenSch(DATE, { practitionerOpenSchs: { timeSlots: '900' } }), [])
    assert.deepEqual(extractOpenSch(DATE, null), [])
  })
})

describe('utcIsoToHkMin — UTC ISO → HK 分鐘數（dateStr 跨日檢查必傳）', () => {
  it('§7.2 #10：2026-08-19T01:30:00Z → 570', () => {
    assert.equal(utcIsoToHkMin('2026-08-19T01:30:00Z', DATE), 570)
  })
  it('2026-08-19T02:00:00Z → 600', () => {
    assert.equal(utcIsoToHkMin('2026-08-19T02:00:00Z', DATE), 600)
  })
  it('§7.2 #14：HK 00:30（UTC 前一日 16:30Z）落正確日 → 30', () => {
    assert.equal(utcIsoToHkMin('2026-08-19T16:30:00Z', '2026-08-20'), 30)
  })
  it('跨日檢查：HK 日期唔同 node 日期 → null', () => {
    assert.equal(utcIsoToHkMin('2026-08-19T16:30:00Z', DATE), null)
  })
  it('邊界：15:59:59Z → 23:59 HK = 1439；16:00:00Z 屬翌日 → null', () => {
    assert.equal(utcIsoToHkMin('2026-08-19T15:59:59Z', DATE), 1439)
    assert.equal(utcIsoToHkMin('2026-08-19T16:00:00Z', DATE), null)
  })
  it('壞輸入 → null', () => {
    assert.equal(utcIsoToHkMin('not-a-date', DATE), null)
    assert.equal(utcIsoToHkMin('', DATE), null)
    assert.equal(utcIsoToHkMin(null, DATE), null)
    assert.equal(utcIsoToHkMin(12345, DATE), null)
  })
})

describe('hhmmIntToStr — HHMM 整數 → HH:mm', () => {
  it('§7.2 #9：900→09:00 / 1800→18:00 / 2000→20:00', () => {
    assert.equal(hhmmIntToStr(900), '09:00')
    assert.equal(hhmmIntToStr(1800), '18:00')
    assert.equal(hhmmIntToStr(2000), '20:00')
  })
  it('邊界：0→00:00 / 2359→23:59', () => {
    assert.equal(hhmmIntToStr(0), '00:00')
    assert.equal(hhmmIntToStr(2359), '23:59')
  })
  it('非法：2500 / 999（分鐘 99）/ 2400 / 負數 / 非數字 → 拒', () => {
    assert.equal(hhmmIntToStr(2500), '')
    assert.equal(hhmmIntToStr(999), '')
    assert.equal(hhmmIntToStr(2400), '')
    assert.equal(hhmmIntToStr(-1), '')
    assert.equal(hhmmIntToStr('abc'), '')
    assert.equal(hhmmIntToStr(null), '')
    assert.equal(hhmmIntToStr(undefined), '')
  })
})
