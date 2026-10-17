/**
 * cwm-tbmanual-20261017 ① — T4 瀏覽器 E2E（Playwright）：時間帳戶手動調整
 *
 * MD §1.7 要求：UI 登入 owner 91000001（唔好自簽 JWT）→ 全流程真實點擊。
 *
 * 流程：
 *   1. /login 91000001 / demo1234 → /dashboard
 *   2. /leave「✏️ 手動調整時間帳戶」卡（只限 OWNER 先見到 = 角色斷言）
 *      - 揀 Winkie（e2e fixture 員工、月薪、2026-10 未鎖）
 *      - 加 9 小時 0 分、2026-10、原因 'e2e tbmanual'
 *      - 即時預覽「而家 X → X+540」
 *      - 提交 → 409 CONFIRM_REQUIRED → 確認 modal「超過 8 小時」→ 確定
 *      - ✅ 結果 + balance 正確
 *   3. /employees/<id>/overview
 *      - 操作記錄：「手動時間帳戶調整」+540「+9 小時 0 分：e2e tbmanual」
 *      - 時間帳戶帳本 2026-10 展開 → 「手動調整」行有「撤銷」細掣（OWNER only）
 *      - 撳撤銷 → prompt 填原因 → 成功
 *      - 該行變「（已撤銷）」、balance 還原
 *   4. 淨效果零：+540 / −540 一對 linked rows（撤銷唔係刪除，按設計留低）
 *
 * Run（dev server 要起咗 :3013，DB 15532）:
 *   npx tsx scripts/e2etbmanual-ui-20261017.ts
 */
import { chromium } from '/usr/lib/node_modules/openclaw/node_modules/playwright-core'

const EXE = `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3013'
const OWNER_PHONE = '91000001'
const OWNER_PASS = 'demo1234'
const EMP_ID = 'e2e26emp00000000000000001' // Winkie（既有 e2e fixture、月薪）
const EMP_NAME = 'Winkie'
const MONTH = '2026-10'
const REASON = 'e2e tbmanual'
const MINUTES = 540 // 9 小時 → 觸發 >480 確認框

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`) }
}

