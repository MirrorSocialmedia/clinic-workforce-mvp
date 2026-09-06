/**
 * cwm-annualused-20260906 — T3 UI 驗收（Playwright）：年假「已放」方案 D
 *
 * 讀 /tmp/kairo-annualused-fixture.json（e2eannualused --phase1 建好並保留數據）。
 * 打 dev server :3000（cookie = OWNER JWT，用 .env.local secret 簽 — dotenv 剷引號）。
 *
 * 斷言（MD §六 關鍵顯示值 + #13 tooltip）：
 *  #1-4 luna/selina/horace/lettie：已放 0（試用期 gate）
 *  #5 kathy：已放 4 + 本年度假期單：8/24–8/27（floor）
 *  #6 celia：已放 8 / 配額 8 天 · 餘 -1.2（紅）＋「已預支」badge（#14 權威值）
 *  #7 mandy：已放 2 + 單 8/1–8/2
 *  #8 vera：已放 4
 *  #9 lily：已放 7 + 單 8/10–8/11
 *  #10 joan/jesscia/suki：已放 0
 *  #11 proll：已放 2（試用期 + 單 floor）+「· 試用期」
 *  #13 hover「已放」→ tooltip 列兩個來源 + 估算警告 ★★★
 *  #15 day1：已放 0 +「⚠️ 未滿一年」＋「· 試用期」
 *
 * Run: npx tsx scripts/e2eannualused-ui-20260906.ts
 */
import fs from 'node:fs'
import { chromium } from '/usr/lib/node_modules/openclaw/node_modules/playwright-core'

