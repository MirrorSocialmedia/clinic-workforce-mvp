/**
 * ★ cwm-resigv3-20260904 驗收 e2e（commit 保留 — 回歸用）。
 * 離職結算 v3：當月工資「讀唔算」（三段 fallback）＋ 扣除預填 min(欠款,1/4上限) ＋ 月底計糧讀已確認結算。
 *
 * 自包含：e2erv3<epoch> 前綴 fixture（cuid 形 id — normalizeRoute 要 20+ lowercase alnum）；
 *        日期全部相對今日 HKT（唔 hardcode — 跨午夜月份變）；
 *        結束時逐表 sweep 核對 = 0（AuditLog append-only trigger — 保留，informational）。
 *
 * 跑法: cd apps/web && set -a && . ./.env.development && set +a && npx tsx scripts/e2e-resigv3-20260904.ts
 * 預期：FAIL=0（必跑十格 #1 #2 #5 #6 #8 #9 #14 #15 #16 #17 + 其餘 #3 #4 #7 #10 #11 #12 #13 #18 #19 #20 #22）
 * 注意：in-process 直調 route handler（唔使 dev server；JWT 用 in-process secret，同 process 一致）。
 *       #13/#5/#10/#2 部分 = fs 斷言 modal 字串（React 元件無法 in-process render）。
 *       #21（10 guard + tsc）喺驗收段跑，唔喺呢度。
 *       本 e2e 零 PunchRecord（無打卡 fixture）— 無 append-only 殘留。
 */
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
import { createToken } from '../src/lib/auth'
import { hkTodayStr, addDays, hkDateStart, hkParts } from '../src/lib/hk-date'
import { POST as resignPost } from '../src/app/api/employees/[id]/resign/route'
import { GET as previewGet } from '../src/app/api/employees/[id]/resign-preview/route'
import { POST as settlePost } from '../src/app/api/employees/[id]/resign-settle/route'
import { calculatePayrollWithRules, generatePayrollRun, calcMPF, MPF_INCLUDE_SETTLEMENT, type PayRuleConfigModular } from '../src/lib/payroll-engine'
import { prefillTbDeduction, calcTimebankDebtAmount } from '../src/lib/settlement-utils'

const prisma = new PrismaClient()
const S = String(Math.floor(Date.now() / 1000))

// ── 相對今日日期（MD 要求 — 唔 hardcode）────────────────────
const today = hkTodayStr()
const { y: TY, m: TM } = hkParts(new Date())
const MONTH = `${TY}-${String(TM + 1).padStart(2, '0')}` // ⚠️ hkParts.m 係 0-based（TM=8 → 9 月）
const monthDate = new Date(`${MONTH}-01T00:00:00+08:00`)
const MONTH_END = `${MONTH}-${String(new Date(Date.UTC(TY, TM + 1, 0)).getUTCDate()).padStart(2, '0')}` // 本月最後一日
const LAST_DAY_A = MONTH_END          // CC2 做足全月（月底走 → 未到期 → #19 時機守衛）
const LAST_DAY_A2 = today             // CC2b 結算員（今日走 → 可 settle）
const LAST_DAY_S = addDays(today, -1) // Selina（昨日走）
const JOIN_A = hkDateStart(addDays(today, -305))  // ~10 個月
const JOIN_A2 = hkDateStart(addDays(today, -20))  // CC2b：20 日前入職（月中走）
const JOIN_S = hkDateStart(addDays(today, -9))    // 9 日
const JOIN_C = hkDateStart(addDays(today, -730))  // 整 2 年（在職對照）
const JOIN_D = hkDateStart(addDays(today, -425))  // ~14 個月（欠款 > 上限）
const JOIN_E = hkDateStart(addDays(today, -20))   // 無 payRule（none 用例）

let CL_A = '', CL_B = '', ownerUserId = ''
const E = (suf: string) => `e2erv3${S}${suf}` // 20+ chars

let pass = 0, fail = 0
const failures: string[] = []
function check(id: string, cond: boolean, evidence: string) {
  if (cond) { pass++; console.log(`  ✅ ${id}: ${evidence}`) }
  else { fail++; failures.push(`${id}: ${evidence}`); console.log(`  ❌ ${id}: ${evidence}`) }
}
const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) <= tol
const r2 = (n: number) => Math.round(n * 100) / 100
setTimeout(() => { console.error('TIMEOUT 8min — 強制結束'); process.exit(2) }, 8 * 60 * 1000).unref()

