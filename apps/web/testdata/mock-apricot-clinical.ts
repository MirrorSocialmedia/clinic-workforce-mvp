// ============================================================
// 決定性 Apricot 臨床 mock（cwi-followup-p1-20260915 — S0 stub 要求）
//
// CWM dev DB 無 APRICOT credential → 夜跑／回填／刷新 e2e 必須用呢個
// in-process callFn stub（跟 repo pattern：sync-availability getTestCallFn +
// p3-acceptance in-process route handler）。生產 hook 永遠 null → 真 API。
//
// 用法：
//   const mock = buildClinicalMock({ now: new Date('2026-09-15T03:00:00+08:00') })
//   await runClinicalIndexNightly({ callFn: mock.callFn, now: mock.now })
//
// fixture 固定（now 注入；scan 日 = now 嘅 HK 日 - 1）：
//   cp-std-001 P0001 apr-ty-001 91234567        9/14 10:00 st=4 + 9/22 st=0(未來) | STANDARD note | ttl800/os300
//   cp-tpl-002 P0002 apr-ty-001 91234567/61234567 9/14 11:00 st=4            | TEMPLATE storedTemplate（latestTemplate 空）| ttl1500/os1500
//   cp-no-003  P0003 apr-tkw-001 85291234567    9/14 09:00 st=-3（爽約）        | 無 note | 無 bill
//   cp-late-004 P0004 apr-ty-001 61234567       9/14 15:00 st=1                | 第一晚無 note（withLateNote toggle）| ttl400/os400
//
// 所有 row 帶 PII sub-object（personalIdentifier/address/email/medicalHistory）
// → e2e 斷言 API 回應零 PII marker（白名單外不出界）。
// ============================================================

import type { ClinicalCallFn } from '../src/lib/clinical-index/types'

const SCAN_DATE = '2026-09-14' // fixture 錨點（e2e now = 2026-09-15T03:00+08:00 → 昨日）

// ——— PII markers（e2e 負斷言用：回應 JSON 唔准出現任何一個）———
/** 非姓名 PII（phone 另計 HRAW）— #3 appointments 依 P0 合約回 patientName，
 *  所以 #3 / 總體掃描用 PII_CORE_MARKERS（姓名係 P0 白名單欄位）。 */
export const PII_CORE_MARKERS = [
  'A123456(7)', 'B234567(8)', 'C345678(9)', 'D456789(0)', // idNo
  'chan@example.com', 'lee@example.com', 'wong@example.com', 'cheung@example.com',
  '九龍旺角' , '香港島中環', '新界沙田', '將軍澳', // address
  '牙齦萎縮病史', '糖尿病病史', '高血壓病史', '哮喘病史', // medicalHistory
]

export const PII_MARKERS = [
  '陳大文', '李美玲', '黃志強', '張麗珍', // fullName
  ...PII_CORE_MARKERS,
]

interface MockOpts {
  now: Date
  /** cp-late-004 嘅 note 喺 toggle=true 之後先出現（7 日重掃 e2e）。 */
  withLateNote?: boolean
  /** 第 N 次 call 起 throw APRICOT_RATE_LIMITED（護欄 e2e）。0/undefined = 唔限。 */
  failAfterCalls?: number
  /** 每次 call 前 sleep 毫秒數（maxHours 護欄 e2e 決定性觸發用）。 */
  callDelayMs?: number
}

export interface ClinicalMock {
  callFn: ClinicalCallFn
  now: Date
  /** 全部 call 嘅 path（e2e 斷言 call 次數／形狀）。 */
  callLog: string[]
}

// ——— 病人主檔（search 回傳形狀 — MD §0.1 白名單外欄都齊，驗證過濾）———
const PATIENTS: Record<string, any> = {
  'cp-std-001': {
    cpId: 'cp-std-001', code: 'P0001', phoneNum: '91234567', lastVisitDate: SCAN_DATE,
    personalIdentifier: { fullName: '陳大文', idNo: 'A123456(7)' },
    address: '九龍旺角鴉翠街12號', email: 'chan@example.com',
    medicalHistory: '牙齦萎縮病史',
  },
  'cp-tpl-002': {
    cpId: 'cp-tpl-002', code: 'P0002', phoneNum: '91234567/61234567', lastVisitDate: SCAN_DATE,
    personalIdentifier: { fullName: '李美玲', idNo: 'B234567(8)' },
    address: '香港島中環皇后大道中1號', email: 'lee@example.com',
    medicalHistory: '糖尿病病史',
  },
  'cp-no-003': {
    cpId: 'cp-no-003', code: 'P0003', phoneNum: '85291234567', lastVisitDate: SCAN_DATE,
    personalIdentifier: { fullName: '黃志強', idNo: 'C345678(9)' },
    address: '新界沙田正街2號', email: 'wong@example.com',
    medicalHistory: '高血壓病史',
  },
  'cp-late-004': {
    cpId: 'cp-late-004', code: 'P0004', phoneNum: '61234567', lastVisitDate: SCAN_DATE,
    personalIdentifier: { fullName: '張麗珍', idNo: 'D456789(0)' },
    address: '將軍澳百勝角路3號', email: 'cheung@example.com',
    medicalHistory: '哮喘病史',
  },
}

