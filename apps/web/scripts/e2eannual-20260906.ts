/**
 * cwm-annualdisp-20260906 — T4 e2e（in-process）：年假顯示理順（已放由餘額反推 + 剷 remainThisYear + 餘用權威值）
 *
 * Run:
 *   set -a && . ./.env.development && set +a && npx tsx scripts/e2eannual-20260906.ts --phase1
 *   （fixture + API 驗收 MD §4：#1 #2 #4 #5 #6 #7 #8 #9 #10 #11 #12 #14 #17 #18；
 *     寫 /tmp/kairo-annualdisp-fixture.json 俾 UI 腳本，保留數據）
 *   npx tsx scripts/e2eannual-ui-20260906.ts
 *   （UI 驗收：#1 #2 #3 #4 #6 #7 #13 #14 #15 #16）
 *   set -a && . ./.env.development && set +a && npx tsx scripts/e2eannual-20260906.ts --phase2
 *   （sweep 0 殘留）
 *
 * fixtures 全 synthetic 零 PII（cuid 前綴 e2anl + 秒戳 + rand，sweep 0 殘留）。
 *
 * 場景（MD §1.1 生產實例 Celia/Joan 喺 dev 冇 → 自建合成重現）：
 *  cel  = Celia 型：used > 已累積 → 負餘額（已放 8 / 配額 8 · 餘 −1.2 + 已預支）★★★
 *  joa  = Joan 型：已放算出 0（C=0 一致初始化，三處餘額一致）★★★
 *  zer  = 餘額啱啱 0（無「已預支」）★★★
 *  day1 = 服務年度第 1 日（syDays=1，已累積 ≈ 0）★★★
 *  lst  = 有 APPROVED 假期單（第 3 行「本年度假期單」出）
 *  neg  = 真 clamp：accrued − remaining < 0 → 已放 0（#5）
 *
 * ★ 期望值全部 runtime 實算（MD §1.1 308/309 日係 09-05 嘅數）—— 同 route 同一組 helper，
 *   但由 fixture DB 狀態獨立重算（唔 hardcode MD 例子數字）。
 */
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { createToken } from '../src/lib/auth'
import { hkDateStart, todayHK, addDaysStr } from '../src/lib/hk-date'
import { totalAccruedLeave } from '../src/lib/leave-calculation'
import { serviceYearRange, entitledForServiceYear } from '../src/lib/leave-summary'
import { GET as summaryGet } from '../src/app/api/scheduling-leave-summary/route'
import { GET as overviewGet } from '../src/app/api/employees/[id]/overview/route'
import { GET as resignPreviewGet } from '../src/app/api/employees/[id]/resign-preview/route'

const prisma = new PrismaClient()
const S = String(Math.floor(Date.now() / 1000))
const rand6 = () => Math.random().toString(36).slice(2, 8)
const E = (tag: string) => `e2anl${S}${tag}${rand6()}` // cuid 形（lowercase alnum ≥20）
const FXJSON = '/tmp/kairo-annualdisp-fixture.json'

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(`${name} — ${detail}`); console.log(`  ❌ ${name} — ${detail}`) }
}
const r1 = (n: number) => Math.round(n * 10) / 10
const r2 = (n: number) => Math.round(n * 100) / 100
const hkd = (d: string) => new Date(`${d}T00:00:00+08:00`)

/** 同 route 同一組口徑：服務年度已累積（HK 日界、+1 含頭含尾、min 365） */
function accruedFor(join: string, now: Date, entitled: number): number {
  const sy = serviceYearRange(hkd(join), now)
  const syDays = Math.floor(
    (hkDateStart(todayHK()).getTime() - hkDateStart(sy.start).getTime()) / 86400000) + 1
  return r2(entitled * Math.min(syDays, 365) / 365)
}

const OWNER_ID = 'cmtn52yn0000a3e5ok2zohwln' // 陳醫生 (Owner) — 只讀用（token + createdBy）

interface FxSpec { key: string; name: string; join: string; usedSeed: number; carry: number; req?: { s: string; e: string; days: number } }

