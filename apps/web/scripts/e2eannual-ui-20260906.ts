/**
 * cwm-annualdisp-20260906 — T4 UI 驗收（Playwright）：年假顯示理順
 *
 * 讀 /tmp/kairo-annualdisp-fixture.json（e2eannual --phase1 建好並保留數據）。
 * 打 dev server :3000（cookie = OWNER JWT，用 .env.local secret 簽 — dotenv 剷引號）。
 *
 * 斷言（MD §4.3 版面 + 拍板）：
 *  #1 cel：已放 8 / 配額 8 天 · 餘 -1.2（紅）＋「已預支」badge ★
 *  #2 joa：已放 0 / 配額 7 天 · 餘 6（綠）、無 badge
 *  #3 tooltip 講明係反推（title 含算式）
 *  #4 zer：餘 0、無「已預支」
 *  #6 已放整數；#7 餘一位小數
 *  #13 兩行結構（無單 = 2 行；lst 有單 = 3 行）★
 *  #14 「本年度假期單」有單先出
 *  #15 「⚠️ 未滿一年」/「· 試用期」保留第 1 行
 *
 * Run: npx tsx scripts/e2eannual-ui-20260906.ts
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

async function main() {
  const fx = JSON.parse(fs.readFileSync('/tmp/kairo-annualdisp-fixture.json', 'utf8'))
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
  // 等假期總覽表載齊（dev 首次 compile 慢）
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

  // ── 讀表（所有行一次過）
  const data = await page.evaluate(() => {
    const t = [...document.querySelectorAll('table')].find(x => x.innerText.includes('年假（服務年度）'))
    if (!t) return { found: false, rows: [] as any[], headers: '' }
    const trs = [...t.querySelectorAll('tbody tr')] as HTMLElement[]
    const rows = trs.map(tr => {
      const firstSpan = tr.querySelector('span[title]') as HTMLElement | null
      const cells = [...tr.querySelectorAll('td')].map(td => td.innerText)
      // 年假欄（最後一格）
      const annualTd = tr.querySelector('td[style*="border-left"]') as HTMLElement | null
      const balSpan = annualTd ? [...annualTd.querySelectorAll('span')].find(s => s.innerText.startsWith('餘 ')) as HTMLElement | null : null
      const badge = annualTd ? [...annualTd.querySelectorAll('span')].find(s => s.innerText.trim() === '已預支') : null
      return {
        text: tr.innerText,
        lines: tr.innerText.split('\n'),
        annualText: annualTd?.innerText ?? '',
        tooltip: firstSpan?.getAttribute('title') ?? null,
        balColor: balSpan ? getComputedStyle(balSpan).color : null,
        hasBadge: !!badge,
      }
    })
    return { found: true, rows, headers: t.querySelector('thead')?.innerText ?? '' }
  })
  check('假期總覽表載入（6 名 fixture 員工）', data.found && data.rows.length === Object.keys(emps).length,
    `found=${data.found} rows=${data.found ? data.rows.length : 0}`)
  if (!data.found) throw new Error('假期總覽表搵唔到')

  const rowOf = (k: string) => data.rows.find(r => r.text.startsWith(emps[k].name))
  // ★ tr.innerText line 0 = 前面 4 個數字格（tab 拼）；年假欄嘅 div 行 = lines.slice(1)
  const A = (k: string) => rowOf(k)!.lines.slice(1)
  const r1 = (n: number) => Math.round(n * 10) / 10

  // 截圖（畀 CEO 睇）
  const table = page.locator('table', { hasText: '年假（服務年度）' }).first()
  await table.scrollIntoViewIfNeeded().catch(() => {})
  await page.screenshot({ path: '/tmp/ceo-annualdisp-ui.png', fullPage: false }).catch(() => {})

  // ── #1 Celia 型（負餘額）
  {
    const r = rowOf('cel')!
    const e = emps.cel
    const expBal = r1(e.remainingDB)
    check('#1 cel 已放 8 / 配額 8 天 ★', r.annualText.includes(`已放 ${e.usedDisplay} / 配額 ${e.entitled} 天`), `annual=${JSON.stringify(r.annualText)}`)
    check('#1 cel 餘 -1.2（權威值，負）', r.annualText.includes(`餘 ${expBal}`) && expBal < 0, `annual=${JSON.stringify(r.annualText)} exp=${expBal}`)
    check('#1 cel 有「已預支」badge', r.hasBadge, 'badge 搵唔到')
    check('#1 cel 餘額紅色 (#dc2626)', r.balColor === 'rgb(220, 38, 38)', `color=${r.balColor}`)
  }
  // ── #2 Joan 型（正餘額，無 badge）
  {
    const r = rowOf('joa')!
    const e = emps.joa
    const expBal = r1(e.remainingDB)
    check('#2 joa 已放 0 / 配額 7 天 ★', r.annualText.includes(`已放 0 / 配額 ${e.entitled} 天`), `annual=${JSON.stringify(r.annualText)}`)
    check('#2 joa 餘 = 權威值（正）', r.annualText.includes(`餘 ${expBal}`), `annual=${JSON.stringify(r.annualText)} exp=${expBal}`)
    check('#2 joa 無「已預支」badge', !r.hasBadge, 'badge 應該唔出')
    check('#2 joa 餘額綠色 (#059669)', r.balColor === 'rgb(5, 150, 105)', `color=${r.balColor}`)
  }
  // ── #3 tooltip 講明係反推
  {
    const r = rowOf('cel')!
    const e = emps.cel
    check('#3 tooltip 頭 = 「由餘額反推（假設上年度無結轉）」', (r.tooltip ?? '').startsWith('由餘額反推（假設上年度無結轉）'), `title=${JSON.stringify(r.tooltip)}`)
    // ★ API accruedThisYear = r1（一位小數）→ tooltip 跟 API 值
    check('#3 tooltip 列算式（已累積 − 餘額 = 已放）',
      (r.tooltip ?? '').includes(`當年已累積 ${r1(e.accrued)} − 餘額 ${r1(e.remainingDB)} = ${e.usedDisplay}`),
      `title=${JSON.stringify(r.tooltip)}`)
  }
  // ── #4 餘額 = 0 無 badge
  {
    const r = rowOf('zer')!
    check('#4 zer 餘 0、無「已預支」★', r.annualText.includes('餘 0') && !r.hasBadge, `annual=${JSON.stringify(r.annualText)} badge=${r.hasBadge}`)
  }
  // ── #6 已放整數（全部）
  {
    const bad = Object.keys(emps).filter(k => !new RegExp(`已放 \\d+ / 配額`).test(rowOf(k)!.annualText))
    check('#6 已放全部整數', bad.length === 0, bad.map(k => rowOf(k)!.annualText.split('\n')[0]).join(' | '))
  }
  // ── #7 餘一位小數（只睇第 1 行，避免日期行拼埋造成假 2 位小數）
  {
    const bad = Object.keys(emps).filter(k => {
      const l1 = A(k)[0].replace(/\s+/g, '')
      return !/餘-?\d+(\.\d)?/.test(l1) || /餘-?\d+\.\d{2,}/.test(l1)
    })
    check('#7 餘最多位一位小數', bad.length === 0, bad.map(k => A(k)[0]).join(' | '))
  }
  // ── #13 兩行結構 ★（年假欄：無單 = 2 div 行；有單 = 3 div 行）
  {
    const noReq = ['cel', 'joa', 'zer', 'day1', 'neg']
    const okNoReq = noReq.every(k => A(k).length === 2 && !rowOf(k)!.text.includes('本年度假期單'))
    check('#13 無單 = 兩行（5 人）★', okNoReq, noReq.map(k => `${k}:${A(k).length}行`).join(' '))
    const lst = rowOf('lst')!
    check('#13 lst 有單 = 三行', A('lst').length === 3, `lines=${JSON.stringify(lst.lines)}`)
  }
  // ── #14 有單先出
  {
    check('#14 lst 第 3 行 = 本年度假期單：8/10–8/11', rowOf('lst')!.text.includes('本年度假期單：8/10–8/11'), `text=${JSON.stringify(rowOf('lst')!.text)}`)
    const leak = ['cel', 'joa', 'zer', 'day1', 'neg'].filter(k => rowOf(k)!.text.includes('本年度假期單'))
    check('#14 其餘 5 行無「本年度假期單」', leak.length === 0, leak.join(','))
  }
  // ── #15 未滿一年 / 試用期保留第 1 行
  {
    const d1 = A('day1')[0]
    check('#15 day1 有「⚠️ 未滿一年」＋「· 試用期」（第 1 行）',
      d1.includes('⚠️ 未滿一年') && d1.includes('· 試用期'), `line1=${JSON.stringify(d1)}`)
    const joa1 = A('joa')[0]
    check('#15 joa 有「⚠️ 未滿一年」（10 個月）但無試用期',
      joa1.includes('⚠️ 未滿一年') && !joa1.includes('試用期'), `line1=${JSON.stringify(joa1)}`)
    const okOld = ['cel', 'zer', 'lst'].every(k => !A(k)[0].includes('未滿一年'))
    check('#15 長服務員工無「未滿一年」', okOld, ['cel', 'zer', 'lst'].map(k => A(k)[0]).join(' | '))
  }

  // ★ pre-existing dev-only React warning（month grid 嘅 key spread，同本單無關）— 唔計 fail
  const realErrors = consoleErrors.filter(e => !e.includes('props object containing a "key" prop'))
  check('無 console.error（除 pre-existing key-spread warning）', realErrors.length === 0, realErrors.slice(0, 3).join(' | ').slice(0, 300))

  await browser.close()
}

main()
  .catch(e => { console.error('💥 UI e2e crash:', e); process.exitCode = 2 })
  .finally(() => {
    if (fail > 0) {
      console.log(`\n❌ ${fail} FAILED:\n${fails.map(f => '  - ' + f).join('\n')}`)
      process.exitCode = 1
    } else {
      console.log(`\n✅ ALL ${pass} CHECKS PASSED（UI）`)
    }
  })
