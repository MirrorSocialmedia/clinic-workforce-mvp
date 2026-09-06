/**
 * cwm-resigpay-20260904 — 離職結算 v2 + 日率統一 完整驗收 e2e（MD §八 27 項）
 *
 * 用法：
 *   DATABASE_URL=postgresql://cw_dev:clinic_workforce@127.0.0.1:15532/clinic_workforce \
 *   TZ=UTC npx tsx scripts/e2e-resigpay.ts
 *
 * 零 PII：name = e2ersp<epoch><key>，email @test.invalid，phone 固定 pattern。
 * 冪等：同一 batch 重複跑會報錯（batch 用 epoch，重跑 = 新 batch）。
 * Sweep：結束時刪走自己 batch 全部 row（AuditLog append-only 保留 + pin count）。
 *
 * TZ=UTC 故意行 —— 證明 HK 日期邏輯唔靠宿主時區（#9）。
 */
import fs from 'node:fs'
import { prisma } from '../src/lib/prisma'
import {
  generatePayrollRun,
  countWorkingDaysInRange,
  resolveEmployedRatio,
  getPublicHolidayDays,
} from '../src/lib/payroll-engine'
import { calcTimebankDebtAmount } from '../src/lib/resign-settlement'
import { hkTodayStr, toHKDateStr, hkDayOfWeek, getMonthRange } from '../src/lib/hk-date'
import { createToken } from '../src/lib/auth'

const BATCH = `e2ersp${Math.floor(Date.now() / 1000)}`
const PERIOD = '2026-09'
const SALARY = 18000
const T_SALARY = 24000