async function main() {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } })
  const page = await ctx.newPage()
  page.on('dialog', async d => {
    console.log(`  [dialog ${d.type()}] ${d.message().slice(0, 60)}`)
    await d.accept('e2e 撤銷')
  })

  // ── 1. UI 登入（91000001，唔係自簽 JWT）
  console.log('== 1. UI 登入 91000001 ==')
  await page.goto(`${BASE}/login`, { waitUntil: 'load', timeout: 120000 })
  const phoneInput = page.locator('input[name="phone"]')
  const passInput = page.locator('input[name="password"]')
  await phoneInput.waitFor({ state: 'visible', timeout: 60000 })
  // ★ hydration race 防衛：React 未 hydrate 時 click submit → native GET submit（URL 帶 query param）
  //   networkidle + 固定延遲先 fill／click（dev server warm 後 hydration 幾百 ms）
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1500)
  await phoneInput.fill(OWNER_PHONE)
  await passInput.fill(OWNER_PASS)
  await page.locator('button[type="submit"]').click()
  // 三種結果：/dashboard（成功）／/login?query（native GET = hydration race）／錯誤 banner
  const urlNow = page.url()
  if (urlNow.includes('/login?')) {
    check('UI 登入 91000001 → /dashboard', false, `native GET submit（hydration race）: ${urlNow}`)
  } else {
    try {
      await page.waitForURL('**/dashboard', { timeout: 60000 })
      check('UI 登入 91000001 → /dashboard', true)
    } catch {
      const errTxt = await page.locator('div', { hasText: '登入失敗' }).first().innerText().catch(() => '')
      check('UI 登入 91000001 → /dashboard', false, `url=${page.url()} err=${errTxt}`)
    }
  }
  if (fails.length > 0) { console.log('FAILS:\n' + fails.join('\n')); process.exitCode = 1; await browser.close(); return }

  // ── 2. /leave 手動調整卡
  console.log('== 2. /leave 手動調整卡 ==')
  await page.goto(`${BASE}/leave`, { waitUntil: 'load', timeout: 120000 })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1000)
  const card = page.locator('section', { hasText: '✏️ 手動調整時間帳戶' }).first()
  await card.waitFor({ state: 'visible', timeout: 120000 })
  check('「✏️ 手動調整時間帳戶」卡出現（91000001 = OWNER 先見到）', true)

  // 揀 Winkie
  const sel = card.locator('select').first()
  await sel.selectOption(EMP_ID)
  check('揀到 Winkie', (await sel.inputValue()) === EMP_ID)
  // 加 9h 0m
  // 小時欄（無 max）同分鐘欄（max=59）：順序 = DOM 順序
  const numInputs = card.locator('input[type="number"]')
  await numInputs.nth(0).fill('9')   // 小時
  await numInputs.nth(1).fill('0')   // 分鐘
  // 月份（input type=month）
  await card.locator('input[type="month"]').fill(MONTH)
  // 原因
  await card.locator('input[type="text"]').fill(REASON)

  // 即時預覽
  await page.waitForFunction(
    (m: string) => document.body.innerText.includes(`調整後`) && document.body.innerText.includes(m),
    '調整後',
    { timeout: 60000 },
  ).catch(() => {})
  const cardText1 = await card.innerText()
  check('即時預覽出現（而家 X → 調整後 X+540）', /而家 -?\d+ 分鐘 → 調整後 -?\d+ 分鐘/.test(cardText1), cardText1.slice(0, 200))

  // 記下預覽嘅「而家」值（balance before）
  const mBefore = cardText1.match(/而家 (-?\d+) 分鐘 → 調整後 (-?\d+) 分鐘/)
  const balBefore = mBefore ? parseInt(mBefore[1], 10) : null
  const balAfter = mBefore ? parseInt(mBefore[2], 10) : null
  if (balBefore != null && balAfter != null) {
    check('預覽 delta = +540', balAfter - balBefore === MINUTES, `before=${balBefore} after=${balAfter}`)
  } else {
    check('預覽 delta = +540', false, `cardText=${cardText1.slice(0, 200)}`)
  }

  // 提交 → 確認 modal
  await card.locator('button', { hasText: '記入' }).click()
  const modal = page.locator('div', { hasText: '⚠️ 確認大額調整' }).last()
  await modal.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
  check('>8 小時確認 modal 出現', await modal.isVisible().catch(() => false))
  // 「確定」掣：page-level 定位（modal 內文字 div 都會 match hasText → 唔好用 .last() 鎖範圍）
  await page.locator('button', { hasText: /^確定$/ }).first().click()

  // ✅ 結果
  await page.waitForFunction(
    () => document.body.innerText.includes('已記'),
    undefined,
    { timeout: 60000 },
  )
  const cardText2 = await card.innerText()
  const mOk = cardText2.match(/已記 (-?\d+) → (-?\d+) 分鐘（\+540）/)
  check('✅ 已記 X → X+540 分鐘（+540）', !!mOk, cardText2.slice(0, 300))

  // ── 3. 員工總覽：操作記錄 + 帳本撤銷
  console.log('== 3. 員工總覽 ==')
  await page.goto(`${BASE}/employees/${EMP_ID}/overview`, { waitUntil: 'load', timeout: 120000 })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1000)
  await page.waitForFunction(
    (r: string) => document.body.innerText.includes('手動調整時間帳戶') && document.body.innerText.includes(r),
    REASON,
    { timeout: 120000 },
  )
  const bodyTxt = await page.evaluate(() => document.body.innerText)
  check('操作記錄有「手動調整時間帳戶」+ 詳情『+9 小時 0 分：e2e tbmanual』',
    bodyTxt.includes('手動調整時間帳戶') && bodyTxt.includes(`+9 小時 0 分：${REASON}`))
  check('操作記錄 delta 欄 = +9 小時', bodyTxt.includes('+9 小時'))

  // 帳本：展開 2026-10 月（月份行格式 = 「▼ 2026-10」）
  const monthRow = page.locator('tr', { hasText: /^[▼▲]\s*2026-10/ }).first()
  await monthRow.waitFor({ state: 'visible', timeout: 60000 })
  await monthRow.click()
  // 行：第 2 td 精确 = 「手動調整」，第 3 td = '+540'（ledger label 冇附分鐘文字）
  const adjRow = page.locator('tr', { has: page.locator('td', { hasText: /^手動調整$/ }) }).filter({ has: page.locator('td', { hasText: '+540' }) }).first()
  await adjRow.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
  check('帳本 2026-10 展開有「手動調整」+540 行', await adjRow.isVisible().catch(() => false))

  // 撤銷細掣（該行右邊）
  const revBtn = adjRow.locator('button', { hasText: '撤銷' }).first()
  check('MANUAL_ADJUST 行有「撤銷」細掣（OWNER 視角）', await revBtn.isVisible().catch(() => false))
  await revBtn.click()
  // dialog handler 已 accept 咗 prompt（原因 'e2e 撤銷'）
  const revRow = page.locator('tr', { has: page.locator('td', { hasText: /^撤銷手動調整$/ }) }).filter({ has: page.locator('td', { hasText: '-540' }) }).first()
  await revRow.waitFor({ state: 'visible', timeout: 60000 }).catch(() => {})
  const bodyTxt3 = await page.evaluate(() => document.body.innerText)
  check('帳本出現撤銷行（撤銷手動調整 / −540）', await revRow.isVisible().catch(() => false), bodyTxt3.slice(0, 100))
  check('原本行標「（已撤銷）」', bodyTxt3.includes('手動調整（已撤銷）'))

  // 操作記錄多咗一行「撤銷手動調整時間帳戶」
  await page.waitForFunction(
    () => document.body.innerText.includes('撤銷手動調整時間帳戶'),
    undefined,
    { timeout: 30000 },
  ).catch(() => {})
  const bodyTxt4 = await page.evaluate(() => document.body.innerText)
  check('操作記錄有「撤銷手動調整時間帳戶」', bodyTxt4.includes('撤銷手動調整時間帳戶'))

  // balance 還原：preview API（用瀏覽器 session cookie）
  const prev = await page.evaluate(async ({ eid, m }) => {
    const r = await fetch(`/api/timebank/manual-adjust/preview?employeeId=${eid}&month=${m}`, { credentials: 'include' })
    return r.ok ? await r.json() : null
  }, { eid: EMP_ID, m: MONTH })
  check('balance 還原（preview == 調整前）', prev != null && balBefore != null && prev.balance === balBefore,
    `prev=${JSON.stringify(prev)} balBefore=${balBefore}`)

  console.log(`\nE2E DONE: pass=${pass} fail=${fail}`)
  if (fail > 0) { console.log('FAILS:\n' + fails.join('\n')); process.exitCode = 1 }
  await browser.close()
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