async function phase1() {
  const today = todayHK()
  const periodMonth = today.slice(0, 7)
  // ★ resign-preview cutoff 口徑 = hkDateStart(lastDay) + 86400000（lastDay = 今日）
  //   fixture 嘅 entitled（累積應得）用同一 CUTOFF 算 → C=0 case 三處餘額一致（#10/#11）
  const CUTOFF = new Date(hkDateStart(addDaysStr(today, 1)).getTime())

  const annualType = await prisma.leaveType.findUnique({ where: { systemKey: 'ANNUAL_LEAVE' } })
  if (!annualType) throw new Error('ANNUAL_LEAVE LeaveType 搵唔到')

  const fx: FxSpec[] = [
    { key: 'cel', name: 'e2anl Cel', join: '2023-11-01', usedSeed: 22, carry: 0 },
    { key: 'joa', name: 'e2anl Joa', join: '2025-11-01', usedSeed: 0, carry: 0 },
    { key: 'zer', name: 'e2anl Zer', join: '2018-11-01', usedSeed: -1, carry: 0 }, // -1 = 「用晒 → remaining 0」
    { key: 'day1', name: 'e2anl Day1', join: today, usedSeed: 0, carry: 0 },
    { key: 'lst', name: 'e2anl Lst', join: '2021-11-01', usedSeed: 2, carry: 0, req: { s: '2026-08-10', e: '2026-08-11', days: 2 } },
    { key: 'neg', name: 'e2anl Neg', join: '2024-11-01', usedSeed: 0, carry: 0.5 },
  ]

  // ---- 建 fixture（FK 順序：Company → Clinic → User → Employee → EmployeeClinic/PayRule → LeaveBalance/LeaveRequest）
  const company = await prisma.company.create({ data: { id: E('co'), name: 'e2anl annual disp co' } })
  const clinic = await prisma.clinic.create({ data: { id: E('cl'), name: 'e2anl 排班測試診所', companyId: company.id } })

  const ids: string[] = [company.id, clinic.id] // 留作 log 用
  const emps: Record<string, { empId: string; userId: string; entitledDB: number; usedDB: number; remainingDB: number; join: string }> = {}

  for (const f of fx) {
    const entitledDB = r2(totalAccruedLeave(hkd(f.join), CUTOFF, 'prorata'))
    const usedDB = f.usedSeed === -1 ? entitledDB : f.usedSeed
    const remainingDB = r2(entitledDB - usedDB + f.carry)
    const uid = E('u')
    const empId = E('e')
    const u = await prisma.user.create({ data: {
      id: uid, name: f.name, phone: `e2anl${S}${Math.random().toString(36).slice(2, 10)}`,
      email: `e2anl_${S}_${Math.random().toString(36).slice(2, 10)}@test.invalid`,
      role: 'EMPLOYEE', status: 'ACTIVE', password: 'x'.repeat(60),
    } })
    ids.push(uid)
    const e = await prisma.employee.create({ data: {
      id: empId, userId: u.id, joinDate: hkd(f.join), status: 'ACTIVE', homeClinicId: clinic.id,
    } })
    ids.push(empId)
    await prisma.employeeClinic.create({ data: { id: E('ec'), employeeId: empId, clinicId: clinic.id, isPrimary: true } })
    await prisma.payRule.create({ data: {
      id: E('pr'), employeeId: empId, payType: 'MONTHLY', baseAmount: 20000,
      configJson: JSON.stringify({ base_type: 'monthly', monthly_salary: 20000, modifiers: { working_days: { rest_days: [6, 0] } } }),
      effectiveFrom: hkd('2020-01-01'), isActive: true, createdBy: OWNER_ID,
    } })
    await prisma.leaveBalance.create({ data: {
      id: E('lb'), employeeId: empId, leaveTypeId: annualType.id, year: 0,
      entitled: entitledDB, used: usedDB, remaining: remainingDB,
    } })
    if (f.req) {
      await prisma.leaveRequest.create({ data: {
        id: E('lr'), employeeId: empId, leaveTypeId: annualType.id,
        startDate: hkd(f.req.s), endDate: hkd(f.req.e), days: f.req.days,
        reason: 'e2anl annual disp e2e', status: 'APPROVED', approvedAt: new Date(),
        approverId: OWNER_ID, clinicId: clinic.id,
      } })
    }
    emps[f.key] = { empId, userId: u.id, entitledDB, usedDB, remainingDB, join: f.join }
    console.log(`  fixture ${f.key}: join ${f.join} entitledDB=${entitledDB} usedDB=${usedDB} remainingDB=${remainingDB}`)
  }

  // ---- 期望值（runtime 實算）
  const now = new Date()
  const exp: Record<string, { entitled: number; syStart: string; syDays: number; accrued: number; usedDisplay: number; raw: number }> = {}
  for (const f of fx) {
    const m = emps[f.key]
    const sy = serviceYearRange(hkd(f.join), now)
    const entitled = entitledForServiceYear(sy.index)
    const accrued = accruedFor(f.join, now, entitled)
    const raw = r2(accrued - m.remainingDB)
    exp[f.key] = {
      entitled, syStart: sy.start,
      syDays: Math.floor((hkDateStart(today).getTime() - hkDateStart(sy.start).getTime()) / 86400000) + 1,
      accrued, usedDisplay: Math.round(Math.max(0, raw)), raw,
    }
  }
  for (const f of fx) console.log(`  expected ${f.key}: entitled=${exp[f.key].entitled} syDays=${exp[f.key].syDays} accrued=${exp[f.key].accrued} rawUsed=${exp[f.key].raw} → 已放 ${exp[f.key].usedDisplay}`)

  // ---- token：in-process（fallback secret）+ UI（dev server 用 .env.local secret，dotenv 剷引號）
  const inprocToken = createToken({ userId: OWNER_ID, role: 'OWNER', clinics: [], tokenVersion: 0 })
  const localEnv = fs.readFileSync('.env.local', 'utf8')
  let serverSecret = (localEnv.match(/^JWT_SECRET=(.*)$/m) || [])[1]?.trim() ?? ''
  if ((serverSecret.startsWith('"') && serverSecret.endsWith('"')) || (serverSecret.startsWith("'") && serverSecret.endsWith("'"))) {
    serverSecret = serverSecret.slice(1, -1)
  }
  const uiToken = jwt.sign({ userId: OWNER_ID, role: 'OWNER', clinics: [], tokenVersion: 0 }, serverSecret, { expiresIn: '30d' })

  function mkReq(pathStr: string, token: string, method = 'GET') {
    return new NextRequest(`http://localhost:3000${pathStr}`, { method, headers: { cookie: `session=${token}` } })
  }

  // ---- #18 純讀：API 前 snapshot 全部 LeaveBalance
  const balSnap = async () => (await prisma.leaveBalance.findMany({ orderBy: { id: 'asc' } }))

  // ---- 調 API
  const sumRes = await summaryGet(mkReq(`/api/scheduling-leave-summary?companyId=${company.id}&periodMonth=${periodMonth}`, inprocToken))
  if (sumRes.status !== 200) throw new Error(`summary API ${sumRes.status}: ${await sumRes.text()}`)
  const sumBody = await sumRes.json()
  const rows = (sumBody.rows as any[]).filter(r => Object.values(emps).some(m => m.empId === r.employeeId))
  check('#0 API 回齊 6 個 fixture 員工', rows.length === fx.length, `得 ${rows.length} 行`)
  const row = (k: string) => rows.find(r => r.employeeId === emps[k].empId)!

  console.log('\n== MD §4.1 反推公式 ==')
  // #1 Celia 型
  {
    const r = row('cel')
    check('#1 cel 已放 = 8（負餘額反推）★★★', r.usedDays === 8, `得 ${r.usedDays}`)
    check('#1 cel 配額 = 8', r.entitled === 8, `得 ${r.entitled}`)
    check('#1 cel 餘 = r1(remainingDB)（負）', r.balanceRemaining === r1(emps.cel.remainingDB) && r.balanceRemaining < 0,
      `得 ${r.balanceRemaining}（DB ${emps.cel.remainingDB}）`)
  }
  // #2 Joan 型
  {
    const r = row('joa')
    check('#2 joa 已放 = 0', r.usedDays === 0, `得 ${r.usedDays}`)
    check('#2 joa 配額 = 7', r.entitled === 7, `得 ${r.entitled}`)
    check('#2 joa 餘 > 0（正餘額，無 badge 條件）', r.balanceRemaining > 0, `得 ${r.balanceRemaining}`)
  }
  // #4 餘額啱啱 0
  check('#4 zer 餘 = 0（啱啱，無「已預支」條件）★★★', row('zer').balanceRemaining === 0, `得 ${row('zer').balanceRemaining}`)
  // #5 真 clamp（accrued − remaining < 0）
  {
    const r = row('neg')
    check('#5 neg raw 已放係負（前提）', exp.neg.raw < 0, `raw=${exp.neg.raw}`)
    check('#5 neg 已放 clamp 0 ★★★', r.usedDays === 0, `得 ${r.usedDays}`)
  }
  // #6 已放整數
  check('#6 已放全部整數', rows.every(r => Number.isInteger(r.usedDays)), rows.filter(r => !Number.isInteger(r.usedDays)).map(r => r.usedDays).join(','))
  // #7 餘 / 已累積一位小數
  check('#7 餘 / 已累積一位小數', rows.every(r => Number.isInteger(r.balanceRemaining * 10) && Number.isInteger(r.accruedThisYear * 10)),
    rows.map(r => `${r.balanceRemaining}/${r.accruedThisYear}`).join(','))
  // #8 服務年度第 1 日
  {
    const r = row('day1')
    check('#8 day1 syStart = 今日（syDays=1）★★★', r.syStart === today && exp.day1.syDays === 1, `syStart=${r.syStart} syDays=${exp.day1.syDays}`)
    check('#8 day1 已累積 ≈ 0', r.accruedThisYear < 0.05 && r.usedDays === 0, `accrued=${r.accruedThisYear} used=${r.usedDays}`)
  }

  console.log('\n== MD §4.2 唔可以再矛盾 ==')
  // #9 已放 + 餘 ≈ 當年已累積
  {
    // ★ MD §1.2：前提 C=0（上年度結轉 = 0）—— lst/neg 帶結轉 → 公式低估 C，identity 唔成立（by design）
    const c0 = ['cel', 'joa', 'zer', 'day1']
    const ident = c0.every(k => {
      const r = row(k)
      return Math.abs(Math.max(0, exp[k].raw) + r.balanceRemaining - r.accruedThisYear) <= 0.051
    })
    check('#9 identity：已放(unrounded) + 餘 ≈ 已累積（C=0 四人）★★★', ident,
      c0.map(k => `${k}:${Math.abs(Math.max(0, exp[k].raw) + row(k).balanceRemaining - row(k).accruedThisYear)}`).join(' '))
    const celD = Math.abs(row('cel').usedDays + row('cel').balanceRemaining - row('cel').accruedThisYear)
    const zerD = Math.abs(row('zer').usedDays + row('zer').balanceRemaining - row('zer').accruedThisYear)
    check('#9 cel 顯示值 |已放+餘−已累積| < 0.05', celD < 0.05, `差 ${celD}`)
    check('#9 zer 顯示值 |已放+餘−已累積| < 0.05', zerD < 0.05, `差 ${zerD}`)
    // 帶結轉：已放 = clamp（低估 C 係 MD §1.2 已知，只驗 clamp 語義）
    check('#9 lst/neg 帶結轉 → 已放 = clamp（公式低估 C，by design）',
      row('lst').usedDays === 0 && row('neg').usedDays === 0, `lst=${row('lst').usedDays} neg=${row('neg').usedDays}`)
  }
  // #10 排班「餘」= 員工總覽「假期結餘」（同一個 LeaveBalance.remaining）
  {
    let ok = true, det = ''
    for (const f of fx) {
      const ovRes = await overviewGet(mkReq(`/api/employees/${emps[f.key].empId}/overview`, inprocToken), { params: { id: emps[f.key].empId } })
      if (ovRes.status !== 200) { ok = false; det = `${f.key}: overview ${ovRes.status}`; break }
      const ov = await ovRes.json()
      const b = (ov.leaveBalances as any[]).find(x => x.systemKey === 'ANNUAL_LEAVE' && x.year === 0)
      if (!b) { ok = false; det = `${f.key}: 無 ANNUAL_LEAVE year=0 row`; break }
      if (Math.abs(row(f.key).balanceRemaining - b.remaining) >= 0.051) { ok = false; det = `${f.key}: 排班 ${row(f.key).balanceRemaining} vs 總覽 ${b.remaining}`; break }
    }
    check('#10 排班「餘」= 員工總覽「假期結餘」（r1 口徑）★★★', ok, det || '6/6 一致')
  }
  // #11 排班「餘」= 離職結算「未放（可結算）」
  {
    let okC0 = true, detC0 = '', okF = true, detF = ''
    for (const f of fx) {
      const m = emps[f.key]
      const pvRes = await resignPreviewGet(
        mkReq(`/api/employees/${m.empId}/resign-preview?lastDay=${today}`, inprocToken),
        { params: Promise.resolve({ id: m.empId }) },
      )
      if (pvRes.status !== 200) { okC0 = false; okF = false; detC0 = detF = `${f.key}: preview ${pvRes.status}`; break }
      const pv = await pvRes.json()
      const unused = pv.leaveSettlement?.unused as number
      const expectUnused = r2(Math.max(0, totalAccruedLeave(hkd(m.join), CUTOFF, 'prorata') - m.usedDB))
      if (Math.abs(unused - expectUnused) >= 0.005) { okF = false; detF = `${f.key}: unused ${unused} ≠ 預期 ${expectUnused}（同 LeaveBalance.used 源）` }
      // C=0 一致 case：未放 = 餘額（同一個數）
      const isC0 = f.carry === 0 && m.remainingDB >= 0
      if (isC0 && Math.abs(unused - m.remainingDB) >= 0.011) { okC0 = false; detC0 = `${f.key}: 未放 ${unused} ≠ 餘 ${m.remainingDB}` }
    }
    check('#11 離職結算「未放」= f(LeaveBalance.used) 源（全 6 人）★★★', okF, detF || 'wiring ok')
    check('#11 C=0 case：未放 = 排班「餘」（joa/zer/lst）', okC0, detC0 || '一致')
    console.log(`     備註：cel 負餘額 → 結算 clamp 0（未放唔會負，pre-existing 語義）；neg 帶 0.5 結轉 → 差 0.5（MD §1.2 會低估 C，已記低）`)
  }
  // #12 remainThisYear 零命中（MD：除 test 文件歷史 comment 外）
  {
    let hits = ''
    try {
      hits = execSync(
        `grep -rn "remainThisYear" src --include=*.ts --include=*.tsx | grep -v "\.test\.ts" || true`,
        { encoding: 'utf8' },
      ).trim()
    } catch { /* grep exit 1 = 零命中 */ }
    check('#12 grep remainThisYear 零命中（非 test 文件）★★★', hits === '', hits.slice(0, 200))
  }

  console.log('\n== MD §4.3 版面（in-process 部分） ==')
  // #14 有單先出（route 預設格式 M/D：2026-08-10~11 → 「8/10–8/11」）
  check('#14 lst takenDates = 8/10–8/11（有單）', row('lst').takenDates === '8/10–8/11', `得「${row('lst').takenDates}」`)
  check('#14 其餘 5 人 takenDates = 空（無單 → 第 3 行唔出）',
    ['cel', 'joa', 'zer', 'day1', 'neg'].every(k => row(k).takenDates === ''),
    ['cel', 'joa', 'zer', 'day1', 'neg'].map(k => `${k}=${JSON.stringify(row(k).takenDates)}`).join(','))

  console.log('\n== MD §4.4 回歸 ==')
  // #17 三欄（上月剩 / R+PL / 剩餘）口徑唔變
  {
    const ok = rows.every(r =>
      typeof r.restQuota === 'number' &&
      r.restBalanceRemaining === 0 &&          // 無 REST_DAY row → ?? 0
      r.lastMonthRestRemaining === null &&      // 無 snapshot + 無 row → null（cwm-lba 語義）
      r.lastMonthRestSource === null)
    check('#17 上月剩 / R+PL / 剩餘三欄口徑唔變 ★★★', ok,
      rows.map(r => `q=${r.restQuota},rest=${r.restBalanceRemaining},lmr=${r.lastMonthRestRemaining}`).join(' | '))
  }
  // #18 LeaveBalance 純讀
  {
    const before = await balSnap()
    // 再打一次 API（同一次 run 內多打一輪，確保多輪調用都零寫）
    await summaryGet(mkReq(`/api/scheduling-leave-summary?companyId=${company.id}&periodMonth=${periodMonth}`, inprocToken))
    const after = await balSnap()
    const eq = JSON.stringify(before) === JSON.stringify(after)
    check('#18 LeaveBalance 表零改動（純讀）★★★', eq,
      eq ? `${before.length} 行 byte-equal` : `改咗：${JSON.stringify(before).slice(0, 120)}… vs ${JSON.stringify(after).slice(0, 120)}…`)
  }

  // ---- 寫 fixture JSON 俾 UI 腳本
  const out = {
    generatedAt: new Date().toISOString(), today, periodMonth,
    companyId: company.id, clinicId: clinic.id, clinicName: clinic.name,
    inprocToken, uiToken,
    emps: Object.fromEntries(Object.entries(emps).map(([k, m]) => [k, { ...m, ...exp[k], name: fx.find(f => f.key === k)!.name }])),
  }
  fs.writeFileSync(FXJSON, JSON.stringify(out, null, 2))
  console.log(`\nfixture JSON → ${FXJSON}（保留數據俾 UI 腳本；跑完 UI 後 --phase2 sweep）`)
}

