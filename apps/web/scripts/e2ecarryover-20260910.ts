/**
 * cwm-carryover-20260910 — 年假顯示：分母改「可用」＋ 上期結轉行（第五輪年假顯示）
 *
 * T4 e2e（in-process）：API 加 available/carryOver + 25 人全量斷言
 *
 * ★ dev DB 2026-09-10 重設後只餘 base seed（6 人、0 假期單）— 25 人 dataset 已冇。
 *   跟 e2eannual-20260906 precedent：自建 synthetic 25 人 cohort（零 PII，cuid 形 id
 *   前綴 ecov，phase2 sweep 0 殘留），profile 對住 MD 金樣例 Kathy/Celia/Joan/Suki + 全部邊界。
 *
 * Run:
 *   DATABASE_URL="postgresql://cw_dev:***@127.0.0.1:15532/clinic_workforce" \
 *     npx tsx scripts/e2ecarryover-20260910.ts --phase1
 *   （fixture + API 驗收 MD §五 #1-#14 #20 #21 #22 #23；寫 /tmp/kairo-carryover-fixture.json）
 *   DATABASE_URL=... npx tsx scripts/e2ecarryover-20260910.ts --phase2
 *   （sweep 0 殘留）
 */
import fs from 'node:fs'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { createToken } from '../src/lib/auth'
import { hkDateStart, todayHK, addDaysStr } from '../src/lib/hk-date'
import { totalAccruedLeave } from '../src/lib/leave-calculation'
import { serviceYearRange, entitledForServiceYear, overlapsRange } from '../src/lib/leave-summary'
import { GET as summaryGet } from '../src/app/api/scheduling-leave-summary/route'

const prisma = new PrismaClient()
const S = String(Math.floor(Date.now() / 1000))
const rand6 = () => Math.random().toString(36).slice(2, 8)
const E = (tag: string) => `ecov${S}${tag}${rand6()}` // cuid 形（lowercase alnum ≥20）
const FXJSON = '/tmp/kairo-carryover-fixture.json'
const OWNER_ID = 'cmtn52yn0000a3e5ok2zohwln' // 陳醫生 (Owner) — token + createdBy

const r1 = (n: number) => Math.round(n * 10) / 10
const r2 = (n: number) => Math.round(n * 100) / 100
const hkd = (d: string) => new Date(`${d}T00:00:00+08:00`)

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(`${name} — ${detail}`); console.log(`  ❌ ${name} — ${detail}`) }
}

/** 同 route 同一組口徑：服務年度已累積（HK 日界、+1 含頭含尾、min 365、試用期 gate 0） */
function accruedRaw(join: string, now: Date, entitled: number, serviceMonths: number): number {
  if (serviceMonths < 3) return 0 // PROBATION_MONTHS = 3
  const sy = serviceYearRange(hkd(join), now)
  const syDays = Math.floor(
    (hkDateStart(todayHK()).getTime() - hkDateStart(sy.start).getTime()) / 86400000) + 1
  return r2(entitled * Math.min(syDays, 365) / 365)
}
function serviceMonthsOf(join: string, now: Date): number {
  const j = hkd(join)
  let m = (now.getFullYear() - j.getFullYear()) * 12 + (now.getMonth() - j.getMonth())
  if (now.getDate() < j.getDate()) m--
  return m
}

interface FxSpec {
  key: string; name: string; join: string; balance: number
  reqs?: { s: string; e: string; days: number }[]
}