// ——— 預約（UTC Z 格式 — 同 Apricot 實測一致；HK 日界 = +8）———
const APPOINTMENTS: Record<string, any[]> = {
  'cp-std-001': [
    {
      id: 'apt-std-2', conTime: '2026-09-22T02:00:00.000Z', // 9/22 10:00 HK（未來 — B 類）
      bookingStatus: 0, clinicId: 'apr-ty-001',
      visitReasons: [{ code: 'RECALL' }], providerCode: 'DR1',
      clinicPatient: { cpId: 'cp-std-001', code: 'P0001', phoneNum: '91234567', fullName: '陳大文' },
    },
    {
      id: 'apt-std-1', conTime: '2026-09-14T02:00:00.000Z', // 9/14 10:00 HK
      checkInTime: '2026-09-14T02:05:00.000Z',
      bookingStatus: 4, clinicId: 'apr-ty-001',
      visitReasons: [{ code: 'FILLING' }, { code: 'SCALE' }], providerCode: 'DR1',
      clinicPatient: { cpId: 'cp-std-001', code: 'P0001', phoneNum: '91234567', fullName: '陳大文' },
    },
  ],
  'cp-tpl-002': [
    {
      id: 'apt-tpl-1', conTime: '2026-09-14T03:00:00.000Z', // 9/14 11:00 HK
      checkInTime: '2026-09-14T03:10:00.000Z',
      bookingStatus: 4, clinicId: 'apr-ty-001',
      visitReasons: [{ code: 'FILLING' }], providerCode: 'DR2',
      clinicPatient: { cpId: 'cp-tpl-002', code: 'P0002', phoneNum: '91234567/61234567', fullName: '李美玲' },
    },
  ],
  'cp-no-003': [
    {
      id: 'apt-no-1', conTime: '2026-09-14T01:00:00.000Z', // 9/14 09:00 HK
      bookingStatus: -3, clinicId: 'apr-tkw-001', // 🔴 爽約明確 -3（鐵律 7）
      visitReasons: [{ code: 'CHECKUP' }], providerCode: 'DR3',
      clinicPatient: { cpId: 'cp-no-003', code: 'P0003', phoneNum: '85291234567', fullName: '黃志強' },
    },
  ],
  'cp-late-004': [
    {
      id: 'apt-late-1', conTime: '2026-09-14T07:00:00.000Z', // 9/14 15:00 HK
      bookingStatus: 1, clinicId: 'apr-ty-001',
      visitReasons: [{ code: 'EXTRACT' }], providerCode: 'DR1',
      clinicPatient: { cpId: 'cp-late-004', code: 'P0004', phoneNum: '61234567', fullName: '張麗珍' },
    },
  ],
}

// ——— 診症記錄（note.bookingId === appointment.id — 唯一錨點）———
function buildNotes(withLateNote: boolean): Record<string, any[]> {
  return {
    'cp-std-001': [
      {
        id: 'note-std-1', bookingId: 'apt-std-1',
        complaints: '左上後牙咬痛三星期',
        findings: '#26 深齲，探痛 (+)',
        diagnosis: 'Deep caries #26',
        actions: '預留根管治療',
        personalIdentifier: { fullName: '陳大文' },
      },
    ],
    'cp-tpl-002': [
      {
        id: 'note-tpl-1', bookingId: 'apt-tpl-1',
        // B 自訂樣板 — 填寫內容喺 storedTemplate（type=2 有文本）
        storedTemplate: {
          des: 'CS Cleaning Template v3',
          sections: [
            {
              questions: [
                { question: '主訴', type: 2, answer: { text: '定期洗牙' } },
                { question: '口腔檢查', type: 2, answer: { text: '牙石中度，齦緣輕微紅腫' } },
                { question: '處置', type: 2, answer: { text: '全口超音波洗牙' } },
                { question: '備註', type: 2, answer: { text: ' ' } }, // 空白 → 應被剔
                { question: '簽名欄', type: 1, answer: { text: 'DR2' } }, // 非 type=2 → 應被剔
              ],
            },
          ],
        },
        // 🔴 latestTemplate 同構造但 answer 全空 — 若被讀，e2e 會見到 'LATEST-LEAK'
        latestTemplate: {
          des: 'CS Cleaning Template v3',
          sections: [
            {
              questions: [
                { question: '主訴', type: 2, answer: { text: 'LATEST-LEAK' } },
                { question: '口腔檢查', type: 2, answer: { text: 'LATEST-LEAK' } },
              ],
            },
          ],
        },
        personalIdentifier: { fullName: '李美玲' },
      },
    ],
    'cp-no-003': [], // 爽約 — 無 note
    'cp-late-004': withLateNote
      ? [
          {
            id: 'note-late-1', bookingId: 'apt-late-1',
            complaints: '拔後傷口不適',
            findings: '#48 拔後血塊完整',
            diagnosis: 'Post-extraction',
            actions: '複檢一週',
            personalIdentifier: { fullName: '張麗珍' },
          },
        ]
      : [], // 第一晚無（隔日補記錄 — 7 日重掃 case）
  }
}

