/**
 * cwm-carryover-20260910 — T4 UI 驗收（Playwright）：四行版面 + 結轉 badge
 *
 * 讀 /tmp/kairo-carryover-fixture.json（e2ecarryover-20260910.ts --phase1 建好並保留數據）。
 * 打 dev server :3000（cookie = OWNER JWT，用 .env.local secret 簽 — dotenv 剷引號）。
 *
 * 斷言（MD §五 版面 + 拍板①②④⑤）：
 *   #15 第 3 行「年度區間 · 配額 N 天/年」
 *   #16 「配額」唔再出現喺第 1 行
 *   #17 「⚠️ 未滿一年」「· 試用期」仍然喺第 1 行
 *   #18 假期單行有單先出、次序最後
 *   #19 25 人表格唔會爆
 *   #1 kat：已放 4 / 可用 8.9 · 餘 4.9 ＋ badge「含上期結轉 7.9」＋ 算式行「上期結轉 7.9 ＋ 本年累積 1.0」
 *   #2/#13 cel：已放 8 / 可用 6.8 · 餘 −1.2（紅）＋ 已預支，算式行「本年累積 6.8」
 *   #12 joa：算式行「本年累積 2.3」（available，唔係 accruedThisYear 2.0）
 *   #8 suk：badge「含上期結轉 1.0」
 *   #6/#7 bdy/joa：carryOver ≤ 0.5 無 badge
 *   #14 prb：算式行「本年累積 0」＋ 試用期
 *
 * 截圖：badge（kat）/ 無 badge（joa）/ 負餘額（cel）/ 全表
 *
 * Run: npx tsx scripts/e2ecarryover-ui-20260910.ts
 */
import fs from 'node:fs'
import { chromium } from '/usr/lib/node_modules/openclaw/node_modules/playwright-core'