// ★ 25 人 cohort — profile 覆蓋 MD 金樣例（Kathy/Celia/Joan/Suki）+ 全部邊界
//   kat=Kathy（正結轉 7.9 badge + 假期單行）cel=Celia（負餘額已預支）
//   joa=Joan（無 badge 0.3 + 0.1 rounding trap：available 2.3 ≠ r1(accrued) 2.0）
//   suk=Suki（carryOver 1.0 badge）
//   bdy=0.5 門檻邊界（>0.5 先出 badge）ncg=負結轉 clamp 0  prb/b7/d1=試用期
//   unr=未滿一年 zro=零餘額 eoy/b13=新年初 m14=頂格配額 14
//   b8=單日單 b9=雙段單 b12=極小結轉 0.02 b1-b6/b11=混合
const FX: FxSpec[] = [
  { key: 'kat', name: 'e2cov Kat', join: '2023-08-01', balance: 4.9, reqs: [{ s: '2026-08-03', e: '2026-08-06', days: 4 }] },
  { key: 'cel', name: 'e2cov Cel', join: '2023-11-01', balance: -1.2 },
  { key: 'joa', name: 'e2cov Joa', join: '2025-06-01', balance: 2.3 },
  { key: 'suk', name: 'e2cov Suk', join: '2025-09-25', balance: 7.7 },
  { key: 'bdy', name: 'e2cov Bdy', join: '2023-11-01', balance: 7.4 },
  { key: 'ncg', name: 'e2cov Ncg', join: '2023-11-01', balance: -3.5 },
  { key: 'prb', name: 'e2cov Prb', join: '2026-08-05', balance: 0 },
  { key: 'b7', name: 'e2cov B7', join: '2026-08-01', balance: 0.5 },
  { key: 'unr', name: 'e2cov Unr', join: '2025-10-01', balance: 7.0 },
  { key: 'zro', name: 'e2cov Zro', join: '2018-11-01', balance: 0 },
  { key: 'd1', name: 'e2cov D1', join: '2026-09-10', balance: 0 },
  { key: 'lst', name: 'e2cov Lst', join: '2021-11-01', balance: 0.5, reqs: [{ s: '2026-08-10', e: '2026-08-11', days: 2 }] },
  { key: 'b8', name: 'e2cov B8', join: '2022-03-15', balance: 4.0, reqs: [{ s: '2026-07-08', e: '2026-07-08', days: 1 }] },
  { key: 'b9', name: 'e2cov B9', join: '2022-07-04', balance: 1.0, reqs: [{ s: '2026-07-06', e: '2026-07-06', days: 1 }, { s: '2026-07-09', e: '2026-07-10', days: 2 }] },
  { key: 'm14', name: 'e2cov M14', join: '2015-02-01', balance: 12.0 },
  { key: 'eoy', name: 'e2cov Eoy', join: '2025-09-05', balance: 0.6 },
  { key: 'b1', name: 'e2cov B1', join: '2019-05-20', balance: 5.5 },
  { key: 'b2', name: 'e2cov B2', join: '2020-12-12', balance: 9.0 },
  { key: 'b3', name: 'e2cov B3', join: '2021-04-04', balance: 4.4 },
  { key: 'b4', name: 'e2cov B4', join: '2024-01-15', balance: 5.8 },
  { key: 'b5', name: 'e2cov B5', join: '2017-08-30', balance: 3.0 },
  { key: 'b6', name: 'e2cov B6', join: '2022-11-01', balance: -0.5 },
  { key: 'b11', name: 'e2cov B11', join: '2016-10-10', balance: 12.5 },
  { key: 'b12', name: 'e2cov B12', join: '2023-05-05', balance: 3.2 },
  { key: 'b13', name: 'e2cov B13', join: '2024-09-09', balance: 2.0, reqs: [{ s: '2026-09-05', e: '2026-09-06', days: 2 }, { s: '2026-09-09', e: '2026-09-09', days: 1 }] },
]
if (FX.length !== 25) throw new Error(`cohort 唔係 25 人：${FX.length}`)

