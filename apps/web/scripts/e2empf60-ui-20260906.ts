/**
 * cwm-mpf60-20260906 — T6 UI 驗收（Playwright）：#21 #23 #24 #25 #26 #27 + #29 動態負測試
 *
 * 讀 /tmp/emp-mpf60-fixture.json（e2empf60 --phase1 建好；必須喺任何 run 生成之前跑）。
 * 打 dev server :3000（cookie = OWNER JWT）。
 *
 * 斷言：
 *  SEL  （+68 分）：#21 畫面折現行「0.13 日 × ADW +71.09」；#23 print 行同畫面一樣；
 *       #24 print 逐行加總 = 預估應付 $5,639.27；#27 print MPF 行 + 理由；
 *       #29 無「⛔ 逐行加總」console.error（負測試）
 *  DEBT （−540 分）：#25 只有扣除行（預填 564.52）、無折現行；print 同；est $5,003.66
 *  ZERO （0）：#26 兩行都唔出；print 無折現/扣除行；est $5,568.18
 *
 * Run: npx tsx scripts/e2empf60-ui-20260906.ts
 */
import fs from 'node:fs'
import { chromium } from '/usr/lib/node_modules/openclaw/node_modules/playwright-core'

const EXE = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`
const BASE = 'http://127.0.0.1:3000'

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(`${name} — ${detail}`); console.log(`  ❌ ${name} — ${detail}`) }
}
const money = (s: string) => s.replace(/[^0-9.-]/g, '')

async function main() {
  const fx = JSON.parse(fs.readFileSync('/tmp/emp-mpf60-fixture.json', 'utf8'))
  const lastDay = fx.lastDay // 2026-09-11

  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  await ctx.addCookies([{ name: 'session', value: fx.ownerToken, domain: '127.0.0.1', path: '/' }])
  const page = await ctx.newPage()

  const consoleErrors: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })

  /** 開員工 overview → 開離職結算 modal → set lastDay → 等數據載入 */
  async function openModal(empId: string, expectEst: RegExp) {
    await page.goto(`${BASE}/employees/${empId}/overview`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    let btn = page.getByRole('button', { name: '查看離職結算' })
    await btn.waitFor({ state: 'visible', timeout: 120000 })
    for (let i = 0; i < 3; i++) {
      await btn.click().catch(() => {})
      await page.waitForTimeout(800)
      if (await page.locator('text=預估應付').first().isVisible().catch(() => false)) break
    }
    const dateInput = page.locator('div.fixed.inset-0 input[type="date"]').first()
    await dateInput.waitFor({ state: 'visible', timeout: 30000 })
    await dateInput.fill(lastDay)
    await page.waitForTimeout(300)
    await dateInput.dispatchEvent('change').catch(() => {})
    // 等 estPayable 變成預期值（數據載入完成）
    await page.waitForFunction(
      (re: string) => document.body.innerText.match(new RegExp(re)),
      expectEst.source,
      { timeout: 90000 },
    ).catch(async () => { await page.waitForTimeout(15000) })
    await page.waitForTimeout(1500)
  }

  /** 攞 modal 畫面 + print DOM 嘅「項目 → 金額」行 */
  async function readRows() {
    return page.evaluate(() => {
      // 畫面：modal 內含「預估應付」個 fixed 遮罩
      const modals = [...document.querySelectorAll('div')].filter(d => d.className && /fixed inset-0/.test(d.className))
      const screen = modals.length > 0 ? modals[modals.length - 1].innerText : document.body.innerText
      // print DOM：位置 -9999 嘅隱藏 print 區域（離職結算書）
      const printDiv = [...document.querySelectorAll('div')].find(d => {
        const st = getComputedStyle(d)
        return st.position === 'fixed' && st.left === '-9999px' && d.innerText.includes('離職結算書')
      })
      const printText = printDiv ? printDiv.innerText : ''
      return { screen, printText, hasPrint: !!printDiv }
    })
  }

  // ═══ SEL：+68 分 → 折現行 + MPF $0 理由 + estPayable $5,639.27 ═══
  console.log('── SEL 畫面 + print DOM ──')
  await openModal(fx.selId, /\$5,639\.27/)
  let rows = await readRows()
  check('modal 載入（有 print DOM）', rows.hasPrint, 'print div 搵唔到')
  const selScreen = rows.screen
  check('#21 畫面折現行「時間帳戶折現（0.13 日 × ADW）」', selScreen.includes('時間帳戶折現（0.13 日 × ADW）'), `screen 片段=${JSON.stringify(selScreen.match(/時間帳戶[^\n]*/g))}`)
  check('#21 折現值 +71.09', selScreen.includes('+71.09'), `片段=${JSON.stringify(selScreen.match(/\+?71\.09/g))}`)
  check('#14 畫面 MPF 行 $0.00 + 理由「低於 $7,100」', selScreen.includes('強積金（僱員 5%）') && selScreen.includes('$0.00') && selScreen.includes('低於 $7,100'), `片段=${JSON.stringify(selScreen.match(/強積金[^\n]*|低於[^\n]*/g))}`)
  check('#15/#22 畫面 預估應付 $5,639.27', selScreen.includes('$5,639.27'), `est 片段=${JSON.stringify(selScreen.match(/預估應付[^\n]*\n\$[^\n]*/g))}`)

  // #23 print 行同畫面一樣
  check('#23 print 有折現行（0.13 日 × ADW）', rows.printText.includes('時間帳戶折現（0.13 日 × ADW）'), `print=${JSON.stringify(rows.printText.match(/時間帳戶[^\n]*/g))}`)
  check('#23 print 折現值 $71.09', printAmount(rows.printText, '時間帳戶折現') === '71.09', `got=${printAmount(rows.printText, '時間帳戶折現')}`)
  check('#23 print 當月工資 $5,568.18', printAmount(rows.printText, '當月工資') === '5,568.18', `got=${printAmount(rows.printText, '當月工資')}`)
  check('#23 print 年假薪酬 0', rows.printText.includes('年假薪酬') && p2(rows.printText, '年假薪酬') === 0, `got=${printAmount(rows.printText, '年假薪酬')}`)
  check('#23 print 代通知金 0（—）', rows.printText.includes('代通知金') && p2(rows.printText, '代通知金') === 0, `got=${printAmount(rows.printText, '代通知金')}`)
  // #27 print MPF 行 + 理由
  check('#27 print MPF 行 $0.00', printAmount(rows.printText, '強積金（僱員 5%）') === '0.00', `got=${printAmount(rows.printText, '強積金（僱員 5%）')}`)
  check('#27 print MPF 零理由行', rows.printText.includes('低於 $7,100'), `print 理由=${JSON.stringify(rows.printText.match(/有關入息[^\n]*/g))}`)
  // #24 print 逐行加總 = 預估應付
  const p = (l: string) => Number((printAmount(rows.printText, l) ?? '0').replace(',', ''))
  const printSum = r2f(p('當月工資') + p('年假薪酬') + p('代通知金') + p('時間帳戶折現') - p('強積金（僱員 5%）'))
  const printEst = p('預估應付')
  check('#24 print 逐行加總 = 預估應付 = $5,639.27', Math.abs(printSum - 5639.27) < 0.011 && Math.abs(printEst - 5639.27) < 0.011, `sum=${printSum} est=${printEst}`)
  check('#29 負測試：無「⛔ 逐行加總」console.error', !consoleErrors.some(e => e.includes('⛔ 逐行加總')), `errors=${JSON.stringify(consoleErrors.filter(e => e.includes('resign-settlement'))).slice(0, 300)}`)

  // ═══ DEBT：−540 分 → 只有扣除行、無折現行 ═══
  console.log('── DEBT 畫面 + print DOM ──')
  await openModal(fx.debtId, /\$5,003\.66/)
  rows = await readRows()
  const debtScreen = rows.screen
  check('#25 畫面欠款提示 540 分', debtScreen.includes('540'), `片段=${JSON.stringify(debtScreen.match(/時間帳戶[^\n]*/g))}`)
  check('#25 無折現行（畫面）', !debtScreen.includes('時間帳戶折現'), `片段=${JSON.stringify(debtScreen.match(/折現[^\n]*/g))}`)
  const debtInput = page.locator('text=本次扣除（預填，可改）').locator('xpath=following::input[1]')
  const debtPrefill = await debtInput.inputValue().catch(() => '')
  check('#25 扣除預填 = 564.52', debtPrefill === '564.52', `got=${debtPrefill}`)
  check('#25 畫面 預估應付 $5,003.66', debtScreen.includes('$5,003.66'), `片段=${JSON.stringify(debtScreen.match(/預估應付[^\n]*\n\$[^\n]*/g))}`)
  check('#25 print 無折現行', !rows.printText.includes('時間帳戶折現'), `print=${JSON.stringify(rows.printText.match(/折現[^\n]*/g))}`)
  check('#25 print 有扣除行 −564.52', printAmount(rows.printText, '時間帳戶欠款扣除') === '564.52', `got=${printAmount(rows.printText, '時間帳戶欠款扣除')}`)
  check('#25 print MPF $0.00 + 理由', printAmount(rows.printText, '強積金（僱員 5%）') === '0.00' && rows.printText.includes('低於 $7,100'), `mpf=${printAmount(rows.printText, '強積金（僱員 5%）')}`)
  const dSum = r2f(p2(rows.printText, '當月工資') + p2(rows.printText, '年假薪酬') + p2(rows.printText, '代通知金') - p2(rows.printText, '時間帳戶欠款扣除') - p2(rows.printText, '強積金（僱員 5%）'))
  check('#25 print 逐行加總 = 預估應付 = $5,003.66', Math.abs(dSum - 5003.66) < 0.011 && Math.abs(p2(rows.printText, '預估應付') - 5003.66) < 0.011, `sum=${dSum} est=${p2(rows.printText, '預估應付')}`)

  // ═══ ZERO：TB 0 → 兩行都唔出 ═══
  console.log('── ZERO 畫面 + print DOM ──')
  await openModal(fx.zeroId, /\$5,568\.18/)
  rows = await readRows()
  const zeroScreen = rows.screen
  check('#26 畫面無欠款提示', !zeroScreen.includes('時間帳戶欠'), `片段=${JSON.stringify(zeroScreen.match(/時間帳戶[^\n]*/g))}`)
  check('#26 畫面無折現行', !zeroScreen.includes('時間帳戶折現'), `片段=${JSON.stringify(zeroScreen.match(/折現[^\n]*/g))}`)
  check('#26 畫面 預估應付 $5,568.18', zeroScreen.includes('$5,568.18'), `片段=${JSON.stringify(zeroScreen.match(/預估應付[^\n]*\n\$[^\n]*/g))}`)
  check('#26 print 無折現行 + 無扣除行', !rows.printText.includes('時間帳戶折現') && !rows.printText.includes('時間帳戶欠款扣除'), `print=${JSON.stringify(rows.printText.match(/時間帳戶[^\n]*/g))}`)
  check('#26 print MPF 行照有（$0.00 + 理由）', printAmount(rows.printText, '強積金（僱員 5%）') === '0.00' && rows.printText.includes('低於 $7,100'), `mpf=${printAmount(rows.printText, '強積金（僱員 5%）')}`)
  const zSum = r2f(p2(rows.printText, '當月工資') + p2(rows.printText, '年假薪酬') + p2(rows.printText, '代通知金') - p2(rows.printText, '強積金（僱員 5%）'))
  check('#26 print 逐行加總 = 預估應付 = $5,568.18', Math.abs(zSum - 5568.18) < 0.011 && Math.abs(p2(rows.printText, '預估應付') - 5568.18) < 0.011, `sum=${zSum} est=${p2(rows.printText, '預估應付')}`)
  check('#29 負測試（全程）：無「⛔ 逐行加總」console.error', !consoleErrors.some(e => e.includes('⛔ 逐行加總')), `errors=${JSON.stringify(consoleErrors.filter(e => e.includes('resign-settlement'))).slice(0, 300)}`)

  await browser.close()
  console.log(`\n═══ UI RESULT: PASS=${pass} FAIL=${fail} ═══`)
  if (fails.length) { for (const f of fails) console.log(`  ✖ ${f}`) }
  process.exit(fail === 0 ? 0 : 1)
}

function r2f(x: number) { return Math.round(x * 100) / 100 }
/** print 文本抽 項目行金額：每行 = 「label\t金額」（金額可能有註解尾缀如（預覽值…）/ —） */
function printAmount(printText: string, label: string): string | null {
  const line = printText.split('\n').find(l => l.startsWith(label) || (l.includes(label) && l.includes('\t')))
  if (!line) return null
  const rest = line.includes('\t') ? line.slice(line.indexOf('\t') + 1) : line
  const m = rest.match(/(-?\$?)\s?([0-9][0-9,]*(?:\.[0-9]+)?)/)
  return m ? m[2] : null
}
function p2(printText: string, label: string): number {
  const v = printAmount(printText, label)
  if (v == null) return 0
  const m = v.replace(/,/g, '')
  return Number.isFinite(Number(m)) ? Number(m) : 0
}

main().catch(async (e) => { console.error('FATAL', e); process.exit(2) })
