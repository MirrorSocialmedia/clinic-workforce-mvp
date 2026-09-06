/**
 * cwm-annualused-20260906 — T3 e2e（in-process）：年假「已放」= max(假期單, 反推) + 試用期 gate（方案 D）
 *
 * Run:
 *   set -a && . ./.env.development && set +a && npx tsx scripts/e2eannualused-20260906.ts --phase1
 *   （fixture + API 驗收 MD §六：#0 #1-#12 #14-#15 #17-#19；寫 /tmp/kairo-annualused-fixture.json
 *     俾 UI 腳本，保留數據）
 *   npx tsx scripts/e2eannualused-ui-20260906.ts
 *   （UI 驗收：#13 tooltip 兩來源 + 關鍵顯示值）
 *   set -a && . ./.env.development && set +a && npx tsx scripts/e2eannualused-20260906.ts --phase2
 *   （sweep 0 殘留）
 *
 * fixtures 全 synthetic 零 PII（cuid 前綴 e2aus + 秒戳 + rand，sweep 0 殘留）。
 * 重現 MD §二 12 人口徑（dev DB 冇生產 12 人，同 cwm-annualdisp 先例）＋ #11（試用期有單）＋ #15（年度首日）。
 *
 * 場景（MD §二）：
 *  cel    = Celia 型：用超（餘 −1.2，反推 8.38 → 已放 8 + 已預支）★★★
 *  kathy  = Kathy 型：已過試用期 + 4 日單、反推 ≤0 → 已放 4（floor 修正）★★★
 *  luna/selina/horace/lettie = 試用期（gate 修正：舊公式會顯「已放 1」）★★★
 *  mandy  = 過試用期 + 2 日單 8/1–8/2、反推 ~1.97 → 已放 2
 *  lily   = 2 日單 < 反推 7.47 → 已放 7（反推贏）
 *  vera   = 0 單、反推 4.05 → 已放 4
 *  joan/jesscia/suki = 已放 0
 *  proll  = 試用期 + 2 日單 → 已放 2（#11 floor 生效）★★★
 *  day1   = 服務年度第 1 日（syDays=1）（#15）
 *
 * ★ 期望值全部 runtime 實算（同 route 同一組 helper），另斷言 MD §二 字面預期值。
 */
import fs from 'node:fs'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { createToken } from '../src/lib/auth'
import { hkDateStart, todayHK, addDaysStr } from '../src/lib/hk-date'
import { totalAccruedLeave, serviceMonths, PROBATION_MONTHS } from '../src/lib/leave-calculation'
import { serviceYearRange, entitledForServiceYear } from '../src/lib/leave-summary'
import { GET as summaryGet } from '../src/app/api/scheduling-leave-summary/route'
import { GET as resignPreviewGet } from '../src/app/api/employees/[id]/resign-preview/route'

const prisma = new PrismaClient()
const S = String(Math.floor(Date.now() / 1000))
const rand6 = () => Math.random().toString(36).slice(2, 8)
const E = (tag: string) => `e2aus${S}${tag}${rand6()}` // cuid 形（lowercase alnum ≥20）
const FXJSON = '/tmp/kairo-annualused-fixture.json'

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(`${name} — ${detail}`); console.log(`  ❌ ${name} — ${detail}`) }
}
const r1 = (n: number) => Math.round(n * 10) / 10
const r2 = (n: number) => Math.round(n * 100) / 100
const hkd = (d: string) => new Date(`${d}T00:00:00+08:00`)

/** 同 route 同一組口徑：服務年度已累積（HK 日界、+1 含頭含尾、min 365、試用期 gate） */
function accruedFor(join: string, now: Date, entitled: number): number {
  const inProbation = serviceMonths(hkd(join), now) < PROBATION_MONTHS
  if (inProbation) return 0
  const sy = serviceYearRange(hkd(join), now)
  const syDays = Math.floor(
    (hkDateStart(todayHK()).getTime() - hkDateStart(sy.start).getTime()) / 86400000) + 1
  return r2(entitled * Math.min(syDays, 365) / 365)
}

const OWNER_ID = 'cmtn52yn0000a3e5ok2zohwln' // 陳醫生 (Owner) — 只讀用（token + createdBy）

interface FxSpec {
  key: string; name: string; join: string; remainingTarget: number
  req?: { s: string; e: string; days: number }
}

