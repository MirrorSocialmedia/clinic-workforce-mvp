/**
 * cwm-caldayratio-20260906 — T5 UI 驗收（Playwright）：#12 受僱比例新文案 + 打卡 block 僅供參考 + MPF 行
 *
 * 讀 /tmp/emp-caldayratio-fixture.json（e2ecal 主跑建好，SEL 仍在職、preview lastDay=2026-09-10）。
 * 打 dev server :3000（cookie = OWNER JWT）。
 *
 * 斷言（SEL：9/1–9/10 受僱、月薪 $17,500、最後工作日 9/10）：
 *  #12 受僱比例行「受僱 10 日（含休息日）÷ 當月 30 日 = 33.3%」（舊：實際排更 10 日 ÷ 該月工作日 22 日）
 *  打卡 block 標明「僅供參考，唔影響計算」（保留做參考，MD §1.3）
 *  當月工資 $5,833.33（preview 直算）
 *  MPF 行 $291.67（5,833.33 × 5%；MIN pro-rate 2,366.67 → 過線要供 — 同 engine 一致）
 *  預估應付 $5,541.66（5,833.33 − 291.67）
 *
 * Run: npx tsx scripts/e2ecal-ui-20260906.ts
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
  const fx = JSON.parse(fs.readFileSync('/tmp/emp-caldayratio-fixture.json', 'utf8'))
  const lastDay: string = fx.lastDay

  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  await ctx.addCookies([{ name: 'session', value: fx.ownerToken, domain: '127.0.0.1', path: '/' }])
  const page = await ctx.newPage()

  // 預熱 resign-preview route（dev cold-compile）— 防 modal mount fetch（default lastDay=today）
  // 同 fill 後 fetch（9/10）回應 race：cold-compile 令舊值回應最尾到 → 覆蓋新值（實測中招）
  await fetch(`${BASE}/api/employees/${fx.selId}/resign-preview?lastDay=${lastDay}`, { headers: { cookie: `session=${fx.ownerToken}` } }).catch(() => {})
  await new Promise(r => setTimeout(r, 3000))

  // 開員工 overview → 開離職結算 modal → set lastDay → 等數據載入
  await page.goto(`${BASE}/employees/${fx.selId}/overview`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  const btn = page.getByRole('button', { name: '查看離職結算' })
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
  await page.waitForFunction(
    () => document.body.innerText.includes('$5,541.66'),
    undefined,
    { timeout: 60000 },
  ).catch(async () => { await page.waitForTimeout(5000) })
  // race 保險絲：若屏幕仍然係舊值（今日 default），toggle 日期強制重 fetch（最後一次 = lastDay，
  // route 已暖 → 回應依序到，舊值唔會覆蓋新值）
  if (!(await page.evaluate(() => document.body.innerText.includes('$5,541.66')))) {
    console.log('  ⚠️ 首次 fetch race（舊值覆蓋）— toggle 日期重試')
    await dateInput.fill('2026-09-09')
    await page.waitForTimeout(2500)
    await dateInput.fill(lastDay)
    await page.waitForTimeout(300)
    await dateInput.dispatchEvent('change').catch(() => {})
    await page.waitForFunction(
      () => document.body.innerText.includes('$5,541.66'),
      undefined,
      { timeout: 60000 },
    ).catch(async () => { await page.waitForTimeout(5000) })
  }
  await page.waitForTimeout(1500)

  const screen = await page.evaluate(() => {
    const modals = [...document.querySelectorAll('div')].filter(d => d.className && /fixed inset-0/.test(d.className))
    return modals.length > 0 ? modals[modals.length - 1].innerText : document.body.innerText
  })

  check('modal 載入（有預估應付）', screen.includes('預估應付'), `screen 長度=${screen.length}`)
  check('#12 受僱比例行「受僱 10 日（含休息日）÷ 當月 30 日」', screen.includes('受僱 10 日（含休息日）÷ 當月 30 日'), `片段=${JSON.stringify(screen.match(/受僱[^\n]*/g))}`)
  check('#12 比例 33.3%', screen.includes('33.3%'), `片段=${JSON.stringify(screen.match(/33\.3%|受僱[^\n]*/g))}`)
  check('舊文案「實際排更」已消失', !screen.includes('實際排更'), `片段=${JSON.stringify(screen.match(/實際排更[^\n]*/g))}`)
  check('打卡 block 標明「僅供參考，唔影響計算」', screen.includes('當月打卡記錄') && screen.includes('僅供參考，唔影響計算'), `片段=${JSON.stringify(screen.match(/當月打卡記錄[^\n]*/g))}`)
  check('打卡 2 日（fixture 有 9/1、9/2 打卡）', /當月打卡記錄[\s\S]{0,80}?2 日/.test(screen), `片段=${JSON.stringify(screen.match(/當月打卡記錄[^\n]*\n[^\n]*/g))}`)
  check('當月工資 $5,833.33（preview）', screen.includes('$5,833.33'), `片段=${JSON.stringify(screen.match(/當月工資[^\n]*\n\$[^\n]*/g))}`)
  check('MPF 行 $291.67（同 engine 一致）', screen.includes('強積金（僱員 5%）') && screen.includes('291.67'), `片段=${JSON.stringify(screen.match(/強積金[^\n]*\n[^\n]*/g))}`)
  check('無零理由（有關入息 > 按比例 MIN $2,366.67）', !screen.includes('低於'), `片段=${JSON.stringify(screen.match(/低於[^\n]*/g))}`)
  check('預估應付 $5,541.66', screen.includes('$5,541.66'), `片段=${JSON.stringify(screen.match(/預估應付[^\n]*\n\$[^\n]*/g))}`)

  await browser.close()
  console.log(`\n═══ UI RESULT: PASS=${pass} FAIL=${fail} ═══`)
  if (fails.length) { for (const f of fails) console.log(`  ✖ ${f}`) }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
