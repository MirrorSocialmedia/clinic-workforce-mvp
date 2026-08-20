/**
 * ★ cw-pa: mock Apricot availability API — P2/P3/P4 離線驗收 harness（commit 保留做回归）。
 * 仿真 P1 fixture 結構 + 真 PII 欄位（clinicPatient / visitReasons / remarkByDoctor /
 *    createdBy）— 每筆 booking 都帶完整 PII sub-object，驗證白名單 + 零 PII 入庫。
 *
 * 數據設計對應 spec §7.2：
 *  - #10 LAU day0 第一筆 570–600 (09:30–10:00)
 *  - #12 LAU day0 11:15–11:45 四筆重疊 (675–705)
 *  - #13 TONG day0 零 booking（另有一筆跨日筆必被排除）
 *  - #15 isRemoved: true 唔入庫
 *  - #16 status 0 / 4 混合
 *  - #9  HO day0 有 2000 (20:00) slot
 *  - #8  YEUNG / MF Clinic（+ run A 嘅 LAU）= unknown practitioner
 *
 * ★ 每筆 booking 都帶完整 PII sub-object（clinicPatient / visitReasons /
 *    remarkByDoctor / createdBy）—— 驗證白名單 + 零 PII 入庫。
 */

// ─── date helpers ───────────────────────────────────────────────────────
function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
/** HK 某日某分鐘 → ISO UTC Z（HK = UTC+8） */
function hkIso(dateStr: string, min: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d, Math.floor(min / 60), min % 60) - 8 * 3600 * 1000
  return new Date(t).toISOString().replace('.000Z', 'Z')
}