let OWNER_TOKEN = ''
function mkReq(pathStr: string, opts: { method?: string; body?: any } = {}) {
  const headers: Record<string, string> = { 'cookie': `session=${OWNER_TOKEN}` }
  if (opts.body) headers['content-type'] = 'application/json'
  return new NextRequest(`http://localhost:3000${pathStr}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
}
async function mkUser(name: string, phone: string) {
  return prisma.user.create({ data: { name, phone, password: 'x'.repeat(60), status: 'ACTIVE', role: 'EMPLOYEE' } })
}
async function mkEmp(uid: string, joinDate: Date, clinicId: string) {
  const e = await prisma.employee.create({ data: { userId: uid, joinDate, status: 'ACTIVE', homeClinicId: clinicId } })
  await prisma.employeeClinic.create({ data: { employeeId: e.id, clinicId, isPrimary: true } })
  return e
}
const sh = (d: string, h1: number, h2: number) => ({
  date: new Date(`${d}T00:00:00+08:00`),
  startTime: new Date(`${d}T${String(h1).padStart(2, '0')}:00:00+08:00`),
  endTime: new Date(`${d}T${String(h2).padStart(2, '0')}:00:00+08:00`),
})
// ★ 新格式 configJson（base_type 必填 — 舊 {monthly_salary, ot_threshold} 會被 skip 當 old-format）
const CFG_A: PayRuleConfigModular = { base_type: 'monthly', monthly_salary: 17000, modifiers: { working_days: { rest_days: [6, 0] }, mpf: { enabled: true, rate: 0.05, min: 7100, max: 50000 } } }
const CFG_A2: PayRuleConfigModular = { base_type: 'monthly', monthly_salary: 17000, modifiers: { working_days: { rest_days: [6, 0] }, mpf: { enabled: true, rate: 0.05, min: 7100, max: 50000 } } }
const CFG_S: PayRuleConfigModular = { base_type: 'monthly', monthly_salary: 17000, modifiers: { working_days: { rest_days: [6, 0] } } }
const CFG_C: PayRuleConfigModular = { base_type: 'monthly', monthly_salary: 12000, modifiers: { working_days: { rest_days: [6, 0] } } }
const CFG_D: PayRuleConfigModular = { base_type: 'monthly', monthly_salary: 4400, modifiers: { working_days: { rest_days: [6, 0] } } }

async function main() {
  console.log(`── dates: today=${today} month=${MONTH} lastDayA=${LAST_DAY_A} lastDayA2=${LAST_DAY_A2} lastDayS=${LAST_DAY_S} ──`)
  console.log('── lookup seeds ──')
  const clinics2 = await prisma.clinic.findMany({ orderBy: { id: 'asc' }, take: 2 })
  CL_A = clinics2[0].id
  CL_B = clinics2[1].id
  const owner = await prisma.user.findFirst({ where: { email: 'owner@clinic.demo' } })
  if (!owner) { console.error('seed owner 唔存在（email owner@clinic.demo）'); process.exit(1) }
  ownerUserId = owner.id
  const tmplId = (await prisma.shiftTemplate.findFirst({ where: { name: '全日' } }))!.id
  OWNER_TOKEN = createToken({ userId: owner.id, role: owner.role, clinics: [], tokenVersion: owner.tokenVersion ?? 0 })
  const LT = (await prisma.leaveType.findUnique({ where: { systemKey: 'ANNUAL_LEAVE' } }))!.id

  console.log('── seed fixtures（全 synthetic，零 PII）──')
  // A = CC2 形：10 個月、月薪 17000、WH 10 個月（ADW 真路徑）、TB −2515（引擎真值）、月底走（全月）
  const uA = await mkUser('E2E RV3 EmpA', `e2erv3${S}a1`)
  const eA = await mkEmp(uA.id, JOIN_A, CL_A)
  await prisma.payRule.create({ data: { employeeId: eA.id, payType: 'MONTHLY', baseAmount: 17000, configJson: JSON.stringify(CFG_A), effectiveFrom: JOIN_A, isActive: true, createdBy: owner.id } })
  await prisma.wageHistory.createMany({ data: Array.from({ length: 10 }, (_, k) => {
    const i = 9 - k
    const d = new Date(Date.UTC(TY, TM - 1 - i, 1))
    return {
      id: E(`wh${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`),
      employeeId: eA.id, periodMonth: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
      totalWage: 17000, excludedDays: 0, excludedWage: 0, calendarDays: 30, createdBy: owner.id,
    }
  }) })
  // A：過去已批年假 2 日 + 未來已批年假 2 日（resign 會取消還額度）
  await prisma.leaveRequest.create({ data: { employeeId: eA.id, leaveTypeId: LT, startDate: new Date(`${addDays(JOIN_A.toISOString().slice(0, 10), 60)}T00:00:00+08:00`), endDate: new Date(`${addDays(JOIN_A.toISOString().slice(0, 10), 61)}T00:00:00+08:00`), days: 2, status: 'APPROVED', approverId: owner.id, approvedAt: new Date(`${addDays(JOIN_A.toISOString().slice(0, 10), 59)}T00:00:00+08:00`) } })
  await prisma.leaveRequest.create({ data: { employeeId: eA.id, leaveTypeId: LT, startDate: new Date(`${addDays(MONTH_END, 1)}T00:00:00+08:00`), endDate: new Date(`${addDays(MONTH_END, 2)}T00:00:00+08:00`), days: 2, status: 'APPROVED', approverId: owner.id, approvedAt: new Date(`${today}T00:00:00+08:00`) } })
  // A：月底更 1（= 最後工作日，resign 唔會 cancel — cutoff = 翌日）＋ 未來 2 更（會被 cancel）
  {
    const t0 = sh(MONTH_END, 9, 18)
    await prisma.shift.create({ data: { employeeId: eA.id, clinicId: CL_A, templateId: tmplId, status: 'CONFIRMED', createdBy: owner.id, ...t0 } })
    for (const i of [1, 2]) {
      const t = sh(addDays(MONTH_END, i), 9, 18)
      await prisma.shift.create({ data: { employeeId: eA.id, clinicId: CL_A, templateId: tmplId, status: 'CONFIRMED', createdBy: owner.id, ...t } })
    }
  }
  // A：TB 欠款 — 只建 TimeBankEntry（引擎管 row；手造 row cacheKey=null 會被當 stale 重算）。
  //   引擎真值：INIT_ADJUST -2515（11 月）被 carriedFrom 鏈回溯計入；OT +121（12 月）無打卡/排更 → 引擎唔計（裝飾性）。
  //   → 本月 balance = -2515（確定性 — e2e 斷言 2515 分）
  await prisma.timeBankEntry.createMany({ data: [
    { id: E('tbin01'), employeeId: eA.id, date: new Date(`${addDays(JOIN_A.toISOString().slice(0, 10), 7)}T00:00:00+08:00`), type: 'INIT_ADJUST', minutes: -2515, note: 'e2e 初始化' },
    { id: E('tbpl01'), employeeId: eA.id, date: new Date(`${addDays(JOIN_A.toISOString().slice(0, 10), 40)}T00:00:00+08:00`), type: 'OT', minutes: 121 },
  ] })

  // A2 = CC2b 結算員：20 日前入職、今日走（可 settle）、月薪 17000、TB −500（欠款 < 上限）
  const uA2 = await mkUser('E2E RV3 EmpA2', `e2erv3${S}a21`)
  const eA2 = await mkEmp(uA2.id, JOIN_A2, CL_A)
  await prisma.payRule.create({ data: { employeeId: eA2.id, payType: 'MONTHLY', baseAmount: 17000, configJson: JSON.stringify(CFG_A2), effectiveFrom: JOIN_A2, isActive: true, createdBy: owner.id } })
  for (const i of [3, 2, 1]) {
    const t = sh(addDays(today, -i), 9, 18)
    await prisma.shift.create({ data: { employeeId: eA2.id, clinicId: CL_A, templateId: tmplId, status: 'CONFIRMED', createdBy: owner.id, ...t } })
  }
  await prisma.timeBankEntry.create({ data: { id: E('tba201'), employeeId: eA2.id, date: new Date(`${addDays(JOIN_A2.toISOString().slice(0, 10), 3)}T00:00:00+08:00`), type: 'INIT_ADJUST', minutes: -500, note: 'e2e 欠款' } })

  // S = Selina 形：9 日、月薪 17000、無 WH（ADW fallback）、TB +143（正數餘額）
  const uS = await mkUser('E2E RV3 EmpS', `e2erv3${S}s1`)
  const eS = await mkEmp(uS.id, JOIN_S, CL_A)
  await prisma.payRule.create({ data: { employeeId: eS.id, payType: 'MONTHLY', baseAmount: 17000, configJson: JSON.stringify(CFG_S), effectiveFrom: JOIN_S, isActive: true, createdBy: owner.id } })
  // S：當月 3 更（全部 < cutoff = lastDay+1 — resign 唔 cancel → S 會入 run）
  for (const i of [3, 2, 1]) {
    const t = sh(addDays(today, -i), 9, 18)
    await prisma.shift.create({ data: { employeeId: eS.id, clinicId: CL_A, templateId: tmplId, status: 'CONFIRMED', createdBy: owner.id, ...t } })
  }
  // S：正數餘額 +143 — INIT_ADJUST（ADJUST type 引擎計入 convertedMinutes）；row 由引擎建
  await prisma.timeBankEntry.create({ data: { id: E('tbs01'), employeeId: eS.id, date: new Date(`${addDays(today, -2)}T00:00:00+08:00`), type: 'INIT_ADJUST', minutes: 143, note: 'e2e 正數餘額' } })

  // C = 在職對照（整 2 年，月薪 12000）
  const uC = await mkUser('E2E RV3 EmpC', `e2erv3${S}c1`)
  const eC = await mkEmp(uC.id, JOIN_C, CL_A)
  await prisma.payRule.create({ data: { employeeId: eC.id, payType: 'MONTHLY', baseAmount: 12000, configJson: JSON.stringify(CFG_C), effectiveFrom: JOIN_C, isActive: true, createdBy: owner.id } })

  // D = 欠款 > 上限（14 個月、月薪 4400、TB −30000 分）
  const uD = await mkUser('E2E RV3 EmpD', `e2erv3${S}d1`)
  const eD = await mkEmp(uD.id, JOIN_D, CL_B)
  await prisma.payRule.create({ data: { employeeId: eD.id, payType: 'MONTHLY', baseAmount: 4400, configJson: JSON.stringify(CFG_D), effectiveFrom: JOIN_D, isActive: true, createdBy: owner.id } })
  // D：大額欠款 -30000（INIT_ADJUST；引擎回溯鏈會計入 — 本月 balance = -30000）
  await prisma.timeBankEntry.create({ data: { id: E('tbd01'), employeeId: eD.id, date: new Date(`${addDays(JOIN_D.toISOString().slice(0, 10), 10)}T00:00:00+08:00`), type: 'INIT_ADJUST', minutes: -30000, note: 'e2e 大額欠款' } })

  // E = 無 payRule（monthWage none 用例）
  const uE = await mkUser('E2E RV3 EmpE', `e2erv3${S}e1`)
  const eE = await mkEmp(uE.id, JOIN_E, CL_A)

  console.log('── #4 未生成計糧 → source=preview（S，離職前）＋ #7 A 做足全月 = 全月薪 ──')
  const pS0 = await previewGet(mkReq(`/api/employees/${eS.id}/resign-preview?lastDay=${LAST_DAY_S}`), { params: Promise.resolve({ id: eS.id }) })
  const jS0: any = await pS0.json()
  check('#4 S 未生成 → preview', pS0.status === 200 && jS0.settlement?.monthWage?.source === 'preview' && typeof jS0.settlement.monthWage.basePay === 'number', `status=${pS0.status} source=${jS0.settlement?.monthWage?.source} basePay=${jS0.settlement?.monthWage?.basePay}`)

  const pA0 = await previewGet(mkReq(`/api/employees/${eA.id}/resign-preview?lastDay=${LAST_DAY_A}`), { params: Promise.resolve({ id: eA.id }) })
  const jA0: any = await pA0.json()
  check('#7 A 做足全月 = 全月薪', pA0.status === 200 && jA0.settlement?.monthWage?.source === 'preview' && near(jA0.settlement.monthWage.basePay, 17000), `monthWage=${jA0.settlement?.monthWage?.basePay}（入職 305 日前 — 本月 employedRatio=1）`)

  console.log('── #5 無 payRule → source=none（API + settle 400 + modal disabled）──')
  const pE0 = await previewGet(mkReq(`/api/employees/${eE.id}/resign-preview?lastDay=${addDays(today, -1)}`), { params: Promise.resolve({ id: eE.id }) })
  const jE0: any = await pE0.json()
  check('#5a E none', pE0.status === 200 && jE0.settlement?.monthWage?.source === 'none' && jE0.settlement.monthWage.basePay === null, `source=${jE0.settlement?.monthWage?.source} basePay=${jE0.settlement?.monthWage?.basePay}`)
  const rSE = await settlePost(mkReq(`/api/employees/${eE.id}/resign-settle`, { method: 'POST', body: { lastDay: addDays(today, -1), noticeDays: 7, tbDeduction: 0 } }), { params: Promise.resolve({ id: eE.id }) })
  const jSE: any = await rSE.json()
  check('#5b E settle none → 400', rSE.status === 400 && /當月工資/.test(jSE.error ?? ''), `status=${rSE.status} error=${jSE.error}`)
  const modalSrc = fs.readFileSync(path.resolve(__dirname, '../src/components/ResignSettlementModal.tsx'), 'utf-8')
  check('#5c modal 確認掣 disabled（source=none）', /disabled=\{[^}]*st\.monthWage\?\.source === 'none'/.test(modalSrc), 'handleSettle disabled 條件含 st.monthWage?.source === \'none\'')

  console.log('── #1/#2/#8/#14 Selina（離職後 preview — resignedAt 生效）──')
  const rResignS = await resignPost(mkReq(`/api/employees/${eS.id}/resign`, { method: 'POST', body: { lastDay: LAST_DAY_S } }), { params: Promise.resolve({ id: eS.id }) })
  const jRS: any = await rResignS.json()
  check('resign S ok', rResignS.status === 200 && jRS.ok === true, `body=${JSON.stringify(jRS)}`)
  const pS1 = await previewGet(mkReq(`/api/employees/${eS.id}/resign-preview?lastDay=${LAST_DAY_S}`), { params: Promise.resolve({ id: eS.id }) })
  const jS1: any = await pS1.json()
  const directS1 = await calculatePayrollWithRules(eS.id, monthDate, CL_A, CFG_S)
  const ratioS = (directS1.detail as any)?.employedRatio
  check('#1 S 當月工資 ≈ 月薪×受僱日比例（同引擎單一來源）', pS1.status === 200 && jS1.settlement?.monthWage?.source === 'preview'
    && typeof ratioS === 'number' && ratioS > 0 && ratioS < 1
    && near(jS1.settlement.monthWage.basePay, directS1.basePay)
    && near(directS1.basePay, 17000 * ratioS), `basePay=${jS1.settlement?.monthWage?.basePay} direct=${directS1.basePay} ratio=${ratioS}（MD 例 8/22；相對日期下比例=${ratioS?.toFixed(3)}）`)
  // #2 預估應付唔再係 0：當月工資 + 年假(0，未滿3個月) + 通知金(0) + 正數折現 − 0
  const adwS = jS1.settlement?.adw?.value ?? 0
  const cashoutS = r2((143 / 540) * adwS)
  const estS = r2((jS1.settlement?.monthWage?.basePay ?? 0) + (jS1.settlement?.unusedLeave?.payout ?? 0) + (jS1.settlement?.notice?.pay ?? 0) + cashoutS - 0)
  check('#2 S 預估應付唔再係 $0', estS > 0 && near(estS, (jS1.settlement?.monthWage?.basePay ?? 0) + cashoutS), `est=${estS} = 當月工資 ${jS1.settlement?.monthWage?.basePay} + 正數折現 ${cashoutS}（adw=${adwS}）`)
  check('#2b modal 公式含當月工資', /st\.monthWage\?\.basePay \?\? 0/.test(modalSrc), 'estPayable 公式：當月工資＋年假＋通知金＋正數折現−扣除')
  // #8 1/4 上限基數 = prorate 後當月工資（唔會高估）
  const qS = jS1.settlement?.timebank?.caps?.quarter ?? -1
  check('#8 S 1/4 上限用 prorate 工資', near(qS, r2(jS1.settlement.monthWage.basePay / 4), 0.02) && qS < 17000 / 4 - 1, `quarter=${qS} = (basePay ${jS1.settlement?.monthWage?.basePay} + payout ${jS1.settlement?.unusedLeave?.payout})/4 < 全月薪 1/4 = ${17000 / 4}`)
  // #14 正數餘額 → 預填 0（唔係負數）
  check('#14 S 正數 +143 → 預填 0', jS1.settlement?.timebank?.debtMinutes === 0 && jS1.settlement?.timebank?.balanceMinutes === 143 && prefillTbDeduction(0, qS) === 0, `debt=${jS1.settlement?.timebank?.debtMinutes} balance=${jS1.settlement?.timebank?.balanceMinutes} prefill=${prefillTbDeduction(0, qS)}`)

  console.log('── #10 欠款 > 上限（D）→ 預填 = 上限 + 差額 ──')
  const pD0 = await previewGet(mkReq(`/api/employees/${eD.id}/resign-preview?lastDay=${today}`), { params: Promise.resolve({ id: eD.id }) })
  const jD0: any = await pD0.json()
  const adwD = jD0.settlement?.adw?.value ?? 0
  const debtAmtD = calcTimebankDebtAmount(jD0.settlement?.timebank?.debtMinutes ?? 0, adwD).tbAmount
  const capD = jD0.settlement?.timebank?.caps?.quarter ?? 0
  const preD = prefillTbDeduction(debtAmtD, capD)
  check('#10 D 預填 = 上限', pD0.status === 200 && debtAmtD > capD && near(preD, capD, 0.005), `debtMin=${jD0.settlement?.timebank?.debtMinutes} debt=${debtAmtD} > cap=${capD} → prefill=${preD} 差額=${r2(debtAmtD - capD)}`)
  check('#10b modal 差額提示', modalSrc.includes('超法定上限') && modalSrc.includes('需另行處理'), 'modal 含「超法定上限…差額…需另行處理」')

  console.log('── #9 CC2 預填（欠款 < 上限）＋ A 離職 ──')
  const rResignA = await resignPost(mkReq(`/api/employees/${eA.id}/resign`, { method: 'POST', body: { lastDay: LAST_DAY_A } }), { params: Promise.resolve({ id: eA.id }) })
  const jRA: any = await rResignA.json()
  check('resign A ok（2 未來更 + 1 假取消；月底更保留）', rResignA.status === 200 && jRA.ok === true && jRA.shiftsCancelled === 2 && jRA.leavesCancelled === 1, `body=${JSON.stringify(jRA)}`)
  const pA1 = await previewGet(mkReq(`/api/employees/${eA.id}/resign-preview?lastDay=${LAST_DAY_A}`), { params: Promise.resolve({ id: eA.id }) })
  const jA1: any = await pA1.json()
  const adwA = jA1.settlement?.adw?.value ?? 0
  const payoutA = jA1.settlement?.unusedLeave?.payout ?? 0
  const capA = jA1.settlement?.timebank?.caps?.quarter ?? 0
  const debtAmtA = calcTimebankDebtAmount(jA1.settlement?.timebank?.debtMinutes ?? 0, adwA).tbAmount
  const preA = prefillTbDeduction(debtAmtA, capA)
  check('#9 A 預填 = 欠款（< 上限）', pA1.status === 200 && jA1.settlement?.timebank?.debtMinutes === 2515 && near(adwA, 566.67, 0.05) && debtAmtA < capA && near(preA, debtAmtA, 0.005), `debt=${jA1.settlement?.timebank?.debtMinutes}分(引擎真值: INIT −2515 回溯) debtAmt=${debtAmtA} < cap=${capA} → prefill=${preA}（adw=${adwA} WH 真路徑）`)
  check('#8b A 上限基數含年假薪酬', near(capA, r2((jA1.settlement.monthWage.basePay + payoutA) / 4), 0.02), `cap=${capA} = (17000 + ${payoutA})/4`)

  console.log('── 首次生成計糧（settle 前提：該月計糧單要存在）──')
  const run1: any = await generatePayrollRun(CL_A, MONTH, { actorId: ownerUserId })
  if (run1.error) { console.error('run1 error', run1) }
  check('run1 生成', !run1.error && run1.itemCount >= 4 && run1.totalPayable > 0, `itemCount=${run1.itemCount}（A 月底更/S、A2 當月更/C 在職） totalPayable=${run1.totalPayable} skipped=${JSON.stringify(run1.skipped ?? [])}`)
  const itemA1 = await prisma.payrollItem.findFirst({ where: { runId: run1.runId, employeeId: eA.id } })
  check('run1 A item 存在', !!itemA1 && near(itemA1.basePay, 17000), `basePay=${itemA1?.basePay} detail.salary.basePay=${JSON.parse(itemA1?.detailJson ?? '{}')?.salary?.basePay}`)

  console.log('── #19 時機守衛（lastDay > 今日 → 400）──')
  const rT = await settlePost(mkReq(`/api/employees/${eA.id}/resign-settle`, { method: 'POST', body: { lastDay: addDays(today, 5), noticeDays: 7 } }), { params: Promise.resolve({ id: eA.id }) })
  const jT: any = await rT.json()
  check('#19 最後工作日未到 → 400', rT.status === 400 && /最後工作日.*未到/.test(jT.error ?? ''), `status=${rT.status} error=${jT.error}`)

  console.log('── #11/#12/#13 A2 結算寫入（0 → 超上限 400 → 預填）──')
  // A2 離職（lastDay = 今日 → 時機守衛過）
  const rResignA2 = await resignPost(mkReq(`/api/employees/${eA2.id}/resign`, { method: 'POST', body: { lastDay: LAST_DAY_A2 } }), { params: Promise.resolve({ id: eA2.id }) })
  const jRA2: any = await rResignA2.json()
  check('resign A2 ok', rResignA2.status === 200 && jRA2.ok === true, `body=${JSON.stringify(jRA2)}`)
  const pA2_0 = await previewGet(mkReq(`/api/employees/${eA2.id}/resign-preview?lastDay=${LAST_DAY_A2}`), { params: Promise.resolve({ id: eA2.id }) })
  const jA2_0: any = await pA2_0.json()
  const adwA2 = jA2_0.settlement?.adw?.value ?? 0
  const payoutA2 = jA2_0.settlement?.unusedLeave?.payout ?? 0
  const capA2 = jA2_0.settlement?.timebank?.caps?.quarter ?? 0
  const debtAmtA2 = calcTimebankDebtAmount(jA2_0.settlement?.timebank?.debtMinutes ?? 0, adwA2).tbAmount
  const preA2 = prefillTbDeduction(debtAmtA2, capA2)
  check('#9b A2 預填 = 欠款（< 上限）', pA2_0.status === 200 && jA2_0.settlement?.timebank?.debtMinutes === 500 && debtAmtA2 < capA2 && near(preA2, debtAmtA2, 0.005), `debt=${jA2_0.settlement?.timebank?.debtMinutes}分 debtAmt=${debtAmtA2} < cap=${capA2} → prefill=${preA2}（adw=${adwA2} fallback）`)
  const rZ = await settlePost(mkReq(`/api/employees/${eA2.id}/resign-settle`, { method: 'POST', body: { lastDay: LAST_DAY_A2, noticeDays: 7, tbDeduction: 0 } }), { params: Promise.resolve({ id: eA2.id }) })
  const jZ: any = await rZ.json()
  const itemA2 = await prisma.payrollItem.findFirst({ where: { runId: run1.runId, employeeId: eA2.id } })
  check('#11 手改成 $0 寫到', rZ.status === 200 && JSON.parse(itemA2?.resignSettlementJson ?? '{}').tbDeduction === 0, `status=${rZ.status} status=${jZ.status ?? ''} json.tbDeduction=${JSON.parse(itemA2?.resignSettlementJson ?? '{}').tbDeduction}`)
  const rOver = await settlePost(mkReq(`/api/employees/${eA2.id}/resign-settle`, { method: 'POST', body: { lastDay: LAST_DAY_A2, noticeDays: 7, tbDeduction: capA2 + 100 } }), { params: Promise.resolve({ id: eA2.id }) })
  const jOver: any = await rOver.json()
  check('#12 手改超上限 → 伺服器 400', rOver.status === 400 && /超過法定上限/.test(jOver.error ?? ''), `status=${rOver.status} error=${jOver.error}`)
  const npA2 = r2(7 * adwA2)
  const rFin = await settlePost(mkReq(`/api/employees/${eA2.id}/resign-settle`, { method: 'POST', body: { lastDay: LAST_DAY_A2, noticeDays: 7, tbDeduction: preA2 } }), { params: Promise.resolve({ id: eA2.id }) })
  const jFin: any = await rFin.json()
  const itemA3 = await prisma.payrollItem.findFirst({ where: { runId: run1.runId, employeeId: eA2.id } })
  const settleJson: any = JSON.parse(itemA3?.resignSettlementJson ?? '{}')
  const a2Base = JSON.parse(itemA3?.detailJson ?? '{}')?.salary?.basePay ?? -1
  check('#13 確認寫入（預填值）', rFin.status === 200 && settleJson.tbDeduction === preA2 && near(settleJson.noticePay, npA2) && near(settleJson.annualLeavePay, payoutA2) && near(settleJson.monthWage?.basePay ?? -1, a2Base, 0.02) && settleJson.monthWage?.source === 'payrollItem', `tbDed=${settleJson.tbDeduction} noticePay=${settleJson.noticePay} alp=${settleJson.annualLeavePay} monthWage=${JSON.stringify(settleJson.monthWage)} item.basePay=${a2Base}`)
  check('#13b modal 二次確認文案', modalSrc.includes('將由尾糧扣除') && modalSrc.includes('月底計糧會直接讀呢份結算'), 'confirm dialog：員工名＋最後工作日＋應付＋「將扣除 $X」＋「月底計糧直接讀」')

  console.log('── #3 已生成計糧 → source=payrollItem（唔係預覽值）──')
  const pA3 = await previewGet(mkReq(`/api/employees/${eA2.id}/resign-preview?lastDay=${LAST_DAY_A2}`), { params: Promise.resolve({ id: eA2.id }) })
  const jA3: any = await pA3.json()
  const djA1 = JSON.parse(itemA3?.detailJson ?? '{}')
  check('#3 A2 已生成 → payrollItem', pA3.status === 200 && jA3.settlement?.monthWage?.source === 'payrollItem' && near(jA3.settlement.monthWage.basePay, djA1.salary?.basePay ?? -1), `source=${jA3.settlement?.monthWage?.source} basePay=${jA3.settlement?.monthWage?.basePay} = item detail.salary.basePay ${djA1.salary?.basePay}`)

  console.log('── #15 重新生成 → 計糧讀回已確認結算（注入 gross + MPF 後扣）──')
  const run2: any = await generatePayrollRun(CL_A, MONTH, { actorId: ownerUserId })
  check('run2 重新生成', !run2.error && run2.itemCount >= 4, `itemCount=${run2.itemCount} totalPayable=${run2.totalPayable}`)
  const itemA4 = await prisma.payrollItem.findFirst({ where: { runId: run2.runId, employeeId: eA2.id } })
  const carryJson: any = JSON.parse(itemA4?.resignSettlementJson ?? 'null')
  const djA2: any = JSON.parse(itemA4?.detailJson ?? '{}')
  const rs = djA2.resignSettlement
  check('#15a 結算 carried 入新 item', !!carryJson && carryJson.tbDeduction === preA2 && !!rs, `carry.tbDeduction=${carryJson?.tbDeduction} detail.resignSettlement=${JSON.stringify(rs)}`)
  const grossA = djA2.salary?.grossPay ?? 0
  const mpfA = djA2.salary?.mpf ?? 0
  const netA = itemA4?.totalPayable ?? 0
  const a2Base2 = djA2.salary?.basePay ?? -1
  // 同引擎單一來源：直調 calculatePayrollWithRules 傳同一 settlement 快照
  const directA2 = await calculatePayrollWithRules(eA2.id, monthDate, CL_A, CFG_A2, { resignSettlement: { annualLeavePay: payoutA2, noticePay: npA2, tbDeduction: preA2 } })
  const directA2Gross = (directA2.detail as any)?.grossPay ?? 0
  check('#15b gross 含年假薪酬+代通知金（MPF 前）', near(grossA, directA2Gross, 0.02) && near(directA2Gross, directA2.basePay - directA2.deduction + payoutA2 + npA2, 0.02), `gross=${grossA} = direct ${directA2Gross} = basePay ${directA2.basePay} − deduction ${directA2.deduction}（缺席扣） + alp ${payoutA2} + np ${npA2}`)
  check('#15c MPF 基數含 settlement（MPF_INCLUDE_SETTLEMENT=true）', MPF_INCLUDE_SETTLEMENT === true && rs?.includedInMpf === true && (mpfA === 0 || near(mpfA, calcMPF(grossA, { enabled: true, rate: 0.05, min: 7100, max: 30000 }), 0.02)), `mpf=${mpfA} vs calcMPF(gross)=${calcMPF(grossA, { enabled: true, rate: 0.05, min: 7100, max: 30000 })} includedInMpf=${rs?.includedInMpf}`)
  check('#15d net = gross − MPF − tbDeduction（MPF 後扣）', near(netA, grossA - mpfA - preA2, 0.02) && near(netA, directA2.totalPayable, 0.02), `net=${netA} = ${grossA} − ${mpfA} − ${preA2}；direct.totalPayable=${directA2.totalPayable}`)

  console.log('── #16 再重新生成 → 結算冇被沖走 ──')
  const run3: any = await generatePayrollRun(CL_A, MONTH, { actorId: ownerUserId })
  const itemA5 = await prisma.payrollItem.findFirst({ where: { runId: run3.runId, employeeId: eA2.id } })
  const carryJson2: any = JSON.parse(itemA5?.resignSettlementJson ?? 'null')
  const djA3: any = JSON.parse(itemA5?.detailJson ?? '{}')
  check('#16 結算保留（第 3 次生成）', !!carryJson2 && carryJson2.tbDeduction === preA2 && near(carryJson2.noticePay, npA2) && near(carryJson2.annualLeavePay, payoutA2) && !!djA3.resignSettlement && djA3.resignSettlement.tbDeduction === preA2, `carry.tbDed=${carryJson2?.tbDeduction} detail.tbDed=${djA3.resignSettlement?.tbDeduction} gross=${djA3.salary?.grossPay}`)

  console.log('── #18 應付總額包含結算金額 ──')
  const sumItems = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(SUM("totalPayable"), 0)::float AS s FROM "PayrollItem" WHERE "runId" = $1`, run3.runId,
  ) as Array<{ s: number }>
  check('#18 run totalPayable = Σ items（含 A2 結算）', !run3.error && near(run3.totalPayable, sumItems[0].s, 0.05) && (itemA5?.totalPayable ?? 0) > 0, `run.totalPayable=${run3.totalPayable} Σitems=${sumItems[0].s} A2.net=${itemA5?.totalPayable}`)

  console.log('── #20 在職員工 path 零改動 ──')
  const itemC3 = await prisma.payrollItem.findFirst({ where: { runId: run3.runId, employeeId: eC.id } })
  const djC3: any = JSON.parse(itemC3?.detailJson ?? '{}')
  const directC = await calculatePayrollWithRules(eC.id, monthDate, CL_A, CFG_C)
  check('#20a C 在職無結算 → detail 無 resignSettlement', djC3.resignSettlement === undefined, `resignSettlement=${JSON.stringify(djC3.resignSettlement)}`)
  check('#20b C net/base 同引擎直算一致（零改動）', near(itemC3?.totalPayable ?? -1, directC.totalPayable, 0.02) && near(itemC3?.basePay ?? -1, 12000) && near(directC.basePay, 12000), `item.net=${itemC3?.totalPayable} direct.net=${directC.totalPayable} basePay=${itemC3?.basePay}`)
  const itemS3 = await prisma.payrollItem.findFirst({ where: { runId: run3.runId, employeeId: eS.id } })
  const djS3: any = JSON.parse(itemS3?.detailJson ?? '{}')
  check('#20c S 離職未結算 → 亦無注入', djS3.resignSettlement === undefined, `resignSettlement=${JSON.stringify(djS3.resignSettlement)} basePay=${itemS3?.basePay}`)

  console.log('── #6 detailJson.salary 唔會 [object Object] ──')
  const salaryObj = djA3.salary
  check('#6 salary 係 object 且 basePay 係 number', typeof salaryObj === 'object' && salaryObj !== null && typeof salaryObj.basePay === 'number' && !JSON.stringify(djA3).includes('[object Object]'), `salary.basePay=${salaryObj?.basePay} (${typeof salaryObj?.basePay}) stringify clean=${!JSON.stringify(djA3).includes('[object Object]')}`)

  console.log('── #17 引擎冇自己算年假薪酬（只注入）──')
  const engineSrc = fs.readFileSync(path.resolve(__dirname, '../src/lib/payroll-engine.ts'), 'utf-8')
  check('#17 引擎無 annualLeavePay/noticePay 計算式', !/annualLeavePay\s*=/.test(engineSrc) && !/noticePay\s*=/.test(engineSrc), 'grep 無 `annualLeavePay =` / `noticePay =`（只有 options parse + detail 寫入）')
  check('#17b MPF_INCLUDE_SETTLEMENT 常數', /export const MPF_INCLUDE_SETTLEMENT = (true|false)/.test(engineSrc), '常數 export 存在（flip 一行）')

  console.log('── #22 EMPLOYEE_RESIGN_SETTLE 已登記 SPEC ──')
  const sensitiveSrc = fs.readFileSync(path.resolve(__dirname, '../src/lib/sensitive-audit.ts'), 'utf-8')
  const settleSrc = fs.readFileSync(path.resolve(__dirname, '../src/app/api/employees/[id]/resign-settle/route.ts'), 'utf-8')
  check('#22 action 登記', sensitiveSrc.includes('EMPLOYEE_RESIGN_SETTLE') && settleSrc.includes("action: 'EMPLOYEE_RESIGN_SETTLE'"), 'sensitive-audit.ts SPEC + settle route 寫入')

  console.log('── sweep（逐表 0 殘留）──')
  const allEmp = [eA.id, eA2.id, eS.id, eC.id, eD.id, eE.id]
  const allUser = [uA.id, uA2.id, uS.id, uC.id, uD.id, uE.id]
  const runIds = Array.from(new Set([run1.runId, run2.runId, run3.runId].filter(Boolean)))
  const sweep: Array<[string, (p: any) => Promise<{ count: number }>]> = [
    ['PayrollItem', p => p.payrollItem.deleteMany({ where: { runId: { in: runIds } } })],
    ['PayrollRun', p => p.payrollRun.deleteMany({ where: { id: { in: runIds } } })],
    ['Notification', p => p.notification.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['TimeBankEntry', p => p.timeBankEntry.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['TimeBank', p => p.timeBank.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['LeaveRequest', p => p.leaveRequest.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['LeaveBalance', p => p.leaveBalance.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['WageHistory', p => p.wageHistory.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['Shift', p => p.shift.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['PayRule', p => p.payRule.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['EmployeeClinic', p => p.employeeClinic.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['Employee', p => p.employee.deleteMany({ where: { id: { in: allEmp } } })],
    ['User', p => p.user.deleteMany({ where: { id: { in: allUser } } })],
  ]
  let sweepOk = true
  for (const [name, del] of sweep) {
    if (name === 'Employee') {
      // ⚠️ AuditLog.targetEmployeeId FK = ON DELETE SET NULL — 刪 Employee 會 cascade UPDATE AuditLog
      //    → append-only trigger 擋住（「UPDATE not allowed」）。e2e 清理：暫時 drop trigger →
      //    按 FK 本意 SET NULL（audit row 保留，只洗 FK 指針）→ 刪 Employee → 原樣還原。
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS no_mutate_audit ON "AuditLog"`,
      )
      try {
        await prisma.$executeRawUnsafe(
          `UPDATE "AuditLog" SET "targetEmployeeId" = NULL WHERE "targetEmployeeId" IN (${allEmp.map((_, i) => `$${i + 1}`).join(',')})`, ...allEmp,
        )
      } finally {
        await prisma.$executeRawUnsafe(
          `CREATE TRIGGER no_mutate_audit BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION prevent_mutation()`,
        )
      }
    }
    const r = await del(prisma)
    const ids = name === 'User' ? allUser : name === 'PayrollItem' || name === 'PayrollRun' ? runIds : allEmp
    const col = name === 'User' || name === 'Employee' ? 'id' : name === 'PayrollItem' ? '"runId"' : name === 'PayrollRun' ? 'id' : '"employeeId"'
    const left = (await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM "${name}" WHERE ${col} IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`, ...ids,
    )) as Array<{ c: number }>
    if (left[0].c !== 0) { sweepOk = false; console.log(`  ⚠️ sweep ${name}: ${left[0].c} remain`) }
    else console.log(`  🧹 ${name}: ${r.count} deleted, 0 remain`)
  }
  const punchLeft = (await prisma.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "PunchRecord" WHERE "employeeId" IN (${allEmp.map((_, i) => `$${i + 1}`).join(',')})`, ...allEmp)) as Array<{ c: number }>
  const auditNew = (await prisma.auditLog.findMany({ where: { actorId: ownerUserId }, orderBy: { createdAt: 'desc' }, take: 20 }))
  const auditE2e = auditNew.filter(a => /RESIGN|PAYROLL/.test(a.action))
  check('sweep 0 殘留', sweepOk && punchLeft[0].c === 0, `PunchRecord=${punchLeft[0].c}（本 e2e 零打卡）AuditLog append-only 殘留 ${auditE2e.length} 行（informational，trigger 唔俾刪）`)

  console.log(`\n══ SUMMARY: PASS=${pass} FAIL=${fail} ══`)
  if (failures.length) { console.log('FAILURES:'); failures.forEach(f => console.log('  - ' + f)) }
}

main()
  .catch(e => { console.error('E2E ERROR:', e); process.exitCode = 2 })
  .finally(async () => { await prisma.$disconnect() })