// ——— 帳單（bills/search 按 body patients + 日期範圍回）———
const BILLS: Record<string, any[]> = {
  'cp-std-001': [
    { id: 'bill-std-1', billTime: '2026-09-14T02:10:00.000Z', isVoid: false, ttlAmt: 800, osAmt: 300 },
  ],
  'cp-tpl-002': [
    { id: 'bill-tpl-1', billTime: '2026-09-14T03:15:00.000Z', isVoid: false, ttlAmt: 1500, osAmt: 1500 },
  ],
  'cp-no-003': [], // 爽約無帳
  'cp-late-004': [
    { id: 'bill-late-1', billTime: '2026-09-14T07:05:00.000Z', isVoid: false, ttlAmt: 400, osAmt: 400 },
  ],
}

export function buildClinicalMock(opts: MockOpts): ClinicalMock {
  const notes = buildNotes(!!opts.withLateNote)
  const callLog: string[] = []
  let n = 0
  // HK 日界匹配（window 值係 +08 語義 — 唔好用 UTC 字串前綴）
  const hkDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' })

  const callFn: ClinicalCallFn = async (path, init) => {
    if (opts.callDelayMs) await new Promise((r) => setTimeout(r, opts.callDelayMs))
    n++
    callLog.push(path)
    if (opts.failAfterCalls && n >= opts.failAfterCalls) {
      throw new Error('APRICOT_RATE_LIMITED')
    }

    // 1) clinic-patients/search（固定 size 50；page 0 → 4 人，page ≥1 → []）
    if (path.startsWith('/services/aepsmsope/api/clinic-patients/search')) {
      const page = Number(/page=(\d+)/.exec(path)?.[1] ?? 0)
      const body = init?.body ? JSON.parse(init.body) : null
      const startRaw = body?.params?.find((p: any) => p.key === 'lastVisitStartDate')?.value
      const endRaw = body?.params?.find((p: any) => p.key === 'lastVisitEndDate')?.value
      const start = startRaw ? hkDay.format(new Date(startRaw)) : null
      const end = endRaw ? hkDay.format(new Date(endRaw)) : null
      const matched = Object.values(PATIENTS).filter((p) => p.lastVisitDate === start && p.lastVisitDate <= (end ?? p.lastVisitDate))
      return page === 0 ? matched : []
    }

    // 2) appointments/patient/{cpId}
    const apptM = /\/services\/aepsmsope\/api\/appointments\/patient\/([^/?]+)/.exec(path)
    if (apptM) return APPOINTMENTS[apptM[1]] ?? []

    // 3) consultation-notes/patient/{cpId}
    const noteM = /\/services\/aepsmsope\/api\/consultation-notes\/patient\/([^/?]+)/.exec(path)
    if (noteM) return notes[noteM[1]] ?? []

    // 4) bills/search（body: patients details[0] + startDate/endDate）
    if (path.startsWith('/services/aepsmsbill/api/bills/search')) {
      const body = init?.body ? JSON.parse(init.body) : null
      const cpId = body?.params?.find((p: any) => p.key === 'patients')?.details?.[0]
      const start = body?.params?.find((p: any) => p.key === 'startDate')?.value
      const end = body?.params?.find((p: any) => p.key === 'endDate')?.value
      return (BILLS[cpId] ?? []).filter((b) => b.billTime >= start && b.billTime <= end)
    }

    throw new Error(`MOCK_UNEXPECTED_PATH: ${path}`)
  }

  return { callFn, now: opts.now, callLog }
}