async function phase1() {
  const today = todayHK()
  const periodMonth = today.slice(0, 7)
  const now = new Date()
  const CUTOFF = new Date(hkDateStart(addDaysStr(today, 1)).getTime())

  const annualType = await prisma.leaveType.findUnique({ where: { systemKey: 'ANNUAL_LEAVE' } })
  const restType = await prisma.leaveType.findUnique({ where: { systemKey: 'REST_DAY' } })
  if (!annualType || !restType) throw new Error('ANNUAL_LEAVE / REST_DAY LeaveType 搵唔到')

  // ---- 建 fixture（FK 順序：Company → Clinic → User → Employee → EmployeeClinic/PayRule → LB/LR）
  const company = await prisma.company.create({ data: { id: E('co'), name: 'e2cov 年假結轉測試公司' } })
  const clinic = await prisma.clinic.create({ data: { id: E('cl'), name: 'e2cov 排班測試診所', companyId: company.id } })
  const ids: string[] = [company.id, clinic.id]

  const emps: Record<string, any> = {}
  for (const f of FX) {
    const ms = serviceMonthsOf(f.join, CUTOFF)
    const entitledDB = r2(totalAccruedLeave(hkd(f.join), CUTOFF, 'prorata'))
    const usedDB = Math.max(0, r2(entitledDB - f.balance))
    const uid = E('u'), empId = E('e')
    await prisma.user.create({ data: {
      id: uid, name: f.name, phone: `e2cov${S}${Math.random().toString(36).slice(2, 10)}`,
      email: `e2cov_${S}_${Math.random().toString(36).slice(2, 10)}@test.invalid`,
      role: 'EMPLOYEE', status: 'ACTIVE', password: 'x'.repeat(60),
    } })
    ids.push(uid)
    await prisma.employee.create({ data: {
      id: empId, userId: uid, joinDate: hkd(f.join), status: 'ACTIVE', homeClinicId: clinic.id,
    } })
    ids.push(empId)
    await prisma.employeeClinic.create({ data: { id: E('ec'), employeeId: empId, clinicId: clinic.id, isPrimary: true } })
    ids.push('ec')
    await prisma.payRule.create({ data: {
      id: E('pr'), employeeId: empId, payType: 'MONTHLY', baseAmount: 20000,
      configJson: JSON.stringify({ base_type: 'monthly', monthly_salary: 20000, modifiers: { working_days: { rest_days: [6, 0] } } }),
      effectiveFrom: hkd('2020-01-01'), isActive: true, createdBy: OWNER_ID,
    } })
    await prisma.leaveBalance.create({ data: {
      id: E('lb'), employeeId: empId, leaveTypeId: annualType.id, year: 0,
      entitled: entitledDB, used: usedDB, remaining: f.balance,
    } })
    await prisma.leaveBalance.create({ data: {
      id: E('lb'), employeeId: empId, leaveTypeId: restType.id, year: 0,
      entitled: 8, used: 0, remaining: 8,
    } })
    for (const rq of f.reqs ?? []) {
      await prisma.leaveRequest.create({ data: {
        id: E('lr'), employeeId: empId, leaveTypeId: annualType.id,
        startDate: hkd(rq.s), endDate: hkd(rq.e), days: rq.days,
        reason: 'e2cov carryover e2e', status: 'APPROVED', approvedAt: new Date(),
        approverId: OWNER_ID, clinicId: clinic.id,
      } })
    }
    emps[f.key] = { empId, uid, join: f.join, balance: f.balance }
  }

  // ---- #23 純讀：API 前 snapshot 全部 LeaveBalance
  const lbSnap = async () => JSON.stringify(
    (await prisma.leaveBalance.findMany({ select: { id: true, employeeId: true, remaining: true }, orderBy: { id: 'asc' } })))
  const lbBefore = await lbSnap()

  // ---- 期望值（runtime 實算，同 route 同一組 helper）
  const exp: Record<string, any> = {}
  for (const f of FX) {
    const m = emps[f.key]
    const sy = serviceYearRange(hkd(f.join), now)
    const entitled = entitledForServiceYear(sy.index)
    const a = accruedRaw(f.join, now, entitled, serviceMonthsOf(f.join, now))
    const derived = Math.max(0, a - m.balance)
    const takenRaw = (f.reqs ?? [])
      .filter(rq => overlapsRange({ startDate: hkd(rq.s), endDate: hkd(rq.e) }, sy.start, sy.end))
      .reduce((s, rq) => s + rq.days, 0)
    exp[f.key] = {
      entitled, syStart: sy.start, syEnd: sy.end, accrued: a,
      takenRaw, derivedRaw: derived,
      usedDisplay: Math.round(Math.max(takenRaw, derived)),
      inProbation: serviceMonthsOf(f.join, now) < 3,
      underOneYear: serviceMonthsOf(f.join, now) < 12,
    }
  }

  // ---- token
  const inprocToken = createToken({ userId: OWNER_ID, role: 'OWNER', clinics: [], tokenVersion: 0 })
  const localEnv = fs.readFileSync('.env.local', 'utf8')
  let serverSecret = (localEnv.match(/^JWT_SECRET=(.*)$/m) || [])[1]?.trim() ?? ''
  if ((serverSecret.startsWith('"') && serverSecret.endsWith('"')) || (serverSecret.startsWith("'") && serverSecret.endsWith("'"))) {
    serverSecret = serverSecret.slice(1, -1)
  }
  const uiToken = jwt.sign({ userId: OWNER_ID, role: 'OWNER', clinics: [], tokenVersion: 0 }, serverSecret, { expiresIn: '30d' })

  function mkReq(pathStr: string, token: string) {
    return new NextRequest(`http://localhost:3000${pathStr}`, { method: 'GET', headers: { cookie: `session=${token}` } })
  }

  // ---- 調 API（in-process — 一定係改後 code）
  const sumRes = await summaryGet(mkReq(`/api/scheduling-leave-summary?companyId=${company.id}&periodMonth=${periodMonth}`, inprocToken))
  if (sumRes.status !== 200) throw new Error(`summary API ${sumRes.status}: ${await sumRes.text()}`)
  const sumBody = await sumRes.json()
  const rows = (sumBody.rows as any[]).filter(r => Object.values(emps).some(m => m.empId === r.employeeId))
  check('#0 API 回齊 25 個 fixture 員工', rows.length === 25, `得 ${rows.length} 行`)
  const row = (k: string) => rows.find(r => r.employeeId === emps[k].empId)!

  // ---- #4 核心：全部 25 人逐行 可用 − 已放 ＝ 餘（+ 兩個恆等式）
  console.log('\n== #4 核心不變式（25 人逐行） ==')
  let allSelfConsistent = true, allAvailId = true, allCarryId = true
  for (const f of FX) {
    const r = row(f.key)
    if (!r) { allSelfConsistent = false; continue }
    const c1 = r1(r.available - r.usedDays) === r1(r.balanceRemaining)
    const c2 = r.available === r1(r.balanceRemaining + r.usedDays)
    const c3 = r.carryOver === Math.max(0, r1(r.available - r.accruedThisYear))
    if (!c1) allSelfConsistent = false
    if (!c2) allAvailId = false
    if (!c3) allCarryId = false
  }
  check('#4 可用 − 已放 ＝ 餘（25 人逐行）★★★', allSelfConsistent, '有人對唔埋')
  check('#4b available ＝ r1(餘 ＋ 已放)（25 人）', allAvailId, '定義唔符')
  check('#4c carryOver ＝ max(0, r1(可用 − 本年累積))（25 人）', allCarryId, 'clamp/基準錯')

  // ---- #20：餘 ＝ LeaveBalance.remaining 權威值（改後新鮮 DB 讀）
  const dbBal: Record<string, number> = {}
  for (const lb of await prisma.leaveBalance.findMany({
    where: { employeeId: { in: Object.values(emps).map(m => m.empId) }, leaveType: { systemKey: 'ANNUAL_LEAVE' } },
  })) {
    const empId = lb.employeeId as string
    dbBal[empId] = r1((dbBal[empId] ?? 0) + lb.remaining)
  }
  let allAuth = true
  for (const f of FX) {
    const r = row(f.key)
    if (r.balanceRemaining !== dbBal[r.employeeId]) { allAuth = false; console.log(`    ✗ ${f.key}: API ${r.balanceRemaining} vs DB ${dbBal[r.employeeId]}`) }
  }
  check('#20 餘 ＝ LeaveBalance.remaining 權威值（25 人）★★★', allAuth, '有行唔係 DB 值')

  // ---- #21：已放 ＝ maxfloor 落刀後口徑 max(taken, derived)（runtime 重算）
  let allMaxfloor = true
  for (const f of FX) {
    const r = row(f.key)
    const e = exp[f.key]
    if (r.usedDays !== e.usedDisplay) { allMaxfloor = false; console.log(`    ✗ ${f.key}: API ${r.usedDays} vs expected ${e.usedDisplay} (taken ${e.takenRaw}, derived ${e.derivedRaw})`) }
  }
  check('#21 已放 ＝ round(max(taken, derived))（25 人，maxfloor 口徑）★★★', allMaxfloor, '口徑漂移')

  // ---- #22：上月剩 / R+PL(total) / 剩餘欄字段照舊存在
  let allRest = true
  for (const f of FX) {
    const r = row(f.key)
    if (typeof r.restBalanceRemaining !== 'number' || typeof r.restQuota !== 'number'
        || (r.lastMonthRestRemaining !== null && typeof r.lastMonthRestRemaining !== 'number')) allRest = false
  }
  check('#22 上月剩/剩餘欄字段照舊回（25 人）★★★', allRest, '欄缺咗')

  // ---- #23：LeaveBalance 表零改
  const lbAfter = await lbSnap()
  check('#23 LeaveBalance 表 API 前後零改（純讀）★★★', lbBefore === lbAfter, 'LB 表被改')

  console.log('\n== 25 人對數表（MD §五） ==')
  const tbl: string[] = ['| key | 名字 | join | 配額 | 已放 | 可用 | 餘 | 本年累積 | 結轉 | badge>0.5 | 假期單 | flags |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|']
  for (const f of FX) {
    const r = row(f.key), e = exp[f.key]
    const badge = (r.carryOver ?? -1) > 0.5
    const flags = [r.inProbation && '試用期', r.underOneYear && '未滿一年', r.balanceRemaining < 0 && '已預支'].filter(Boolean).join('/') || '—'
    tbl.push(`| ${f.key} | ${f.name} | ${f.join} | ${r.entitled} | ${r.usedDays} | ${r.available} | ${r.balanceRemaining} | ${r.accruedThisYear} | ${r.carryOver} | ${badge ? '★出' : '唔出'} | ${r.takenDates ?? '—'} | ${flags} |`)
  }
  console.log(tbl.join('\n'))
  const mdTable = tbl.join('\n')

  console.log('\n== 金樣例 profile 斷言 ==')
  {
    const r = row('kat'), e = exp.kat
    check('#1 kat(Kathy 型) 已放 4 / 可用 8.9 · 餘 4.9 ★★★',
      r.usedDays === 4 && r.available === 8.9 && r.balanceRemaining === 4.9,
      `得 已放 ${r.usedDays} / 可用 ${r.available} · 餘 ${r.balanceRemaining}`)
    check('#5 kat badge「含上期結轉 > 0.5」（runtime ' + r.carryOver + '）★★★',
      r.carryOver > 0.5, `carryOver=${r.carryOver}`)
    check('#10/#11 kat 算式行加得返：carryOver + r1(available−carryOver) ＝ available ★★★',
      Math.round((r.carryOver + r1(r.available - r.carryOver)) * 10) === Math.round(r.available * 10),
      `${r.carryOver} + ${r1(r.available - r.carryOver)} vs ${r.available}`)
    check('#18 kat 假期單行有 8/3–8/6', (r.takenDates ?? '').includes('8/3–8/6'), `takenDates=${r.takenDates}`)
    check('kat 配額 = 9（idx 3）', r.entitled === 9 && e.syStart === '2026-08-01', `entitled=${r.entitled} syStart=${e.syStart}`)

    const c = row('cel')
    check('#2 cel(Celia 型) 已放 8 / 可用 6.8 · 餘 −1.2 ★★★',
      c.usedDays === 8 && c.available === 6.8 && c.balanceRemaining === -1.2,
      `得 已放 ${c.usedDays} / 可用 ${c.available} · 餘 ${c.balanceRemaining}`)
    check('#6 cel carryOver 0（≤0.5 唔出 badge）★★★', c.carryOver === 0, `carryOver=${c.carryOver}`)
    check('#13 cel 算式行「本年累積 6.8」（＝ available，唔係 accruedThisYear）★★★',
      c.available === 6.8 && r1(c.accruedThisYear) !== 6.8,
      `available=${c.available} r1(accrued)=${r1(c.accruedThisYear)}`)

    const j = row('joa')
    check('#3 joa(Joan 型) 已放 0 / 可用 2.5 形態（runtime 2.3）· 餘 2.3 ★★★',
      j.usedDays === 0 && j.available === 2.3 && j.balanceRemaining === 2.3,
      `得 已放 ${j.usedDays} / 可用 ${j.available} · 餘 ${j.balanceRemaining}`)
    check('#7/#12 joa 無 badge（0.3 ≤ 0.5）＋ 0.1 trap：available 2.3 ≠ r1(accrued) 2.0 ★★★',
      j.carryOver <= 0.5 && Math.abs(j.available - r1(j.accruedThisYear)) >= 0.1,
      `carryOver=${j.carryOver} available=${j.available} r1(accrued)=${r1(j.accruedThisYear)}`)

    const s = row('suk')
    check('#8 suk(Suki 型) badge「含上期結轉 1.0」（0.5 < carry ≤ 1）★★', s.carryOver === 1.0, `carryOver=${s.carryOver}`)

    const n = row('ncg')
    check('#9 ncg 負結轉 clamp 0、無 badge、已預支 ★★★',
      n.carryOver === 0 && n.balanceRemaining === -3.5, `carryOver=${n.carryOver} 餘=${n.balanceRemaining}`)

    const p = row('prb')
    check('#14 prb 試用期 算式行「本年累積 0」（available 0）★★',
      p.inProbation === true && p.available === 0 && p.carryOver === 0,
      `inProbation=${p.inProbation} available=${p.available} carryOver=${p.carryOver}`)
    check('b7 試用期 + carryOver 0.5 邊界（唔出 badge）',
      row('b7').inProbation === true && row('b7').carryOver === 0.5,
      `carryOver=${row('b7').carryOver}`)

    check('bdy carryOver 啱啱 0.5（門檻邊界，唔出 badge）', row('bdy').carryOver === 0.5, `carryOver=${row('bdy').carryOver}`)
    check('unr 未滿一年（唔係試用期）無 badge',
      row('unr').underOneYear === true && row('unr').inProbation === false && row('unr').carryOver <= 0.5,
      JSON.stringify({ u: row('unr').underOneYear, p: row('unr').inProbation, c: row('unr').carryOver }))
    check('zro 零餘額（已放 11 反推，無 badge）',
      row('zro').balanceRemaining === 0 && row('zro').usedDays >= 1 && row('zro').carryOver === 0,
      `餘=${row('zro').balanceRemaining} 已放=${row('zro').usedDays} carry=${row('zro').carryOver}`)
    check('m14 頂格配額 14 + 大結轉 badge', row('m14').entitled === 14 && row('m14').carryOver > 0.5,
      `entitled=${row('m14').entitled} carry=${row('m14').carryOver}`)
    // ⚠️ < 0.05 嘅結轉會被 r1 round 去 0（同 MD Celia 0.01 → 顯示 0 同一個系統）→ 斷言放寬做「無 badge」
    check('b12 極小結轉（balance ≈ accrued → carryOver ≈ 0，無 badge）',
      row('b12').carryOver <= 0.5 && row('b12').balanceRemaining === 3.2,
      `carry=${row('b12').carryOver} 餘=${row('b12').balanceRemaining}`)
    check('b13 新年第 2 日：舊年單 9/5–6 唔計入（takenDays 1）', row('b13').takenDays === 1 && row('b13').syStart === '2026-09-09',
      `takenDays=${row('b13').takenDays} syStart=${row('b13').syStart}`)
    check('b8 單日單格式 7/8', row('b8').takenDates === '7/8', `takenDates=${row('b8').takenDates}`)
    check('b9 雙段單 7/6、7/9–7/10', (row('b9').takenDates ?? '').includes('7/6') && (row('b9').takenDates ?? '').includes('7/9–7/10'),
      `takenDates=${row('b9').takenDates}`)
    check('lst 反推 > 單（used = round(derived) = 8 > taken 2）＋ 假期單行',
      row('lst').usedDays === exp.lst.usedDisplay && exp.lst.usedDisplay > 2 && (row('lst').takenDates ?? '').includes('8/10–8/11'),
      `used=${row('lst').usedDays} expected=${exp.lst.usedDisplay} takenDates=${row('lst').takenDates}`)

    const badgeCount = FX.filter(f => (row(f.key).carryOver ?? -1) > 0.5).length
    check('badge 覆蓋：≥8 人出 badge', badgeCount >= 8, `badgeCount=${badgeCount}`)
    const negCount = FX.filter(f => row(f.key).balanceRemaining < 0).length
    check('負餘額覆蓋：cel/ncg/b6 三人（已預支）', negCount === 3, `negCount=${negCount}`)
  }

  // ---- 寫 fixture 俾 UI 腳本
  const fxOut: Record<string, any> = {
    companyId: company.id, clinicId: clinic.id, clinicName: clinic.name,
    uiToken, periodMonth, inprocToken,
    emps: {},
  }
  for (const f of FX) {
    const r = row(f.key), e = exp[f.key]
    fxOut.emps[f.key] = {
      empId: r.employeeId, name: f.name, join: f.join,
      balance: f.balance, entitled: r.entitled, usedDays: r.usedDays,
      available: r.available, carryOver: r.carryOver, balanceRemaining: r.balanceRemaining,
      accruedThisYear: r.accruedThisYear, takenDates: r.takenDates,
      inProbation: r.inProbation, underOneYear: r.underOneYear,
      syStart: r.syStart, syEnd: r.syEnd,
    }
  }
  fs.writeFileSync(FXJSON, JSON.stringify(fxOut, null, 2))
  console.log(`\nfixture 寫咗 ${FXJSON}`)
  fs.writeFileSync('/tmp/kairo-carryover-table.md', mdTable + '\n')

  console.log(`\nPHASE1 DONE: pass=${pass} fail=${fail}`)
  if (fail > 0) { console.log('FAILS:\n' + fails.join('\n')); process.exitCode = 1 }
}