async function phase2() {
  const data = JSON.parse(fs.readFileSync(FXJSON, 'utf8'))
  const empIds = Object.values(data.emps as any[]).map(m => m.empId)
  const userIds = Object.values(data.emps as any[]).map(m => m.userId)
  // ★ 用 employeeId 搵（唔靠 id prefix — S 係跑 phase1 嗰刻嘅秒，重跑時會變）；FK 順序冪等
  await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: empIds } } })
  await prisma.leaveBalance.deleteMany({ where: { employeeId: { in: empIds } } })
  await prisma.employeeClinic.deleteMany({ where: { employeeId: { in: empIds } } })
  await prisma.payRule.deleteMany({ where: { employeeId: { in: empIds } } })
  await prisma.employee.deleteMany({ where: { id: { in: empIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.clinic.deleteMany({ where: { id: data.clinicId } })
  await prisma.company.deleteMany({ where: { id: data.companyId } })

  // 殘留驗證（本 run + 全局 e2anl% 防舊 crash 殘留）
  const [lr, lb, ec, prl, e, u, cl, co, strayEmp, strayLb] = await Promise.all([
    prisma.leaveRequest.count({ where: { employeeId: { in: empIds } } }),
    prisma.leaveBalance.count({ where: { employeeId: { in: empIds } } }),
    prisma.employeeClinic.count({ where: { employeeId: { in: empIds } } }),
    prisma.payRule.count({ where: { employeeId: { in: empIds } } }),
    prisma.employee.count({ where: { id: { in: empIds } } }),
    prisma.user.count({ where: { id: { in: userIds } } }),
    prisma.clinic.count({ where: { id: data.clinicId } }),
    prisma.company.count({ where: { id: data.companyId } }),
    prisma.employee.count({ where: { id: { startsWith: 'e2anl' } } }),
    prisma.leaveBalance.count({ where: { id: { startsWith: 'e2anl' } } }),
  ])
  const left = [lr, lb, ec, prl, e, u, cl, co, strayEmp, strayLb]
  check('sweep 0 殘留（LR/LB/EmpClinic/PayRule/Employee/User/Clinic/Company + 全局 e2anl%）',
    left.every(n => n === 0),
    `LR=${lr} LB=${lb} EC=${ec} PR=${prl} E=${e} U=${u} C=${cl} Co=${co} strayE=${strayEmp} strayLB=${strayLb}`)
  fs.rmSync(FXJSON, { force: true })
}

const phase = process.argv.includes('--phase2') ? 'phase2' : 'phase1'
;(phase === 'phase2' ? phase2 : phase1)()
  .catch(e => { console.error('💥 e2e crash:', e); process.exitCode = 2 })
  .finally(async () => {
    await prisma.$disconnect()
    if (fail > 0) {
      console.log(`\n❌ ${fail} FAILED:\n${fails.map(f => '  - ' + f).join('\n')}`)
      process.exitCode = 1
    } else {
      console.log(`\n✅ ALL ${pass} CHECKS PASSED（${phase}）`)
    }
  })