async function phase1() {
  const today = todayHK()
  const periodMonth = today.slice(0, 7)
  // ★ resign-preview cutoff 口徑 = hkDateStart(lastDay) + 86400000（lastDay = 今日）
  const CUTOFF = new Date(hkDateStart(addDaysStr(today, 1)).getTime())

  const annualType = await prisma.leaveType.findUnique({ where: { systemKey: 'ANNUAL_LEAVE' } })
  if (!annualType) throw new Error('ANNUAL_LEAVE LeaveType 搵唔到')

  // ---- MD §二 12 人 + #11 proll + #15 day1（join/單/餘額 全部針對 2026-09-06 設計）
  const fx: FxSpec[] = [
    { key: 'cel', name: 'e2aus Cel', join: '2023-10-15', remainingTarget: -1.2 },                      // 反推 ~8.38 → 8
    { key: 'kathy', name: 'e2aus Kat', join: '2025-07-21', remainingTarget: 4.9,
      req: { s: '2026-08-24', e: '2026-08-27', days: 4 } },                                            // 4 日單、反推 0 → 4
    { key: 'luna', name: 'e2aus Lun', join: '2026-06-20', remainingTarget: 0 },                        // 試用期
    { key: 'selina', name: 'e2aus Sel', join: '2026-07-05', remainingTarget: 0 },                      // 試用期
    { key: 'horace', name: 'e2aus Hor', join: '2026-07-20', remainingTarget: 0 },                      // 試用期
    { key: 'lettie', name: 'e2aus Let', join: '2026-08-01', remainingTarget: 0 },                      // 試用期
    { key: 'joan', name: 'e2aus Joa', join: '2023-08-01', remainingTarget: -1 },                       // -1 = 餘額啱啱=已累積（runtime 填）
    { key: 'jesscia', name: 'e2aus Jes', join: '2024-09-15', remainingTarget: 6.45 },                  // 反推 ~0.4 → 0
    { key: 'suki', name: 'e2aus Suk', join: '2023-07-25', remainingTarget: -1 },                       // -1 = 餘額啱啱=已累積
    { key: 'lily', name: 'e2aus Lil', join: '2023-09-10', remainingTarget: 0.53,
      req: { s: '2026-08-10', e: '2026-08-11', days: 2 } },                                            // 單 2 < 反推 ~7.4 → 7
    { key: 'mandy', name: 'e2aus Man', join: '2025-09-10', remainingTarget: 4.98,
      req: { s: '2026-08-01', e: '2026-08-02', days: 2 } },                                            // 單 2、反推 ~1.97 → 2
    { key: 'vera', name: 'e2aus Ver', join: '2023-09-20', remainingTarget: 3.66 },                     // 反推 ~4.05 → 4
    { key: 'proll', name: 'e2aus Pro', join: '2026-07-25', remainingTarget: 0,
      req: { s: '2026-08-20', e: '2026-08-21', days: 2 } },                                            // #11 試用期 + 單 → 2
    { key: 'day1', name: 'e2aus Day', join: today, remainingTarget: 0 },                               // #15 年度首日
  ]

  // ---- 建 fixture（FK 順序：Company → Clinic → User → Employee → EmployeeClinic/PayRule → LeaveBalance/LeaveRequest）
  const company = await prisma.company.create({ data: { id: E('co'), name: 'e2aus annual used co' } })
  const clinic = await prisma.clinic.create({ data: { id: E('cl'), name: 'e2aus 已放修正測試診所', companyId: company.id } })

  const now = new Date()
  const emps: Record<string, { empId: string; userId: string; entitledDB: number; usedDB: number; remainingDB: number; join: string }> = {}

  for (const f of fx) {
    const entitledDB = r2(totalAccruedLeave(hkd(f.join), CUTOFF, 'prorata')) // 試用期 → 0（gate）
    // joan/suki：餘額 = 當年已累積（runtime 同 route 口徑）→ 反推 0
    const remainingDB = f.remainingTarget === -1
      ? accruedFor(f.join, now, entitledForServiceYear(serviceYearRange(hkd(f.join), now).index))
      : f.remainingTarget
    const usedDB = r2(entitledDB - remainingDB)
    const uid = E('u')
    const empId = E('e')
    await prisma.user.create({ data: {
      id: uid, name: f.name, phone: `e2aus${S}${Math.random().toString(36).slice(2, 10)}`,
      email: `e2aus_${S}_${Math.random().toString(36).slice(2, 10)}@test.invalid`,
      role: 'EMPLOYEE', status: 'ACTIVE', password: 'x'.repeat(60),
    } })
    await prisma.employee.create({ data: {
      id: empId, userId: uid, joinDate: hkd(f.join), status: 'ACTIVE', homeClinicId: clinic.id,
    } })
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
        reason: 'e2aus annual used e2e', status: 'APPROVED', approvedAt: new Date(),
        approverId: OWNER_ID, clinicId: clinic.id,
      } })
    }
    emps[f.key] = { empId, userId: uid, entitledDB, usedDB, remainingDB, join: f.join }
    console.log(`  fixture ${f.key}: join ${f.join} entitledDB=${entitledDB} usedDB=${usedDB} remainingDB=${remainingDB}`)
  }

  // ---- 期望值（runtime 實算，同 route 同一組 helper）
  const exp: Record<string, { entitled: number; syStart: string; syDays: number; accrued: number; inProbation: boolean; derived: number; takenDays: number; usedDisplay: number; oldDisplay: number }> = {}
  for (const f of fx) {
    const m = emps[f.key]
    const sy = serviceYearRange(hkd(f.join), now)
    const entitled = entitledForServiceYear(sy.index)
    const inProbation = serviceMonths(hkd(f.join), now) < PROBATION_MONTHS
    const accrued = accruedFor(f.join, now, entitled)
    const derived = Math.max(0, r2(accrued - m.remainingDB))
    const takenDays = f.req ? f.req.days : 0
    const usedDisplay = Math.round(Math.max(takenDays, derived))
    // 舊公式（cwm-annualdisp，冇 gate 冇 floor）—— 證明 bug 存在過
    const oldAccrued = r2(entitled * Math.min(
      Math.floor((hkDateStart(today).getTime() - hkDateStart(sy.start).getTime()) / 86400000) + 1, 365) / 365)
    const oldDisplay = Math.round(Math.max(0, oldAccrued - m.remainingDB))
    exp[f.key] = { entitled, syStart: sy.start,
      syDays: Math.floor((hkDateStart(today).getTime() - hkDateStart(sy.start).getTime()) / 86400000) + 1,
      accrued, inProbation, derived, takenDays, usedDisplay, oldDisplay }
  }
  for (const f of fx) console.log(
    `  expected ${f.key}: entitled=${exp[f.key].entitled} syDays=${exp[f.key].syDays} probation=${exp[f.key].inProbation}` +
    ` accrued=${exp[f.key].accrued} derived=${exp[f.key].derived} taken=${exp[f.key].takenDays} → 已放 ${exp[f.key].usedDisplay}（舊公式會顯 ${exp[f.key].oldDisplay}）`)

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

  // ---- 調 API
  const sumRes = await summaryGet(mkReq(`/api/scheduling-leave-summary?companyId=${company.id}&periodMonth=${periodMonth}`, inprocToken))
  if (sumRes.status !== 200) throw new Error(`summary API ${sumRes.status}: ${await sumRes.text()}`)
  const sumBody = await sumRes.json()
  const rows = (sumBody.rows as any[]).filter(r => Object.values(emps).some(m => m.empId === r.employeeId))
  check('#0 API 回齊 14 個 fixture 員工', rows.length === fx.length, `得 ${rows.length} 行`)
  const row = (k: string) => rows.find(r => r.employeeId === emps[k].empId)!

  console.log('\n== MD §六.1 四個試用期修正 ==')
  for (const k of ['luna', 'selina', 'horace', 'lettie'] as const) {
    const r = row(k)
    check(`#${k} ${k} 已放 0（gate）★★★`, r.usedDays === 0, `得 ${r.usedDays}`)
    check(`#${k} ${k} inProbation=true 且 accruedThisYear=0（gate 生效）`, r.inProbation === true && r.accruedThisYear === 0,
      `inProbation=${r.inProbation} accrued=${r.accruedThisYear}`)
    check(`#${k} ${k} 舊公式會顯「已放」>0（bug 實錘）`, exp[k].oldDisplay >= 1, `舊=${exp[k].oldDisplay}`)
  }

  console.log('\n== MD §六.1 Kathy 修正 ==')
  {
    const r = row('kathy')
    check('#5 kathy 已放 4（假期單 floor，原 0）★★★', r.usedDays === 4, `得 ${r.usedDays}`)
    check('#5 kathy takenDays=4、derivedUsed=0（兩來源正確）', r.takenDays === 4 && r.derivedUsed === 0,
      `taken=${r.takenDays} derived=${r.derivedUsed}`)
    check('#5 kathy takenDates = 8/24–8/27', r.takenDates === '8/24–8/27', `得「${r.takenDates}」`)
  }

  console.log('\n== MD §六.2 唔可以變 ==')
  {
    const r = row('cel')
    check('#6 celia 已放 8（負餘額反推）★★★', r.usedDays === 8, `得 ${r.usedDays}`)
    check('#6 celia 配額 = 8', r.entitled === 8, `得 ${r.entitled}`)
    check('#14 celia 餘 = −1.2 權威值（未被「已放」影響）★★★', r.balanceRemaining === r1(emps.cel.remainingDB) && r.balanceRemaining === -1.2,
      `得 ${r.balanceRemaining}（DB ${emps.cel.remainingDB}）`)
    check('#6 celia derivedUsed ≈ 8.38（round 8）', r.derivedUsed >= 7.5 && r.derivedUsed < 8.5, `得 ${r.derivedUsed}`)
  }
  {
    const r = row('mandy')
    check('#7 mandy 已放 2（＝假期單 2 日）★★★', r.usedDays === 2, `得 ${r.usedDays}`)
    check('#7 mandy 反推 ~1.97（r1 顯示 ≤2）< 單 2（單贏）', r.derivedUsed >= 1.9 && r.derivedUsed <= 2 && r.takenDays === 2,
      `derived=${r.derivedUsed} taken=${r.takenDays}`)
    check('#7 mandy takenDates = 8/1–8/2', r.takenDates === '8/1–8/2', `得「${r.takenDates}」`)
  }
  check('#8 vera 已放 4（反推 ~4.05）★★★', row('vera').usedDays === 4 && row('vera').takenDays === 0,
    `used=${row('vera').usedDays} derived=${row('vera').derivedUsed}`)
  {
    const r = row('lily')
    check('#9 lily 已放 7（單 2 < 反推 ~7.47）★★★', r.usedDays === 7, `得 ${r.usedDays}`)
    check('#9 lily takenDays=2、derivedUsed ~7.4（r1）', r.takenDays === 2 && Math.abs(r.derivedUsed - 7.4) < 0.06,
      `taken=${r.takenDays} derived=${r.derivedUsed}`)
    check('#12 反推 > 單 → 顯示反推值（lily）★★★', r.usedDays === Math.round(r.derivedUsed) && r.derivedUsed > r.takenDays,
      `used=${r.usedDays} round(derived)=${Math.round(r.derivedUsed)}`)
  }
  for (const k of ['joan', 'jesscia', 'suki'] as const) {
    check(`#10 ${k} 已放 0 ★★★`, row(k).usedDays === 0, `得 ${row(k).usedDays}`)
  }
  check('#10 jesscia 反推 ~0.4（round 0，非負餘額）', Math.abs(row('jesscia').derivedUsed - 0.4) < 0.011 && row('jesscia').balanceRemaining > 0,
    `derived=${row('jesscia').derivedUsed} bal=${row('jesscia').balanceRemaining}`)

  console.log('\n== MD §六.3 邏輯 ==')
  {
    const r = row('proll')
    check('#11 試用期 + 有單 → 顯示單日數 2（floor 生效）★★★', r.usedDays === 2 && r.inProbation === true,
      `used=${r.usedDays} inProbation=${r.inProbation}`)
    check('#11 proll derived=0（gate）但 taken=2 → max 生效', r.derivedUsed === 0 && r.takenDays === 2,
      `derived=${r.derivedUsed} taken=${r.takenDays}`)
  }
  {
    const r = row('day1')
    check('#15 服務年度首日：syStart = 今日（syDays=1）', r.syStart === today && exp.day1.syDays === 1,
      `syStart=${r.syStart} syDays=${exp.day1.syDays}`)
    check('#15 day1 已放 0（反推 ≈ 0）', r.usedDays === 0, `得 ${r.usedDays}`)
  }

  console.log('\n== 方案 D 一致性（全 14 行） ==')
  {
    const shapeOk = rows.every(r =>
      typeof r.takenDays === 'number' && typeof r.derivedUsed === 'number' &&
      Number.isInteger(r.takenDays * 10) && Number.isInteger(r.derivedUsed * 10) &&
      r.takenDays >= 0 && r.derivedUsed >= 0 &&
      r.usedDays === Math.round(Math.max(r.takenDays, r.derivedUsed)))
    check('D：response 有 takenDays/derivedUsed（r1、≥0）且 usedDays = round(max(兩者))（全行）', shapeOk,
      rows.filter(r => r.usedDays !== Math.round(Math.max(r.takenDays, r.derivedUsed)))
        .map(r => `${r.name}: used=${r.usedDays} max=${Math.max(r.takenDays, r.derivedUsed)}`).join(' | '))
    const takenDates = rows.every(r => {
      const f = fx.find(x => emps[x.key] && x.key === (Object.keys(emps).find(k => emps[k].empId === r.employeeId)))
      return f?.req ? typeof r.takenDates === 'string' && r.takenDates.length > 0 : r.takenDates === ''
    })
    check('takenDates：有單先出（4 人有單 / 10 人空）', takenDates,
      rows.filter(r => r.takenDates).map(r => `${r.name}=${r.takenDates}`).join(' | '))
  }

  console.log('\n== MD §六.4 回歸 ==')
  // #17 三欄（上月剩 / R+PL / 剩餘）口徑唔變
  {
    const ok = rows.every(r =>
      typeof r.restQuota === 'number' &&
      r.restBalanceRemaining === 0 &&          // 無 REST_DAY row → ?? 0
      r.lastMonthRestRemaining === null &&      // 無 snapshot + 無 row → null（cwm-lba 語義）
      r.lastMonthRestSource === null)
    check('#17 上月剩 / R+PL / 剩餘三欄口徑唔變 ★★★', ok,
      rows.slice(0, 3).map(r => `q=${r.restQuota},rest=${r.restBalanceRemaining},lmr=${r.lastMonthRestRemaining}`).join(' | '))
  }
  // #18 LeaveBalance 純讀
  {
    const balSnap = async () => (await prisma.leaveBalance.findMany({ orderBy: { id: 'asc' } }))
    const before = await balSnap()
    // 再打一次 API（同一次 run 內多打一輪，確保多輪調用都零寫）
    await summaryGet(mkReq(`/api/scheduling-leave-summary?companyId=${company.id}&periodMonth=${periodMonth}`, inprocToken))
    const after = await balSnap()
    const eq = JSON.stringify(before) === JSON.stringify(after)
    check('#18 LeaveBalance 表零改動（純讀）★★★', eq,
      eq ? `${before.length} 行 byte-equal` : `改咗：${JSON.stringify(before).slice(0, 120)}…`)
  }
  // #19 計糧 / 離職結算無關：resign-preview 照舊讀 LeaveBalance.used 源
  {
    const m = emps.cel
    const pvRes = await resignPreviewGet(
      mkReq(`/api/employees/${m.empId}/resign-preview?lastDay=${today}`, inprocToken),
      { params: Promise.resolve({ id: m.empId }) },
    )
    let ok = false, det = ''
    if (pvRes.status !== 200) det = `preview ${pvRes.status}`
    else {
      const pv = await pvRes.json()
      const unused = pv.leaveSettlement?.unused as number
      const expectUnused = r2(Math.max(0, m.entitledDB - m.usedDB))
      ok = Math.abs(unused - expectUnused) < 0.005
      det = `unused=${unused} expect=${expectUnused}（source = LeaveBalance，與本單無關）`
    }
    check('#19 離職結算「未放」照舊 = f(LeaveBalance.used)（celia）★★★', ok, det)
  }
  // #16 §五 Suki 0.96 = 生產數據問題（balanceRemaining 累積制 vs 當年口徑）— dev DB 冇生產數據，記低唔追
  console.log('  ℹ️ #16 Suki 0.96 差異 = 生產數據問題（MD §五，balanceRemaining 累積 vs 當年口徑）— dev DB 冇生產 12 人，無法重現；report 記低，唔阻落刀')

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

  // 殘留驗證（本 run + 全局 e2aus% 防舊 crash 殘留）
  const [lr, lb, ec, prl, e, u, cl, co, strayEmp, strayLb, strayLr] = await Promise.all([
    prisma.leaveRequest.count({ where: { employeeId: { in: empIds } } }),
    prisma.leaveBalance.count({ where: { employeeId: { in: empIds } } }),
    prisma.employeeClinic.count({ where: { employeeId: { in: empIds } } }),
    prisma.payRule.count({ where: { employeeId: { in: empIds } } }),
    prisma.employee.count({ where: { id: { in: empIds } } }),
    prisma.user.count({ where: { id: { in: userIds } } }),
    prisma.clinic.count({ where: { id: data.clinicId } }),
    prisma.company.count({ where: { id: data.companyId } }),
    prisma.employee.count({ where: { id: { startsWith: 'e2aus' } } }),
    prisma.leaveBalance.count({ where: { id: { startsWith: 'e2aus' } } }),
    prisma.leaveRequest.count({ where: { id: { startsWith: 'e2aus' } } }),
  ])
  const left = [lr, lb, ec, prl, e, u, cl, co, strayEmp, strayLb, strayLr]
  check('sweep 0 殘留（LR/LB/EmpClinic/PayRule/Employee/User/Clinic/Company + 全局 e2aus%）',
    left.every(n => n === 0),
    `LR=${lr} LB=${lb} EC=${ec} PR=${prl} E=${e} U=${u} C=${cl} Co=${co} strayE=${strayEmp} strayLB=${strayLb} strayLR=${strayLr}`)
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