// ─── PII payload（合成，來自 P1 fixture 同型）──────────────────────────────
let piiSeq = 0
function piiPatient(): any {
  piiSeq++
  return {
    id: 90000 + piiSeq,
    code: `PT${String(piiSeq).padStart(4, '0')}`,
    fullName: '陳大文',
    personalIdentifier: 'A123456(7)',
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
}
function mkBooking(dateStr: string, startMin: number, endMin: number, status: number, isRemoved = false) {
  return {
    id: `bk-mock-${dateStr}-${startMin}-${endMin}-${Math.random().toString(36).slice(2, 8)}`,
    code: `AP${dateStr.replace(/-/g, '')}${startMin}`,
    cpId: `cp-mock-${dateStr}-${startMin}`,
    patientId: 90000 + startMin,
    bookingTime: hkIso(dateStr, startMin),
    bookingEndTime: hkIso(dateStr, endMin),
    bookingStatus: status,
    isRemoved,
    createdBy: 'JOAN NURSE',
    lastModifiedBy: 'JOAN NURSE',
    visitReasons: [{ code: 'RV', des: 'PAIN' }],
    remarkByDoctor: 'after mos & implant pain',
    clinicPatient: piiPatient(),
  }
}
function mkNode(p: { id: string; code: string; fullName: string }, day: string, slots: [number, number][], bookings: any[]) {
  return {
    practitioner: { id: p.id, code: p.code, fullName: p.fullName, nickname: p.fullName },
    practitionerOpenSchs: {
      day: 'WED',
      timeSlots: slots.map(([startTime, endTime]) => ({ startTime, endTime })),
    },
    bookingDetail: bookings,
  }
}

// ─── practitioner ids（spec §2.1 實見值 + 合成值）────────────────────────
const P = {
  LAU: { id: '695e6e511e430c48022a7690', code: 'LAU', fullName: 'Dr. Lau Ho Yin, Samson' },
  YEUNG: { id: '695ff0c999883d05d0582402', code: 'YEUNG', fullName: 'Dr. Yeung' },
  TONG: { id: '695ff0c999883d05d0582401', code: 'TONG', fullName: 'Dr. Tong' },
  MF: { id: '696604810fb31f000937a8c4', code: '002', fullName: 'MF Clinic' }, // ★ spec §2.1: code '002'
  HO: { id: '69a000000000000000000001', code: 'HO', fullName: 'Dr. Ho' },
  MA: { id: '69a000000000000000000002', code: 'MA', fullName: 'Dr. Ma' },
  TSE: { id: '69a000000000000000000003', code: 'TSE', fullName: 'Dr. Tse' },
  YIU: { id: '69a0000000000000000000004', code: 'YIU', fullName: 'Dr. Yiu' },
  AEGIS: { id: '69a000000000000000000006', code: 'AEGIS', fullName: 'Dr. Aegis' },
}

export interface MockCtx {
  failClinic?: string        // openSchClinicId 命中 → throw（#17 模擬）
  failMessage?: string
  calledClinics: string[]    // harness 用嚟斷言（青衣永遠唔喺入面）
}

/** mock Apricot getOverviewAppointments */
export function mockCall(path: string, ctx: MockCtx): Promise<any> {
  const qs = new URLSearchParams(path.split('?')[1] ?? '')
  const clinicId = qs.get('openSchClinicId') ?? ''
  ctx.calledClinics.push(clinicId)

  if (ctx.failClinic && clinicId === ctx.failClinic) {
    return Promise.reject(new Error(ctx.failMessage ?? 'APRICOT_HTTP_500: mock injected failure'))
  }

  const start = qs.get('startDate')!
  const end = qs.get('endDate')!
  const days: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d)
  if (days.length !== 7) throw new Error(`mock: 預期 7 日窗口，得 ${days.length}`)

  const day0 = days[0], day1 = days[1], day2 = days[2], day3 = days[3]
  const ci = Number(clinicId.slice(-1)) || 0 // per-clinic 變化（#7 隔離驗證）

  const out: any = { meta: { clinic: 'non-date-key-must-be-filtered' } }
  for (const [i, d] of days.entries()) {
    const appts: any = {}

    // LAU：7 日開診；day0 = 570/600 首筆 + 675/705×4 重疊 + 900/930 st4 + 1 isRemoved
    const lauBk =
      d === day0
        ? [
            mkBooking(d, 570, 600, 0),
            mkBooking(d, 675, 705, 0),
            mkBooking(d, 675, 705, 0),
            mkBooking(d, 675, 705, 0),
            mkBooking(d, 675, 705, 0),
            mkBooking(d, 900, 930, 4),
            mkBooking(d, 615, 645, 0, true), // ★ isRemoved → 唔入庫（#15）
          ]
        : d === day1
          ? [mkBooking(d, 600, 630, 4)]
          : []
    appts[P.LAU.id] = mkNode(P.LAU, d, [[900, 1800]], lauBk)

    // TONG：day0 零 booking（#13）+ 1 筆跨日（必排除）；day2 有 HK 00:30 遲夜筆（UTC 落前一日）
    const tongBk: any[] = []
    if (d === day0) {
      // 跨日筆：HK 前一日 22:00–22:30 → utcIsoToHkMin 必 reject
      tongBk.push({
        ...mkBooking(addDays(d, -1), 1320, 1350, 0),
        bookingTime: hkIso(addDays(d, -1), 1320),
        bookingEndTime: hkIso(addDays(d, -1), 1350),
      })
    } else if (d === day1) {
      tongBk.push(mkBooking(d, 540 + ci * 30, 570 + ci * 30, 0)) // per-clinic 差異
    } else if (d === day2) {
      tongBk.push(mkBooking(d, 30, 60, 0)) // HK 00:30–01:00（UTC 係前一日 —— 但要入庫）
    } else if (d === day3) {
      tongBk.push(mkBooking(d, 1200, 1230, 4))
    }
    appts[P.TONG.id] = mkNode(P.TONG, d, d === day0 ? [[1000, 1700]] : [[900, 1800]], tongBk)

    // HO：day0 雙 slot（900–1200 + 2000–2200 → #9 20:00）
    appts[P.HO.id] = mkNode(
      P.HO, d,
      d === day0 ? [[900, 1200], [2000, 2200]] : [[900, 1800]],
      d === day0 ? [mkBooking(d, 540, 570, 0), mkBooking(d, 1200, 1230, 0)] : d === day1 ? [mkBooking(d, 600, 630, 0)] : [],
    )

    // MA / TSE / YIU / AEGIS：開診 only
    if (i === 0 || i === 1) appts[P.MA.id] = mkNode(P.MA, d, [[900, 1800]], [])
    if (i === 0) appts[P.TSE.id] = mkNode(P.TSE, d, [[900, 1800]], [])
    if (i === 1) appts[P.YIU.id] = mkNode(P.YIU, d, [[900, 1800]], [])
    if (i <= 2) appts[P.AEGIS.id] = mkNode(P.AEGIS, d, [[900, 1800]], [])

    // YEUNG（永遠 unknown）：day0/day1
    if (i <= 1) appts[P.YEUNG.id] = mkNode(P.YEUNG, d, [[900, 1800]], [mkBooking(d, 660, 690, 0)])
    // MF Clinic（永遠 unknown pseudo）：7 日
    appts[P.MF.id] = mkNode(P.MF, d, [[900, 1800]], [mkBooking(d, 540, 570, 0)])

    out[d] = { appointments: appts, blocks: [], groupClasses: [] }
  }

  return Promise.resolve(out)
}

export { hkIso, addDays }