const EXE = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`
const BASE = 'http://127.0.0.1:3000'
const SHOTDIR = '/tmp/kairo-carryover-shots'

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(`${name} — ${detail}`); console.log(`  ❌ ${name} — ${detail}`) }
}

async function main() {
  fs.mkdirSync(SHOTDIR, { recursive: true })
  const fx = JSON.parse(fs.readFileSync('/tmp/kairo-carryover-fixture.json', 'utf8'))
  const { uiToken, clinicName, emps } = fx

  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } })
  await ctx.addCookies([{ name: 'session', value: uiToken, domain: '127.0.0.1', path: '/' }])
  const page = await ctx.newPage()
  const consoleErrors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

  // ── 開 /scheduling → 選 fixture 診所 → 月視圖 → 等假期總覽表
  await page.goto(`${BASE}/scheduling`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  const chip = page.locator('button', { hasText: clinicName }).first()
  await chip.waitFor({ state: 'visible', timeout: 120000 })
  for (let i = 0; i < 3; i++) {
    await chip.click().catch(() => {})
    await page.waitForTimeout(500)
    if (await page.locator('text=月視圖').first().isVisible().catch(() => false)) break
  }
  const monthBtn = page.locator('button', { hasText: '月視圖' }).first()
  await monthBtn.waitFor({ state: 'visible', timeout: 60000 })
  for (let i = 0; i < 3; i++) {
    await monthBtn.click().catch(() => {})
    await page.waitForTimeout(800)
  }
  const names = Object.values(emps as Record<string, any>).map(e => e.name)
  await page.waitForFunction(
    (ns: string[]) => {
      const t = [...document.querySelectorAll('table')].find(x => (x as HTMLElement).innerText.includes('年假（服務年度）'))
      if (!t) return false
      const txt = (t as HTMLElement).innerText
      return ns.every(n => txt.includes(n))
    },
    names,
    { timeout: 120000 },
  ).catch(async () => { await page.waitForTimeout(15000) })
  await page.waitForTimeout(1500)

  // ── 讀表（所有行一次過：最後一格 = 年假欄，拆成 lines）
  const data = await page.evaluate(() => {
    const t = [...document.querySelectorAll('table')].find(x => x.innerText.includes('年假（服務年度）'))
    if (!t) return { found: false, rows: [] as any[], headers: '' }
    const trs = [...t.querySelectorAll('tbody tr')] as HTMLElement[]
    const rows = trs.map(tr => {
      const tds = [...tr.querySelectorAll('td')] as HTMLElement[]
      const nameTd = tds[0]?.innerText ?? ''
      const leaveTd = tds[tds.length - 1]
      const divs = leaveTd ? [...leaveTd.querySelectorAll(':scope > div')] as HTMLElement[] : []
      const lines = divs.map(d => d.innerText.replace(/\n/g, '⏎'))
      // 第 1 行嘅 span 們（badge / 餘 顏色）
      const line1 = divs[0]
      const spans = line1 ? [...line1.querySelectorAll('span')] : []
      const restSpan = spans.find(sp => sp.innerText.startsWith('餘'))
      const restColor = restSpan ? getComputedStyle(restSpan).color : ''
      const badges = spans.map(sp => sp.innerText.trim()).filter(x => x && !x.startsWith('餘'))
      return {
        name: nameTd.trim(),
        lastMonthRest: tds[1]?.innerText.trim() ?? '',
        total: tds[2]?.innerText.trim() ?? '',
        restRemaining: tds[3]?.innerText.trim() ?? '',
        lines,
        line1: lines[0] ?? '',
        badges,
        restColor,
      }
    })
    return { found: true, rows, headers: (t.querySelector('thead') as HTMLElement)?.innerText ?? '' }
  })
  if (!data.found) throw new Error('搵唔到年假總覽表')
  console.log(`表格 row count = ${data.rows.length}`)
  const row = (k: string) => data.rows.find(r => r.name === (emps as any)[k].name)
  const E = (k: string) => (emps as any)[k]

  // ── #19 25 人表格
  check('#19 25 人全部喺表格（唔會爆）★★', data.rows.length === 25, `rows=${data.rows.length}`)

  // ── #16 第 1 行唔再出現「配額」（全部 25 人）
  const noQuotaL1 = data.rows.every(r => !r.line1.includes('配額'))
  check('#16 「配額」唔再出現喺第 1 行（25 人）★★★', noQuotaL1,
    data.rows.filter(r => r.line1.includes('配額')).map(r => r.name).join(','))

  // ── #15 第 3 行「年度區間 · 配額 N 天/年」（kat 逐字核對）
  {
    const r = row('kat')!
    const e = E('kat')
    check('#15 第 3 行 = 年度區間 · 配額 9 天/年（kat）★★★',
      r.lines[2] === `${e.syStart}～${e.syEnd} · 配額 ${e.entitled} 天/年`,
      `lines[2]=${r.lines[2]}`)
    check('第 3 行格式（全部 25 人有 配額 X 天/年）',
      data.rows.every(x => /· 配額 \d+ 天\/年$/.test(x.lines[2] ?? '')),
      data.rows.filter(x => !/· 配額 \d+ 天\/年$/.test(x.lines[2] ?? '')).map(x => x.name).join(','))
  }

  // ── #1 kat（Kathy 型）：第 1 行 + badge + 算式行 + 假期單行
  {
    const r = row('kat')!
    const e = E('kat')
    check('#1 kat 第 1 行「已放 4 / 可用 8.9 天 · 餘 4.9」★★★',
      r.line1.includes('已放 4 / 可用 8.9 天') && r.line1.includes('餘 4.9'),
      `line1=${r.line1}`)
    check('#5 kat badge「含上期結轉 7.9」★★★', r.badges.includes('含上期結轉 7.9'), `badges=${r.badges.join('|')}`)
    check('#10/#11 kat 算式行「上期結轉 7.9 ＋ 本年累積 1」＝ 可用 8.9 ★★★',
      r.lines[1] === `上期結轉 ${e.carryOver.toFixed(1)} ＋ 本年累積 ${Math.round((e.available - e.carryOver) * 10) / 10}`
        && Math.round((e.carryOver + Math.round((e.available - e.carryOver) * 10) / 10) * 10) === Math.round(e.available * 10),
      `lines[1]=${r.lines[1]}`)
    check('#18 kat 假期單行最後「本年度假期單：8/3–8/6」★★', r.lines[3] === '本年度假期單：8/3–8/6', `lines[3]=${r.lines[3]}`)
    check('kat 四行版面（4 div）', r.lines.length === 4, `lines=${r.lines.length}`)
  }

  // ── #2/#13 cel（Celia 型）：負餘額
  {
    const r = row('cel')!
    const e = E('cel')
    check('#2 cel 第 1 行「已放 8 / 可用 6.8 天 · 餘 −1.2」★★★',
      r.line1.includes('已放 8 / 可用 6.8 天') && r.line1.includes('餘 -1.2'),
      `line1=${r.line1}`)
    check('#2 cel 「已預支」badge + 餘紅色（rgb(220,38,38)）', r.badges.includes('已預支') && r.restColor === 'rgb(220, 38, 38)',
      `badges=${r.badges.join('|')} color=${r.restColor}`)
    check('#13 cel 算式行「本年累積 6.8」（= available，唔係 accruedThisYear 6.9）★★★',
      r.lines[1] === '本年累積 6.8', `lines[1]=${r.lines[1]} (accruedThisYear=${e.accruedThisYear})`)
    check('#6 cel 無結轉 badge（carryOver 0 ≤ 0.5）★★★', !r.badges.some(b => b.startsWith('含上期結轉')),
      `badges=${r.badges.join('|')}`)
    check('cel 三行版面（無假期單）', r.lines.length === 3, `lines=${r.lines.length}`)
  }

  // ── #12 joa（Joan 型）：0.1 rounding trap
  {
    const r = row('joa')!
    const e = E('joa')
    check('#12 joa 算式行「本年累積 2.3」（available 2.3，唔係 r1(accrued) 2.0）★★★',
      r.lines[1] === '本年累積 2.3' && Math.round((e.available - Math.round(e.accruedThisYear * 10) / 10) * 10) >= 1,
      `lines[1]=${r.lines[1]} available=${e.available} r1(accrued)=${Math.round(e.accruedThisYear * 10) / 10}`)
    check('#7 joa 無結轉 badge（0.3 ≤ 0.5）★★★', !r.badges.some(b => b.startsWith('含上期結轉')),
      `badges=${r.badges.join('|')}`)
  }

  // ── #8 suk（Suki 型）：badge 1.0
  {
    const r = row('suk')!
    const e = E('suk')
    check('#8 suk badge「含上期結轉 1.0」★★', r.badges.includes('含上期結轉 1.0'), `badges=${r.badges.join('|')} carryOver=${e.carryOver}`)
    check('#8 suk 算式行「上期結轉 1.0 ＋ 本年累積 6.7」', r.lines[1] === '上期結轉 1.0 ＋ 本年累積 6.7', `lines[1]=${r.lines[1]}`)
  }

  // ── 邊界：bdy/prb/b7 無 badge
  check('bdy carryOver 0.5 邊界：無 badge', !row('bdy')!.badges.some(b => b.startsWith('含上期結轉')),
    `badges=${row('bdy')!.badges.join('|')}`)
  check('b7 carryOver 0.5 邊界（試用期）：無 badge', !row('b7')!.badges.some(b => b.startsWith('含上期結轉')),
    `badges=${row('b7')!.badges.join('|')}`)
  {
    const r = row('prb')!
    check('#14 prb 算式行「本年累積 0」★★', r.lines[1] === '本年累積 0', `lines[1]=${r.lines[1]}`)
    check('#17 prb 第 1 行「⚠️ 未滿一年」+「· 試用期」★★',
      r.line1.includes('⚠️ 未滿一年') && r.line1.includes('· 試用期'), `line1=${r.line1}`)
  }
  {
    const r = row('unr')!
    check('#17 unr 第 1 行「⚠️ 未滿一年」（非試用期）★★',
      r.line1.includes('⚠️ 未滿一年') && !r.line1.includes('· 試用期'), `line1=${r.line1}`)
  }

  // ── #18 假期單行：有單先出
  {
    const withReq = ['kat', 'lst', 'b8', 'b9', 'b13']
    const noReq = ['cel', 'joa', 'suk']
    const ok = withReq.every(k => (row(k)!.lines[3] ?? '').startsWith('本年度假期單：'))
      && noReq.every(k => (row(k)!.lines[3] ?? '').startsWith('本年度假期單') === false)
    check('#18 假期單行有單先出（5 人有 / 3 人冇）★★', ok,
      JSON.stringify({ w: withReq.map(k => row(k)!.lines[3]), n: noReq.map(k => row(k)!.lines[3]) }))
  }

  // ── #22 上月剩 / total / 剩餘欄存在（25 人都有數）
  {
    const ok = data.rows.every(r => r.lastMonthRest !== '' && r.total !== '' && r.restRemaining !== '')
    check('#22 上月剩/total/剩餘欄 25 人都照有數 ★★★', ok,
      data.rows.filter(r => !r.lastMonthRest || !r.total || !r.restRemaining).map(r => r.name).join(','))
    const kat = row('kat')!
    console.log(`    kat 上月剩=${kat.lastMonthRest} total=${kat.total} 剩餘=${kat.restRemaining}`)
  }

  // ── 截圖
  const trLoc = (k: string) => page.locator('tbody tr', { hasText: (emps as any)[k].name }).first()
  await trLoc('kat').screenshot({ path: `${SHOTDIR}/badge-kat.png` })
  await trLoc('joa').screenshot({ path: `${SHOTDIR}/nbadge-joa.png` })
  await trLoc('cel').screenshot({ path: `${SHOTDIR}/negative-cel.png` })
  const tableEl = page.locator('table', { hasText: '年假（服務年度）' }).first()
  await tableEl.screenshot({ path: `${SHOTDIR}/full-table.png` })
  console.log(`截圖寫咗 ${SHOTDIR}/ {badge-kat,nbadge-joa,negative-cel,full-table}.png`)

  const realErrors = consoleErrors
    .filter(e => !e.includes('404') && !e.includes('favicon'))
    // 已知 pre-existing React dev warning（page.tsx:204 ScheduleRow key spread — 本單 diff 唔涉及）
    .filter(e => !e.includes('"key" prop is being spread into JSX'))
  check('page 無 console error（除已知 pre-existing warning）', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  console.log(`\nUI DONE: pass=${pass} fail=${fail}`)
  if (fail > 0) { console.log('FAILS:\n' + fails.join('\n')); process.exitCode = 1 }
  await browser.close()
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