const EXE = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`
const BASE = 'http://127.0.0.1:3000'
const r1 = (n: number) => Math.round(n * 10) / 10

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(`${name} — ${detail}`); console.log(`  ❌ ${name} — ${detail}`) }
}

async function main() {
  const fx = JSON.parse(fs.readFileSync('/tmp/kairo-annualused-fixture.json', 'utf8'))
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
    if (!t) return { found: false, rows: [] as any[] }
    const trs = [...t.querySelectorAll('tbody tr')] as HTMLElement[]
    const rows = trs.map(tr => {
      const firstSpan = tr.querySelector('span[title]') as HTMLElement | null
      const annualTd = tr.querySelector('td[style*="border-left"]') as HTMLElement | null
      const balSpan = annualTd ? [...annualTd.querySelectorAll('span')].find(s => s.innerText.startsWith('餘 ')) as HTMLElement | null : null
      const badge = annualTd ? [...annualTd.querySelectorAll('span')].find(s => s.innerText.trim() === '已預支') : null
      return {
        text: tr.innerText,
        annualText: annualTd?.innerText ?? '',
        tooltip: firstSpan?.getAttribute('title') ?? null,
        balColor: balSpan ? getComputedStyle(balSpan).color : null,
        hasBadge: !!badge,
      }
    })
    return { found: true, rows }
  })
  check('假期總覽表載入（14 名 fixture 員工）', data.found && data.rows.length === Object.keys(emps).length,
    `found=${data.found} rows=${data.found ? data.rows.length : 0}`)
  if (!data.found) throw new Error('假期總覽表搵唔到')

  const rowOf = (k: string) => data.rows.find(r => r.text.startsWith(emps[k].name))

  // 截圖（畀 CEO 睇）
  const table = page.locator('table', { hasText: '年假（服務年度）' }).first()
  await table.scrollIntoViewIfNeeded().catch(() => {})
  await page.screenshot({ path: '/tmp/ceo-annualused-ui.png', fullPage: false }).catch(() => {})

  // ── #1-4 試用期四人：已放 0
  for (const k of ['luna', 'selina', 'horace', 'lettie'] as const) {
    const r = rowOf(k)!
    check(`#${k} ${k} 已放 0（試用期 gate）`, r.annualText.includes(`已放 0 / 配額`), `annual=${JSON.stringify(r.annualText)}`)
  }
  // ── #5 Kathy：floor 修正
  {
    const r = rowOf('kathy')!
    check('#5 kathy 已放 4（假期單 floor）★★★', r.annualText.includes('已放 4 / 配額'), `annual=${JSON.stringify(r.annualText)}`)
    check('#5 kathy 第 3 行：本年度假期單：8/24–8/27', r.annualText.includes('本年度假期單：8/24–8/27'), `annual=${JSON.stringify(r.annualText)}`)
  }
  // ── #6 Celia：負餘額 + 已預支（#14 權威值）
  {
    const r = rowOf('cel')!
    const e = emps.cel
    check('#6 celia 已放 8 / 配額 8 天 ★', r.annualText.includes('已放 8 / 配額 8 天'), `annual=${JSON.stringify(r.annualText)}`)
    check('#14 celia 餘 -1.2（權威值，未被「已放」影響）★★★', r.annualText.includes(`餘 ${r1(e.remainingDB)}`) && r1(e.remainingDB) < 0,
      `annual=${JSON.stringify(r.annualText)}`)
    check('#6 celia 有「已預支」badge', r.hasBadge, 'badge 搵唔到')
    check('#6 celia 餘額紅色 (#dc2626)', r.balColor === 'rgb(220, 38, 38)', `color=${r.balColor}`)
  }
  // ── #7 Mandy / #8 Vera / #9 Lily
  {
    const r = rowOf('mandy')!
    check('#7 mandy 已放 2（＝單 2 日）★★★', r.annualText.includes('已放 2 / 配額'), `annual=${JSON.stringify(r.annualText)}`)
    check('#7 mandy 單：8/1–8/2', r.annualText.includes('本年度假期單：8/1–8/2'), `annual=${JSON.stringify(r.annualText)}`)
  }
  check('#8 vera 已放 4（反推 ~4.05）★★★', rowOf('vera')!.annualText.includes('已放 4 / 配額'),
    `annual=${JSON.stringify(rowOf('vera')!.annualText)}`)
  {
    const r = rowOf('lily')!
    check('#9 lily 已放 7（反推贏單）★★★', r.annualText.includes('已放 7 / 配額'), `annual=${JSON.stringify(r.annualText)}`)
    check('#9 lily 單：8/10–8/11', r.annualText.includes('本年度假期單：8/10–8/11'), `annual=${JSON.stringify(r.annualText)}`)
  }
  // ── #10 Joan / Jesscia / Suki：0
  for (const k of ['joan', 'jesscia', 'suki'] as const) {
    check(`#10 ${k} 已放 0`, rowOf(k)!.annualText.includes('已放 0 / 配額'), `annual=${JSON.stringify(rowOf(k)!.annualText)}`)
  }
  // ── #11 試用期 + 單：floor 生效
  {
    const r = rowOf('proll')!
    check('#11 proll 已放 2（試用期 + 單 floor）★★★', r.annualText.includes('已放 2 / 配額'), `annual=${JSON.stringify(r.annualText)}`)
    check('#11 proll 單：8/20–8/21 + 「· 試用期」標記',
      r.annualText.includes('本年度假期單：8/20–8/21') && r.annualText.includes('· 試用期'),
      `annual=${JSON.stringify(r.annualText)}`)
  }
  // ── #15 day1
  {
    const r = rowOf('day1')!
    check('#15 day1 已放 0 +「⚠️ 未滿一年」＋「· 試用期」',
      r.annualText.includes('已放 0 / 配額') && r.annualText.includes('⚠️ 未滿一年') && r.annualText.includes('· 試用期'),
      `annual=${JSON.stringify(r.annualText)}`)
  }
  // ── 已放全部整數
  {
    const bad = Object.keys(emps).filter(k => !/已放 \d+ \/ 配額/.test(rowOf(k)!.annualText))
    check('已放全部整數（14 行）', bad.length === 0, bad.map(k => rowOf(k)!.annualText.split('\n')[0]).join(' | '))
  }
  // ── #13 tooltip 兩來源 ★★★
  {
    // celia：單 0 日 + 反推 ~8.4
    const e = emps.cel
    const r = rowOf('cel')!
    const t = r.tooltip ?? ''
    check('#13 tooltip 頭 = 「已放 = max(系統假期單, 由餘額反推)」★★★', t.startsWith('已放 = max(系統假期單, 由餘額反推)'), `title=${JSON.stringify(t)}`)
    check('#13 celia tooltip 列兩來源數值（單 0 日 / 反推算式）★★★',
      t.includes(`系統假期單：${r1(e.takenDays)} 日`) &&
      t.includes(`反推值：當年已累積 ${r1(e.accrued)} − 餘額 ${r1(e.remainingDB)} = ${r1(e.derived)}`),
      `title=${JSON.stringify(t)}`)
    check('#13 tooltip 估算警告（初始化資料冇逐張假期單）★★★',
      t.includes('⚠️ 初始化資料冇逐張假期單，數學上無法還原「當年已放」，此為估算'),
      `title=${JSON.stringify(t)}`)
    // kathy：單 4 日 + 反推 0（floor case 兩來源都要出）
    const ek = emps.kathy
    const tk = rowOf('kathy')!.tooltip ?? ''
    check('#13 kathy tooltip（floor case）：單 4 日 + 反推 0',
      tk.includes(`系統假期單：${r1(ek.takenDays)} 日`) && tk.includes(`= ${r1(ek.derived)}`),
      `title=${JSON.stringify(tk)}`)
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
