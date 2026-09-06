/**
 * cwm-excessrest-20260907 — T4 UI 驗收（Playwright）：結算卡 + PDF 重排
 *
 * 讀 /tmp/emp-excessrest-fixture.json（主跑建好；Luna：lastDay 9/9、TB +294、RESTDAY_GRANT 8 日）。
 * 打 dev server :3000（cookie = OWNER JWT）。dev server 要先 warm（先 fetch preview 預熱 route）。
 *
 * 斷言：
 *  ⑤ 行存在（超額休息日扣款 3.6 日 × 月薪÷30，−$1,680.00，副註 實放 6 − 應得 2.4（8 × 9/30））
 *  預填 input = 1680.00（拍板①）
 *  ④ 折現 +$245.88 行喺 ⑤ 之前
 *  #25 有關入息（MPF 基數）小計行 = $2,765.88（喺 ⑤ 之後、MPF 之前）
 *  MPF 行 −$138.29（卡片口徑）；預估應付 $2,627.59
 *  #24 PDF（printRef）同畫面一致：逐行加總（4200 + 0 + 0 + 245.88 − 1680 − 138.29）= 2627.59 = 預估應付
 *  截圖 /tmp/e2erx-card.png + /tmp/e2erx-pdf.png
 *
 * Run: npx tsx scripts/e2eexcessrest-ui-20260907.ts
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
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

async function main() {
  const fx = JSON.parse(fs.readFileSync('/tmp/emp-excessrest-fixture.json', 'utf8'))
  const lastDay: string = fx.lastDay

  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  await ctx.addCookies([{ name: 'session', value: fx.ownerToken, domain: '127.0.0.1', path: '/' }])
  const page = await ctx.newPage()

  // 預熱 resign-preview route（dev cold-compile）— 防 modal mount fetch 回應 race（e2cal 實測中招）
  await fetch(`${BASE}/api/employees/${fx.lunaId}/resign-preview?lastDay=${lastDay}`, { headers: { cookie: `session=${fx.ownerToken}` } }).catch(() => {})
  await new Promise(r => setTimeout(r, 3000))

  await page.goto(`${BASE}/employees/${fx.lunaId}/overview`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  const btn = page.getByRole('button', { name: '查看離職結算' })
  await btn.waitFor({ state: 'visible', timeout: 120000 })
  for (let i = 0; i < 3; i++) {
    await btn.click().catch(() => {})
    await page.waitForTimeout(800)
    if (await page.locator('text=預估應付').first().isVisible().catch(() => false)) break
  }
  const dateInput = page.locator('div.fixed.inset-0 input[type="date"]').first()
  await dateInput.waitFor({ state: 'visible', timeout: 30000 })
  const estStr = `$${money(2627.59)}`
  await dateInput.fill(lastDay)
  await page.waitForTimeout(300)
  await dateInput.dispatchEvent('change').catch(() => {})
  await page.waitForFunction(
    s => document.body.innerText.includes(s),
    estStr,
    { timeout: 60000 },
  ).catch(async () => { await page.waitForTimeout(5000) })
  // race 保險絲（e2cal 同款）
  if (!(await page.evaluate(s => document.body.innerText.includes(s), estStr))) {
    console.log('  ⚠️ 首次 fetch race（舊值覆蓋）— toggle 日期重試')
    await dateInput.fill('2026-09-08')
    await page.waitForTimeout(2500)
    await dateInput.fill(lastDay)
    await page.waitForTimeout(300)
    await dateInput.dispatchEvent('change').catch(() => {})
    await page.waitForFunction(
      s => document.body.innerText.includes(s),
      estStr,
      { timeout: 60000 },
    ).catch(async () => { await page.waitForTimeout(5000) })
  }
  await page.waitForTimeout(1500)

  const screen = await page.evaluate(() => {
    const modals = [...document.querySelectorAll('div')].filter(d => d.className && /fixed inset-0/.test(d.className))
    return modals.length > 0 ? modals[modals.length - 1].innerText : document.body.innerText
  })

  check('modal 載入（有預估應付）', screen.includes('預估應付'), `screen 長度=${screen.length}`)

  // ⑤ 行 + 副註
  check('⑤ 行存在：超額休息日扣款（3.6 日 × 月薪÷30）−1,680.00',
    /超額休息日扣款（3\.6 日 × 月薪÷30）/.test(screen) && screen.includes('−1,680.00'),
    `片段=${JSON.stringify(screen.match(/超額休息日[^\n]*/g))}`)
  check('⑤ 副註：實放 6 日 − 按比例應得 2.4 日（8 × 9/30）',
    screen.includes('實放 6 日 − 按比例應得 2.4 日（8 × 9/30）'),
    `片段=${JSON.stringify(screen.match(/實放[^\n]*/g))}`)

  // ④ 折現行（喺 ⑤ 之前）
  check('④ 折現行 +245.88（294 分 = 0.54 日 × ADW）', screen.includes('時間帳戶折現（0.54 日 × ADW）') && screen.includes('+245.88'), `片段=${JSON.stringify(screen.match(/時間帳戶折現[^\n]*/g))}`)

  // 順序：④ < ⑤ < 有關入息 < MPF
  const iCash = screen.indexOf('時間帳戶折現')
  const iExcess = screen.indexOf('超額休息日扣款')
  const iRel = screen.indexOf('有關入息（MPF 基數）')
  const iMpf = screen.indexOf('強積金（僱員 5%）')
  check('順序：④ 折現 < ⑤ 扣款 < 有關入息 < MPF', iCash > -1 && iCash < iExcess && iExcess < iRel && iRel < iMpf,
    `index ④=${iCash} ⑤=${iExcess} 有關入息=${iRel} MPF=${iMpf}`)

  // #25 有關入息小計行
  check('#25 有關入息（MPF 基數）小計行 = $2,765.88', iRel > -1 && screen.includes(`$${money(2765.88)}`), `screen 片段=${JSON.stringify(screen.match(/有關入息[^\n]*\n\$[^\n]*/g))}`)

  // MPF + 實發（卡片口徑）
  check('MPF 行 −138.29（卡片：2,765.88 × 5%）', screen.includes('強積金（僱員 5%）') && screen.includes('−138.29'), `片段=${JSON.stringify(screen.match(/強積金[^\n]*\n[^\n]*/g))}`)
  check('預估應付 $2,627.59（卡片實發）', screen.includes(`$${money(2627.59)}`), `片段=${JSON.stringify(screen.match(/預估應付[^\n]*\n\$[^\n]*/g))}`)

  // ⑤ 預填 input（拍板①：value = 1680.00）
  const inputs = page.locator('div.fixed.inset-0 input[type="number"]')
  const nInputs = await inputs.count()
  let prefill = ''
  for (let i = 0; i < nInputs; i++) prefill = await inputs.nth(i).inputValue().catch(() => '') || prefill
  check('⑤ 預填 input = 1680.00（拍板① 預填計算值，可改）', nInputs >= 1 && prefill === '1680.00', `inputs=${nInputs} value=${prefill}`)

  // #24 PDF（printRef）：同畫面一致 + 逐行加總 = 實發
  const pdf = await page.evaluate(() => {
    // printRef = 個 hidden fixed div（left -9999），入面張 table
    const divs = [...document.querySelectorAll('div')]
    const p = divs.find(d => { const s = (d as HTMLElement).style; return s && s.left === '-9999px' && d.querySelector('table') })
    if (!p) return null
    const rows = [...p.querySelectorAll('tr')].map(tr => {
      const tds = [...tr.querySelectorAll('td,th')].map(td => td.innerText.trim())
      return tds
    }).filter(r => r.length >= 2)
    return rows
  })
  check('#24 PDF（printRef）存在 + 有資料行', !!pdf && pdf.length >= 7, `rows=${pdf?.length}`)
  if (pdf) {
    const rowRaw = (label: string) => { const r = pdf.find(r => r[0].startsWith(label)); return r ? r[1] : null }
    const rowVal = (label: string): number | null => {
      const raw = rowRaw(label)
      if (raw == null) return null
      const m = raw.match(/[\d,]+(?:\.\d+)?/)
      if (!m) return null // '—'（無通知期）
      let n = Number(m[0].replace(/,/g, ''))
      if (raw.includes('−')) n = -n // ★ Unicode 減號（唔係 ASCII hyphen）
      return n
    }
    const base = rowVal('當月工資')
    const al = rowVal('年假薪酬')
    const noticeRaw = rowRaw('代通知金')
    const notice = rowVal('代通知金')
    const cash = rowVal('時間帳戶折現')
    const excess = rowVal('超額休息日扣款')
    const rel = rowVal('有關入息')
    const mpf = rowVal('強積金')
    const est = rowVal('預估應付')
    check('#24 PDF 行齊（當月/年假/通知/折現/⑤/有關入息/MPF/實發）',
      [base, al, noticeRaw, cash, excess, rel, mpf, est].every(v => v != null),
      `vals=${JSON.stringify({ base, al, noticeRaw, notice, cash, excess, rel, mpf, est })}`)
    if ([base, al, noticeRaw, cash, excess, rel, mpf, est].every(v => v != null)) {
      const sum = base! + (al ?? 0) + (notice ?? 0) + cash! + excess! + mpf! // 有關入息係小計 — 唔入加總
      check('#24 PDF 逐行加總 = 實發（4200+0+0+245.88−1680−138.29 = 2627.59）', Math.abs(sum - est!) < 0.011 && Math.abs(sum - 2627.59) < 0.011, `sum=${sum} est=${est}`)
      check('#24 PDF 有關入息 = 2,765.88；⑤ = −1,680.00；MPF = −138.29；折現 = +245.88',
        Math.abs(rel! - 2765.88) < 0.011 && Math.abs(excess! + 1680) < 0.011 && Math.abs(mpf! + 138.29) < 0.011 && Math.abs(cash! - 245.88) < 0.011,
        `rel=${rel} excess=${excess} mpf=${mpf} cash=${cash}`)
    }
  }

  // 截圖（卡片 + PDF）
  await page.screenshot({ path: '/tmp/e2erx-card.png' })
  const pdfEl = page.locator('div[style*="-9999"]').first()
  await pdfEl.screenshot({ path: '/tmp/e2erx-pdf.png' }).catch(e => console.log('  ⚠️ PDF 截圖失敗（hidden）', e.message?.slice(0, 80)))

  await browser.close()
  console.log(`\n═══ UI RESULT: PASS=${pass} FAIL=${fail} ═══`)
  if (fails.length) { for (const f of fails) console.log(`  ✖ ${f}`) }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