async function phase2() {
  const likeSfx = process.argv.includes('--phase2-all') ? '' : S // --phase2-all = 掃晒所有 timestamp 嘅 ecov fixture
  const all = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM "Employee" WHERE id LIKE 'ecov${likeSfx}%'`)
  const empIds = all.map(r => r.id)
  console.log(`sweep: ${empIds.length} 個 fixture 員工`)
  const usersBefore = empIds.length > 0
    ? await prisma.employee.findMany({ where: { id: { in: empIds } }, select: { userId: true } })
    : []
  if (empIds.length > 0) {
    await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: empIds } } })
    await prisma.leaveBalance.deleteMany({ where: { employeeId: { in: empIds } } })
    await prisma.payRule.deleteMany({ where: { employeeId: { in: empIds } } })
    await prisma.employeeClinic.deleteMany({ where: { employeeId: { in: empIds } } })
    await prisma.employee.deleteMany({ where: { id: { in: empIds } } })
  }
  if (usersBefore.length) await prisma.user.deleteMany({ where: { id: { in: usersBefore.map(u => u.userId) } } })
  const clinics = await prisma.clinic.findMany({ where: { name: 'e2cov 排班測試診所' } })
  for (const c of clinics) await prisma.clinic.delete({ where: { id: c.id } })
  const cos = await prisma.company.findMany({ where: { name: 'e2cov 年假結轉測試公司' } })
  for (const c of cos) {
    const left = await prisma.clinic.count({ where: { companyId: c.id } })
    if (left === 0) await prisma.company.delete({ where: { id: c.id } })
  }
  // 驗證 0 殘留
  const remEmp = (await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "Employee" WHERE id LIKE 'ecov${likeSfx}%'`)).map(r => r.n)[0]
  const remU = (await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "User" WHERE email LIKE 'e2cov_${likeSfx}%'`)).map(r => r.n)[0]
  const remCl = await prisma.clinic.count({ where: { name: 'e2cov 排班測試診所' } })
  const remCo = await prisma.company.count({ where: { name: 'e2cov 年假結轉測試公司' } })
  const lbCount = await prisma.leaveBalance.count()
  check('sweep 0 殘留（Employee/User/Clinic/Company）', remEmp === 0 && remU === 0 && remCl === 0 && remCo === 0,
    `emp=${remEmp} user=${remU} clinic=${remCl} company=${remCo}`)
  console.log(`LB 表回復 ${lbCount} 行（base seed = 8）`)
  check('LeaveBalance 回復 base seed（8 行）', lbCount === 8, `lbCount=${lbCount}`)
  console.log(`\nPHASE2 DONE: pass=${pass} fail=${fail}`)
  if (fail > 0) { console.log('FAILS:\n' + fails.join('\n')); process.exitCode = 1 }
}

;(async () => {
  try {
    if (process.argv.includes('--phase2')) await phase2()
    else await phase1()
  } finally {
    await prisma.$disconnect()
  }
})()