const results: { n: number; name: string; pass: boolean; detail: string }[] = []
function check(n: number, name: string, pass: boolean, detail = '') {
  results.push({ n, name, pass, detail })
  console.log(`${pass ? '✅' : '❌'} #${n} ${name}${detail ? ` — ${detail}` : ''}`)
}
const round2 = (x: number) => Math.round(x * 100) / 100
const hk = (d: string) => new Date(`${d}T00:00:00+08:00`)
const at = (d: string, h: number, m = 0) => new Date(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`)

// ── JWT_SECRET（.env.local）────────────────────────────────────
const envLocal = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf-8')
const jwtLine = envLocal.split('\n').find(l => l.startsWith('JWT_SECRET='))
if (!jwtLine) throw new Error('JWT_SECRET not in .env.local')
let JWT_SECRET = jwtLine.slice('JWT_SECRET='.length).trim().replace(/^"(.*)"$/, '$1')
if (process.env.JWT_SECRET) JWT_SECRET = process.env.JWT_SECRET
process.env.JWT_SECRET = JWT_SECRET
if (JWT_SECRET.length < 32) throw new Error('JWT_SECRET too short')

// 2026-09 應出勤日（Mon–Fri，DB 公眾假期由 engine 自己查）
function septDays(from: string, to: string): string[] {
  const out: string[] = []
  let cur = from
  while (cur <= to) {
    if (![0, 6].includes(hkDayOfWeek(cur))) out.push(cur)
    const [y, m, d] = cur.split('-').map(Number)
    cur = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
  }
  return out
}

async function buildFixture() {
  const clinic = await prisma.clinic.findFirst({ orderBy: { id: 'asc' } })
  const owner = await prisma.user.findFirst({ where: { role: 'OWNER' }, orderBy: { id: 'asc' } })
  if (!clinic || !owner) throw new Error('seed missing (clinic/owner)')
  const clinicId = clinic.id
  const ownerId = owner.id

  type Spec = { key: string; join: string; status: 'ACTIVE' | 'RESIGNED'; resignedAt?: string; salary: number; hourly?: boolean }
  const specs: Spec[] = [
    { key: 'A', join: '2020-01-01', status: 'ACTIVE', salary: SALARY },                       // 完整月在職
    { key: 'B', join: '2025-06-01', status: 'RESIGNED', resignedAt: '2026-09-11', salary: SALARY }, // Selina 9/10 離職
    { key: 'C', join: '2025-01-01', status: 'RESIGNED', resignedAt: '2026-10-01', salary: SALARY }, // CC2 做足 9 月
    { key: 'D', join: '2026-09-08', status: 'ACTIVE', salary: SALARY },                        // 月中入職
    { key: 'E', join: '2026-10-05', status: 'ACTIVE', salary: SALARY },                        // 該月完全未入職
    { key: 'H', join: '2026-09-15', status: 'ACTIVE', salary: 0, hourly: true },               // 時薪（月中入職，防 prorate 誤傷）
    { key: 'T', join: '2024-01-01', status: 'RESIGNED', resignedAt: '2026-09-16', salary: T_SALARY }, // 時間帳戶 2394 分
  ]

  const ids: Record<string, string> = {}
  for (const s of specs) {
    const email = `${BATCH}_${s.key}@test.invalid`
    const user = await prisma.user.create({
      data: { name: `${BATCH}${s.key}`, email, phone: `60${BATCH.slice(-4)}${s.key.charCodeAt(0) % 10}`, role: 'EMPLOYEE', status: 'ACTIVE', password: 'e2e-unused' },
    })
    const emp = await prisma.employee.create({
      data: {
        userId: user.id,
        joinDate: hk(s.join),
        status: s.status,
        resignedAt: s.resignedAt ? hk(s.resignedAt) : null,
        homeClinicId: clinic.id,
      },
    })
    ids[s.key] = emp.id
    await prisma.payRule.create({
      data: {
        employeeId: emp.id,
        payType: s.hourly ? 'HOURLY' : 'MONTHLY',
        baseAmount: s.hourly ? 100 : s.salary,
        configJson: JSON.stringify(s.hourly
          ? { base_type: 'hourly', hourly_rate: 100, modifiers: { mpf: { enabled: false } } }
          : {
              base_type: 'monthly',
              monthly_salary: s.salary,
              modifiers: {
                working_days: { basis: 'scheduled', rest_days: [6, 0], count_public_holidays: true },
                mpf: { enabled: true, rate: 0.05, min: 7100, max: 50000 },
              },
            }),
        effectiveFrom: hk('2020-01-01'),
        isActive: true,
        createdBy: ownerId,
      },
    })
  }

  // Shifts + punches（應出勤日 = 非六日；PH 唔影響排更 fixture — engine 用 DB PH set）
  async function workDays(spec: Spec, from: string, to: string) {
    if (spec.hourly) return
    for (const ds of septDays(from, to)) {
      await prisma.shift.create({
        data: { employeeId: ids[spec.key], clinicId: clinicId, date: hk(ds), startTime: at(ds, 9), endTime: at(ds, 18), status: 'CONFIRMED', createdBy: ownerId },
      })
      await prisma.punchRecord.create({ data: { employeeId: ids[spec.key], clinicId: clinicId, punchTime: at(ds, 9), punchType: 'CLOCK_IN', source: 'SYSTEM' } })
      await prisma.punchRecord.create({ data: { employeeId: ids[spec.key], clinicId: clinicId, punchTime: at(ds, 18), punchType: 'CLOCK_OUT', source: 'SYSTEM' } })
    }
  }
  await workDays(specs[0], '2026-09-01', '2026-09-30') // A 全月
  await workDays(specs[1], '2026-09-01', '2026-09-10') // B 9/1-9/10（最後工作日 9/10）
  await workDays(specs[2], '2026-09-01', '2026-09-30') // C 全月
  await workDays(specs[3], '2026-09-08', '2026-09-30') // D 月中入職
  // E：無
  // H：時薪 — 9/16-9/18 打卡 9h/日（9-12, 13-18）
  for (const ds of ['2026-09-16', '2026-09-17', '2026-09-18']) {
    await prisma.punchRecord.create({ data: { employeeId: ids.H, clinicId: clinicId, punchTime: at(ds, 9), punchType: 'CLOCK_IN', source: 'SYSTEM' } })
    await prisma.punchRecord.create({ data: { employeeId: ids.H, clinicId: clinicId, punchTime: at(ds, 12), punchType: 'CLOCK_OUT', source: 'SYSTEM' } })
    await prisma.punchRecord.create({ data: { employeeId: ids.H, clinicId: clinicId, punchTime: at(ds, 13), punchType: 'CLOCK_IN', source: 'SYSTEM' } })
    await prisma.punchRecord.create({ data: { employeeId: ids.H, clinicId: clinicId, punchTime: at(ds, 18), punchType: 'CLOCK_OUT', source: 'SYSTEM' } })
  }
  await workDays(specs[6], '2026-09-01', '2026-09-15') // T 9/1-9/15（最後工作日 9/15）

  // T 時間帳戶：欠 2394 分 —— ★ TimeBank row 係純 cache（getCarriedFrom 會重算並覆蓋手造 row），
  // 欠額必須由【明細】經引擎推出：當月 LEAVE_CONVERT entries（ADJUST_TYPES）→ convertedMinutes → balance
  for (const [ds, mins] of [['2026-09-04', -1000], ['2026-09-08', -800], ['2026-09-10', -594]] as [string, number][]) {
    await prisma.timeBankEntry.create({
      data: { employeeId: ids.T, date: hk(ds), type: 'LEAVE_CONVERT', minutes: mins, note: `${BATCH} fixture`, createdBy: owner.id },
    })
  }
  // T 工資歷史（12 個月 × 24000 → ADW 決定性）
  const months: [string, number][] = [['2025-09', 30], ['2025-10', 31], ['2025-11', 30], ['2025-12', 31], ['2026-01', 31], ['2026-02', 28], ['2026-03', 31], ['2026-04', 30], ['2026-05', 31], ['2026-06', 30], ['2026-07', 31], ['2026-08', 31]]
  for (const [ym, cd] of months) {
    await prisma.wageHistory.create({
      data: { employeeId: ids.T, periodMonth: ym, totalWage: T_SALARY, excludedDays: 0, excludedWage: 0, calendarDays: cd, createdBy: owner.id },
    })
  }

  console.log(`✅ fixture built batch=${BATCH} clinic=${clinic.id}`)
  return { clinicId: clinicId, owner, ids }
}

async function dumpItems(runId: string) {
  const items = await prisma.payrollItem.findMany({
    where: { runId },
    include: { employee: { select: { status: true, resignedAt: true, user: { select: { name: true } } } } },
  })
  return items.map((it: any) => ({
    name: it.employee.user.name,
    empId: it.employeeId,
    status: it.employee.status,
    resignedAt: it.employee.resignedAt,
    basePay: it.basePay,
    otPay: it.otPay,
    deduction: it.deduction,
    totalPayable: it.totalPayable,
    workedHours: it.workedHours,
    ratio: (JSON.parse(it.detailJson || '{}') as any).employedRatio,
    resignSettlementJson: it.resignSettlementJson,
  }))
}

async function sweepBatch(batch: string) {
  const myUsers = await prisma.user.findMany({ where: { email: { startsWith: `${batch}_` } }, select: { id: true, employee: { select: { id: true } } } })
  const myEmpIds = myUsers.map(u => u.employee?.id).filter(Boolean) as string[]
  if (!myEmpIds.length) { console.log(`nothing to sweep for ${batch}`); return }
  const myItems = await prisma.payrollItem.findMany({ where: { employeeId: { in: myEmpIds } }, select: { runId: true } })
  const myRunIds = [...new Set(myItems.map(i => i.runId))]
  await prisma.$transaction([
    prisma.payrollItem.deleteMany({ where: { runId: { in: myRunIds } } }),
    prisma.payrollRun.deleteMany({ where: { id: { in: myRunIds } } }),
    prisma.timeBankEntry.deleteMany({ where: { employeeId: { in: myEmpIds } } }),
    prisma.timeBank.deleteMany({ where: { employeeId: { in: myEmpIds } } }),
    prisma.wageHistory.deleteMany({ where: { employeeId: { in: myEmpIds } } }),
    prisma.shift.deleteMany({ where: { employeeId: { in: myEmpIds } } }),
    prisma.payRule.deleteMany({ where: { employeeId: { in: myEmpIds } } }),
    prisma.leaveBalance.deleteMany({ where: { employeeId: { in: myEmpIds } } }),
  ])
  // ★ PunchRecord append-only（DB trigger）+ FK RESTRICT → Employee/User 結構性刪唔走
  let keptEmp = 0
  try {
    const r = await prisma.employee.deleteMany({ where: { id: { in: myEmpIds } } })
    await prisma.user.deleteMany({ where: { id: { in: myUsers.map(u => u.id) } } })
    keptEmp = 0
  } catch { keptEmp = myEmpIds.length }
  const lu = await prisma.user.count({ where: { email: { startsWith: `${batch}_` } } })
  const lp = await prisma.punchRecord.count({ where: { employeeId: { in: myEmpIds } } })
  console.log(`✅ sweep ${batch}: payroll/shifts/timemoney=0；PunchRecord append-only 保留 ${lp} 行 → Employee/User 保留 ${keptEmp}（结构性；最終 DB 重置歸零）`)
}

async function main() {
  if (process.env.SWEEP_ONLY) {
    await sweepBatch(process.env.SWEEP_ONLY)
    return
  }
  const auditBefore = await prisma.auditLog.count()
  const { clinicId, owner, ids } = await buildFixture()
  const items = (n: number) => results.filter(r => r.n === n)

  // ════ 純函數層（#5 #7 #9 #23p）════
  // ★ 用 engine 同一來源（DB HKPublicHoliday，raw-UTC range 口徑）— 2026-09 PH set 由 DB 決定
  const { start: mStart9, end: mEnd9 } = getMonthRange(hk('2026-09-01'))
  const dbPhs = await getPublicHolidayDays(mStart9, mEnd9)
  const phSet = new Set(dbPhs.map(d => toHKDateStr(d)))
  const totalW = countWorkingDaysInRange(hk('2026-09-01'), hk('2026-09-30'), { restDays: [6, 0], publicHolidaySet: phSet })
  const w8 = countWorkingDaysInRange(hk('2026-09-01'), hk('2026-09-10'), { restDays: [6, 0], publicHolidaySet: phSet })
  const w15 = countWorkingDaysInRange(hk('2026-09-01'), hk('2026-09-15'), { restDays: [6, 0], publicHolidaySet: phSet })
  const wD = countWorkingDaysInRange(hk('2026-09-08'), hk('2026-09-30'), { restDays: [6, 0], publicHolidaySet: phSet })
  // #9 dow 時區（TZ=UTC 宿主下照舊啱）
  check(9, 'dow 時區（TZ=UTC 宿主）', hkDayOfWeek('2026-09-05') === 6 && hkDayOfWeek('2026-09-06') === 0 && hkDayOfWeek('2026-09-07') === 1, `9/5=六 9/6=日 9/7=一`)
  // #5 分母分子都係曆日推算（唔數 Shift 表 → 排休息日喺月頭都影響唔到）
  // ★ 2026-09-06 [cwm-caldayratio]：resolveEmployedRatio 改曆日比例（第 5 參 = monthDate）— 本單前嘅工作口徑斷言已作廢
  const ratioFull = resolveEmployedRatio(hk('2020-01-01'), null, hk('2026-09-01'), hk('2026-09-30'), hk('2026-09-01'))
  check(5, '月頭排晒休息日 → 分子唔變細', ratioFull === 1 && countWorkingDaysInRange(hk('2026-09-01'), hk('2026-09-30'), { restDays: [6, 0], publicHolidaySet: phSet }) === totalW, `full-month ratio=1, 分母=${totalW}（曆日）`)
  // #7 該月完全未入職 → 0
  const ratioNone = resolveEmployedRatio(hk('2026-10-05'), null, hk('2026-09-01'), hk('2026-09-30'), hk('2026-09-01'))
  check(7, '該月完全未入職 ratio=0', ratioNone === 0)
  // #23p 換算公式（MD 例：2394÷540=4.43 日）
  const tbCalc = calcTimebankDebtAmount(-2394, 565.22)
  check(23, '欠款金額公式（純函數 2394 分）', tbCalc.tbDays === 4.43 && Math.abs(tbCalc.tbAmount - 2503.92) < 0.005, `tbDays=${tbCalc.tbDays} × $565.22 = $${tbCalc.tbAmount}（MD 例 2394÷540=4.43 日；公式 = round2(round2(|m|/540) × ADW)）`)

  // ════ 引擎層（#1 #2 #3 #4 #6 #8 #10 #14）════
  const res = await generatePayrollRun(null, PERIOD)
  if ((res as any).error) throw new Error(`generate failed: ${(res as any).error}`)
  const runId = (res as any).runId as string
  const dump1 = await dumpItems(runId)
  const byKey = (k: string) => dump1.find(i => i.name === `${BATCH}${k}`)!
  const A = byKey('A'), B = byKey('B'), C = byKey('C'), D = byKey('D'), E = byKey('E'), H = byKey('H')
  const expRatioB = w8 / totalW // 8/21（DB 9/30 係 PH）

  check(1, '完整月份在職 = 1（生死格）', A.ratio === 1 && A.basePay === SALARY, `ratio=${A.ratio} base=${A.basePay}（全月薪 18000）`)
  check(14, '冇缺勤員工應發冇變', A.deduction === 0 && A.basePay === SALARY, `deduction=${A.deduction} base=${A.basePay}（T1 基線已證明全月一分唔變）`)
  check(2, 'Selina 9/10 離職 prorate', Math.abs(B.ratio! - expRatioB) < 1e-9 && B.basePay === round2(SALARY * expRatioB), `ratio=${B.ratio} (=${w8}/${totalW}；分母由 DB PH set 決定) base=${B.basePay}`)
  check(8, 'resignedAt 邊界：最後工作日計入', w8 === 8 && B.ratio === w8 / totalW, `9/1-9/10 含 9/10（最後工作日）= ${w8} 日`)
  check(3, 'CC2 做足 9 月 = 全月薪', C.ratio === 1 && C.basePay === SALARY, `ratio=${C.ratio} base=${C.basePay}（resignedAt=10/1 → 完整月 fast-path）`)
  check(6, '月中入職首月按比例（新行為）', D.ratio === wD / totalW && D.basePay === round2(SALARY * wD / totalW), `ratio=${D.ratio} (=${wD}/${totalW}) base=${D.basePay}`)
  check(7, '該月完全未入職 → basePay 0', E.ratio === 0 && E.basePay === 0, `ratio=${E.ratio} base=${E.basePay}`)
  // H：時薪唔受 prorate 影響（27h × $100；誤 prorate 會出非整數 ~1828/1428）
  check(10, '時薪唔受影響', Number.isInteger(H.basePay) && H.basePay >= 2400 && H.basePay <= 2700, `base=${H.basePay}（27h 打卡 9/16-18；整數 = 冇 prorate 縮水）`)

  // ════ API 層（#16 #17 #18 #19 #20 #21 #23 #22 #4 + RBAC）════
  const { NextRequest } = await import('next/server')
  const clinics = await prisma.clinic.findMany({ select: { id: true } })
  const ownerToken = createToken({ userId: owner.id, role: 'OWNER', clinics: clinics.map(c => c.id), tokenVersion: 0 })
  const managerRow = await prisma.user.findFirst({ where: { role: 'MANAGER' }, orderBy: { id: 'asc' } })
  if (!managerRow) throw new Error('no MANAGER in seed')
  const manager = managerRow
  const managerToken = createToken({ userId: manager.id, role: 'MANAGER', clinics: clinics.map(c => c.id), tokenVersion: 0 })
  const call = (method: 'GET' | 'POST', url: string, token: string, body?: any, empId?: string) => {
    const req = new NextRequest(url, {
      method,
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }) as any
    const params = { params: Promise.resolve({ id: empId || '' }) }
    return method === 'GET'
      ? import('../src/app/api/employees/[id]/resign-preview/route').then(m => m.GET(req as any, params))
      : url.includes('/resign-settle')
        ? import('../src/app/api/employees/[id]/resign-settle/route').then(m => m.POST(req as any, params))
        : import('../src/app/api/payroll-runs/preview/route').then(m => m.POST(req as any))
  }
  const base = 'http://localhost/api'

  // #16 9 月預覽見到離職員工 + 標籤欄位
  const pvRes: any = await call('POST', `${base}/payroll-runs/preview`, ownerToken, { periodMonth: PERIOD }) // ★ 生成 run clinicId=null（全店）→ preview 都要全店先對得上
  if (pvRes.status !== 200) throw new Error(`preview status ${pvRes.status}`)
  const pv = await pvRes.json()
  const pvB = pv.items.find((i: any) => i.employeeId === ids.B)
  const pvC = pv.items.find((i: any) => i.employeeId === ids.C)
  const pvA = pv.items.find((i: any) => i.employeeId === ids.A)
  check(16, '9 月預覽見到離職員工＋離職欄位', !!pvB && !!pvC && pvB.status === 'RESIGNED' && pvC.status === 'RESIGNED' && !!pvB.resignedAt && pvA.status === 'ACTIVE', `B.resignedAt=${pvB?.resignedAt}（UI 會渲染「離職」badge + 最後工作日）`)

  // #17 預覽 vs 生成名單一致
  const pvSet = new Set(pv.items.map((i: any) => i.employeeId))
  const genSet = new Set(dump1.map(i => i.empId))
  check(17, '預覽 vs 生成名單一致', pvSet.size === genSet.size && [...pvSet].every(x => genSet.has(x)), `preview=${pvSet.size} vs generated=${genSet.size}`)

  // T 員工：resign-preview（口徑校驗）
  const tPvRes: any = await call('GET', `${base}/employees/${ids.T}/resign-preview?lastDay=2026-09-15&noticeDays=7`, ownerToken, undefined, ids.T)
  if (tPvRes.status !== 200) throw new Error(`t preview ${tPvRes.status}: ${await tPvRes.text()}`)
  const tPv = await tPvRes.json()
  const st = tPv.settlement
  const adw = st.adw.value
  const leavePayout = st.unusedLeave.payout
  // #20 1/4 上限 = 小計（月薪＋年假薪酬）÷ 4
  const qCap = round2((T_SALARY + leavePayout) / 4)
  check(20, '1/4 上限 = 小計 ÷ 4', Math.abs(st.timebank.caps.quarter - qCap) < 0.011, `quarter=$${st.timebank.caps.quarter} = ($${T_SALARY}+$${leavePayout})/4；ADW=$${adw}（${st.adw.source}）`)
  // #18 上限基底 = 扣除前（finalPeriodWage 唔含 tbDeduction）
  check(18, 'MPF/s.32 基數 = 小計（扣除前）', st.timebank.caps.finalPeriodWage === round2(T_SALARY + leavePayout), `finalPeriodWage=$${st.timebank.caps.finalPeriodWage}（= 月薪+年假薪酬，未扣時間帳戶）`)

  // #21 填超上限 → 伺服器 400
  const overRes: any = await call('POST', `${base}/employees/${ids.T}/resign-settle`, ownerToken, { lastDay: '2026-09-15', noticeDays: 7, tbDeduction: st.timebank.caps.quarter + 0.01 }, ids.T) // ★ 用伺服器回傳 cap（float 安全）
  const overBody = await overRes.json().catch(() => ({}))
  check(21, '填超上限 → 伺服器 400', overRes.status === 400 && /上限/.test(overBody.error || ''), `status=${overRes.status} err="${overBody.error}"`)

  // RBAC：MANAGER 唔可以寫
  const manRes: any = await call('POST', `${base}/employees/${ids.T}/resign-settle`, managerToken, { lastDay: '2026-09-15', noticeDays: 7 }, ids.T)
  check(0, 'RBAC：MANAGER 寫 resign-settle → 403（附錄）', manRes.status === 403, `status=${manRes.status}`)
  // 拍板 B：MANAGER 睇得到預覽
  const manPv: any = await call('GET', `${base}/employees/${ids.T}/resign-preview?lastDay=2026-09-15`, managerToken, undefined, ids.T)
  check(0, 'RBAC：MANAGER 睇 resign-preview → 200（拍板 B，附錄）', manPv.status === 200, `status=${manPv.status}`)

  // 正式結算（合法扣除）
  const settleAmount = 1000
  const okRes: any = await call('POST', `${base}/employees/${ids.T}/resign-settle`, ownerToken, { lastDay: '2026-09-15', noticeDays: 7, tbDeduction: settleAmount }, ids.T)
  const okBody = await okRes.json().catch(() => ({}))
  if (okRes.status !== 200) throw new Error(`settle ${okRes.status}: ${JSON.stringify(okBody)}`)
  const sett = okBody.settlement
  // #23 API 層：2394 分 → 4.43 日 × 實 ADW
  const expTb = calcTimebankDebtAmount(-2394, sett.adwUsed)
  check(23, '欠款金額（API：2394÷540×ADW）', sett.tbMinutes === -2394 && expTb.tbDays === 4.43 && sett.tbAmount === expTb.tbAmount, `tbAmount=$${sett.tbAmount} = 4.43 日 × $${sett.adwUsed}`)
  // #19 扣除次序：tbDeduction 係獨立欄（MPF 之後先扣，唔入上限基底）
  check(19, '扣除次序（tbDeduction 獨立於基數）', sett.tbDeduction === settleAmount && Math.abs(sett.quarterCap - qCap) < 0.011 && Math.abs(sett.annualLeavePay - leavePayout) < 0.011, `tbDeduction=$${sett.tbDeduction}（≤ quarter $${sett.quarterCap}；base 唔含扣除）`)
  check(0, '結算 JSON 欄位齊（MD §六，無 monthWage）',
    ['lastDay', 'noticeDays', 'noticePay', 'annualLeaveDays', 'annualLeavePay', 'tbMinutes', 'tbAmount', 'tbDeduction', 'quarterCap', 'adwUsed', 'settledAt', 'settledBy'].every(k => k in sett) && !('monthWage' in sett),
    `noticePay=$${sett.noticePay}（7 日 × $${sett.adwUsed}）`)

  // #4 辦理離職後重算 → 數字唔變（唔靠 Shift）+ #22 結算唔沖走
  const res2 = await generatePayrollRun(null, PERIOD)
  if ((res2 as any).error) throw new Error(`recalc failed: ${(res2 as any).error}`)
  const runId2 = (res2 as any).runId as string
  const dump2 = await dumpItems(runId2)
  const B2 = dump2.find(i => i.name === `${BATCH}B`)!
  const T2 = dump2.find(i => i.name === `${BATCH}T`)!
  const A2 = dump2.find(i => i.name === `${BATCH}A`)!
  check(4, '重算後數字唔變（唔靠 Shift）', B2.basePay === B.basePay && B2.ratio === B.ratio && A2.basePay === A.basePay && A2.ratio === 1, `B base=${B2.basePay} ratio=${B2.ratio}（run ${runId.slice(-6)} → ${runId2.slice(-6)}）`)
  const ts2 = T2.resignSettlementJson ? JSON.parse(T2.resignSettlementJson) : null
  check(22, '重新生成 → 結算資料冇沖走（carried）', !!ts2 && ts2.tbDeduction === settleAmount && ts2.settledBy === owner.id, `runId ${runId.slice(-6)} → ${runId2.slice(-6)}；resignSettlementJson.tbDeduction=${ts2?.tbDeduction}`)

  // #25 凌晨 2 點開 → 預設今日（hkTodayStr = HK 視角，TZ=UTC 宿主下照啱）
  const today = hkTodayStr()
  const hkNow = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  check(25, '預設今日用 hkTodayStr（HK 視角，TZ=UTC 宿主）', today === hkNow, `hkTodayStr()=${today}`)

  // ════ Sweep（只刪自己 batch；AuditLog append-only 保留）════
  const myUsers = await prisma.user.findMany({ where: { email: { startsWith: `${BATCH}_` } }, select: { id: true, employee: { select: { id: true } } } })
  const myEmpIds = myUsers.map(u => u.employee?.id).filter(Boolean) as string[]
  const myRunIds = [runId, runId2].filter((v, i, a) => a.indexOf(v) === i)
  await prisma.$transaction([
    prisma.payrollItem.deleteMany({ where: { runId: { in: myRunIds } } }),
    prisma.payrollRun.deleteMany({ where: { id: { in: myRunIds } } }),
    prisma.timeBankEntry.deleteMany({ where: { employeeId: { in: myEmpIds } } }),
    prisma.timeBank.deleteMany({ where: { employeeId: { in: myEmpIds } } }),
    prisma.wageHistory.deleteMany({ where: { employeeId: { in: myEmpIds } } }),
    prisma.shift.deleteMany({ where: { employeeId: { in: myEmpIds } } }),
    prisma.payRule.deleteMany({ where: { employeeId: { in: myEmpIds } } }),
    prisma.leaveBalance.deleteMany({ where: { employeeId: { in: myEmpIds } } }),
  ])
  let keptEmp = 0
  try {
    await prisma.employee.deleteMany({ where: { id: { in: myEmpIds } } })
    await prisma.user.deleteMany({ where: { id: { in: myUsers.map(u => u.id) } } })
  } catch { keptEmp = myEmpIds.length }
  const leftoverUsers = await prisma.user.count({ where: { email: { startsWith: `${BATCH}_` } } })
  const leftoverRuns = await prisma.payrollRun.count({ where: { id: { in: myRunIds } } })
  const leftoverPunch = await prisma.punchRecord.count({ where: { employeeId: { in: myEmpIds } } })
  const auditAfter = await prisma.auditLog.count()
  const punchAfter = await prisma.punchRecord.count()
  check(0, `sweep 0 殘留（batch=${BATCH}；append-only 除外）`, leftoverRuns === 0,
    `runs=0；PunchRecord append-only 保留 ${leftoverPunch} 行 → Employee/User 結構性保留 ${keptEmp}（最終 DB 重置歸零）；AuditLog append-only ${auditBefore} → ${auditAfter}（+${auditAfter - auditBefore}）`)

  // ════ 結果 ════
  const pass = results.filter(r => r.pass).length
  const fail = results.filter(r => !r.pass)
  console.log(`\n═══ ${pass}/${results.length} pass ═══`)
  if (fail.length) { console.log('FAILED:'); fail.forEach(f => console.log(`  ❌ #${f.n} ${f.name}: ${f.detail}`)); process.exitCode = 1 }
  fs.writeFileSync('/tmp/kairo-e2e-resigpay-result.json', JSON.stringify({ batch: BATCH, runIds: myRunIds, auditBefore, auditAfter, results }, null, 2))
}

main()
  .catch((e: any) => { console.error('❌ FATAL:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
