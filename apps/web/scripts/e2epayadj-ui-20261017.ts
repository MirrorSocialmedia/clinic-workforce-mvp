/**
 * cwm-payadj-20261017 ② — T4 瀏覽器 E2E（Playwright）：計糧調整（MD §2.7）
 *
 * MD §2.7 E2E 要求：計糧明細加兩行 → 數字同圖示一致 → 匯出 Excel 有兩欄 → 確認計糧後掣消失
 * 14,320.00 圖示例子喺 engine unit test 逐分驗證（Winkie 底薪 20,000 ≠ 15,000，
 * E2E 用 delta 口徑驗證同一機制：MPF 前 +500 → gross +500；MPF 後 −1,000 → net −1,000）。
 *
 * 流程（UI 登入 91000001，唔自簽 JWT）：
 *   1. 登入 → POST /api/payroll-runs 建 2026-10 單員工 DRAFT run（Winkie）
 *   2. 明細頁：加 +500（MPF 前，綠 pill）→ 加 −1,000（MPF 後，紅 pill）
 *      → 每行後 API 斷言 detail.adjPreMpf/adjPostMpf + gross/net delta 啱
 *   3. 改一行（1,000 → 500）→ 刪一行
 *   4. 匯出 Excel：公司 export cols 加返兩 key（同 UI 欄位揀選同一個 API）→ 下載 → unzip grep 兩欄 header
 *   5. 確認計糧（FINALIZED）→ 重載 → 「＋ 新增調整」掣消失
 *   6. cleanup：還 DRAFT → 刪調整行 → 刪 run → 還原公司 cols → 零殘留 assert
 *
 * Run（dev server 要起咗 :3014，DB 15532）:
 *   npx tsx scripts/e2epayadj-ui-20261017.ts
 */
import { chromium } from '/usr/lib/node_modules/openclaw/node_modules/playwright-core'
import { execSync } from 'node:child_process'
import fs from 'node:fs'

const EXE = `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3014'
const OWNER_PHONE = '91000001'
const OWNER_PASS = 'demo1234'
const CLINIC = 'e2et2cln00000000000000001'
const COMPANY = 'e2e26cmp0000000000000000001'
const WINKIE = 'e2e26emp00000000000000001'
const MONTH = '2026-10'

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
  let confirmPending = false
  page.on('dialog', async d => {
    if (d.type() === 'confirm' && confirmPending) { await d.accept(); confirmPending = false }
    else await d.dismiss()
  })
  const api = (path: string, init?: RequestInit) =>
    page.evaluate(async ([p, i]: [string, any]) => {
      const r = await fetch(p, { credentials: 'include', ...i })
      const t = await r.text()
      let j: any = null; try { j = JSON.parse(t) } catch { /* binary */ }
      return { status: r.status, body: j, text: j ? undefined : t.slice(0, 200) }
    }, [path, init])

  // ── 1. UI 登入
  console.log('== 1. UI 登入 91000001 ==')
  await page.goto(`${BASE}/login`, { waitUntil: 'load', timeout: 120000 })
  const phoneInput = page.locator('input[name="phone"]')
  const passInput = page.locator('input[name="password"]')
  await phoneInput.waitFor({ state: 'visible', timeout: 60000 })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1500)
  await phoneInput.fill(OWNER_PHONE)
  await passInput.fill(OWNER_PASS)
  await page.locator('button[type="submit"]').click()
  if (page.url().includes('/login?')) {
    check('UI 登入 91000001 → /dashboard', false, `native GET submit（hydration race）: ${page.url()}`)
    console.log('FAILS:\n' + fails.join('\n')); await browser.close(); process.exit(1)
  }
  try {
    await page.waitForURL('**/dashboard', { timeout: 60000 })
    check('UI 登入 91000001 → /dashboard', true)
  } catch {
    check('UI 登入 91000001 → /dashboard', false, `url=${page.url()}`)
    console.log('FAILS:\n' + fails.join('\n')); await browser.close(); process.exit(1)
  }

  // ── 2. 建 2026-10 單員工 DRAFT run（冪等：已有就重用 — 上次失敗嘅 E2E 可能留咗 run）
  console.log('== 2. 建／重用 2026-10 DRAFT run（Winkie）==')
  let runId: string | undefined
  const existing = await api(`/api/payroll-runs?clinicId=${CLINIC}&periodMonth=${MONTH}`)
  const exRun = (existing.body?.runs ?? existing.body?.data ?? []).find((r: any) => r.status === 'DRAFT')
  if (exRun?.id) {
    runId = exRun.id
    check('重用既有 2026-10 DRAFT run（冪等）', true, runId)
  } else {
    const created = await api(`/api/payroll-runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ periodMonth: MONTH, clinicId: CLINIC, employeeId: WINKIE }),
    })
    check('POST /api/payroll-runs 201', created.status === 201, JSON.stringify(created).slice(0, 200))
    runId = created.body?.run?.id ?? created.body?.runId ?? created.body?.id
    check('取得 runId', !!runId, JSON.stringify(created.body).slice(0, 200))
  }
  if (!runId) { console.log('FAILS:\n' + fails.join('\n')); await browser.close(); process.exit(1) }

  const getDetail = async () => {
    const g = await api(`/api/payroll-runs/${runId}`)
    const items = g.body?.run?.items ?? g.body?.items ?? []
    const item = items.find((x: any) => x.employeeId === WINKIE || x.employee?.id === WINKIE)
    return { g, item, d: item ? JSON.parse(item.detailJson ?? '{}') : null }
  }
  const { d: base } = await getDetail()
  check('baseline detail 有 grossPay/netPay', base && typeof base.grossPay === 'number' && typeof base.netPay === 'number',
    base ? `gross=${base.grossPay} net=${base.netPay}` : 'item 搵唔到')
  if (!base) { console.log('FAILS:\n' + fails.join('\n')); await browser.close(); process.exit(1) }

  // ── 3. 明細頁：加兩行（先冪等洗走舊行 — 上次 crash 可能留低）
  console.log('== 3. 明細頁加 +500（MPF 前）==')
  {
    const pre = await api(`/api/payroll-runs/${runId}/employee/${WINKIE}/adjustments`)
    for (const row of pre.body?.adjustments ?? []) {
      await api(`/api/payroll-runs/${runId}/employee/${WINKIE}/adjustments/${row.id}`, { method: 'DELETE' })
    }
    check('冪等預洗（舊行清零）', (await api(`/api/payroll-runs/${runId}/employee/${WINKIE}/adjustments`)).body?.adjustments?.length === 0)
  }
  await page.goto(`${BASE}/payroll/${runId}/employee/${WINKIE}`, { waitUntil: 'load', timeout: 120000 })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1000)
  const addBtn = page.getByRole('button', { name: '＋ 新增調整' })
  await addBtn.waitFor({ state: 'visible', timeout: 60000 })
  check('「＋ 新增調整」掣出現（DRAFT + OWNER）', true)

  const openModal = async (expectTitle: string) => {
    await page.getByRole('button', { name: '＋ 新增調整' }).click()
    const modal = page.locator('div', { hasText: expectTitle }).locator('h3', { hasText: expectTitle }).last()
    await modal.waitFor({ state: 'visible', timeout: 15000 })
  }

  // Row 1: +500 MPF 前
  await openModal('新增計糧調整')
  await page.locator('input[type="number"]').fill('500')
  await page.locator('input[type="text"]').fill('e2e payadj 前')
  // 預設：ADD → MPF 前（radio 已選）— 只斷言
  const preChecked = await page.locator('input[type="radio"]').first().isChecked()
  check('預設 radio = MPF 前（加）', preChecked)
  await page.getByRole('button', { name: '儲存' }).click()
  await page.waitForTimeout(2500)
  let adjCount = (await api(`/api/payroll-runs/${runId}/employee/${WINKIE}/adjustments`)).body?.adjustments?.length ?? -1
  let body = await page.locator('body').innerText()
  check('綠行「調整：e2e payadj 前」+「MPF 前」pill 出現', body.includes('調整：e2e payadj 前') && body.includes('MPF 前'))
  check(`「${adjCount} 行調整」出現（API 計數）`, adjCount === 1 && body.includes('1 行調整'))
  let { d } = await getDetail()
  check('detail.adjPreMpf = 500', d?.adjPreMpf === 500, JSON.stringify(d?.adjPreMpf))
  check('gross = baseline + 500（MPF 前入總薪酬）', d?.grossPay === Math.round((base.grossPay + 500) * 100) / 100, `got ${d?.grossPay} want ${base.grossPay + 500}`)

  console.log('== 4. 加 −1,000（MPF 後）==')
  await openModal('新增計糧調整')
  await page.getByRole('button', { name: '－ 減' }).click()
  await page.locator('input[type="number"]').fill('1000')
  await page.locator('input[type="text"]').fill('e2e payadj 後')
  const postChecked = await page.locator('input[type="radio"]').nth(1).isChecked()
  check('切「－ 減」→ 預設 radio 轉 MPF 後', postChecked)
  await page.getByRole('button', { name: '儲存' }).click()
  await page.waitForTimeout(2500)
  adjCount = (await api(`/api/payroll-runs/${runId}/employee/${WINKIE}/adjustments`)).body?.adjustments?.length ?? -1
  body = await page.locator('body').innerText()
  check('紅行「調整：e2e payadj 後」+「MPF 後」pill 出現', body.includes('調整：e2e payadj 後') && body.includes('MPF 後'))
  check(`「${adjCount} 行調整」出現（API 計數）`, adjCount === 2 && body.includes('2 行調整'))
  ;({ d } = await getDetail())
  check('detail.adjPostMpf = −1000', d?.adjPostMpf === -1000, JSON.stringify(d?.adjPostMpf))
  check('net = gross − mpf − 1000（MD 圖示機制：14,320 例子嘅 delta）',
    d?.netPay === Math.round((d.grossPay - d.mpf - 1000) * 100) / 100,
    `net=${d?.netPay} gross=${d?.grossPay} mpf=${d?.mpf}`)
  check('MPF 跟新 gross（前調整影響強積金）', d?.mpf === Math.round(Math.min(0.05, d.grossPay > 30000 ? 0.05 : 0.05) * Math.min(d.grossPay, 30000) * 100) / 100 || Math.abs(d.mpf - 0.05 * d.grossPay) < 0.02,
    `mpf=${d?.mpf} gross=${d?.grossPay}`)

  // ── 5. 改一行
  console.log('== 5. 改 POST 行 1,000 → 500 ==')
  await page.locator('div', { hasText: '調整：e2e payadj 後' }).last().click()
  await page.locator('h3', { hasText: '修改計糧調整' }).waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('input[type="number"]').fill('500')
  await page.getByRole('button', { name: '儲存' }).click()
  await page.waitForTimeout(2500)
  ;({ d } = await getDetail())
  check('改後 detail.adjPostMpf = −500', d?.adjPostMpf === -500, JSON.stringify(d?.adjPostMpf))

  // ── 6. 刪一行
  console.log('== 6. 刪 POST 行 ==')
  await page.locator('div', { hasText: '調整：e2e payadj 後' }).last().click()
  await page.locator('h3', { hasText: '修改計糧調整' }).waitFor({ state: 'visible', timeout: 15000 })
  confirmPending = true
  await page.getByRole('button', { name: '刪除呢行' }).click()
  await page.waitForTimeout(2500)
  adjCount = (await api(`/api/payroll-runs/${runId}/employee/${WINKIE}/adjustments`)).body?.adjustments?.length ?? -1
  body = await page.locator('body').innerText()
  check(`刪後「${adjCount} 行調整」`, adjCount === 1 && body.includes('1 行調整') && !body.includes('調整：e2e payadj 後'))
  ;({ d } = await getDetail())
  check('刪後 detail.adjPostMpf = 0', d?.adjPostMpf === 0, JSON.stringify(d?.adjPostMpf))

  // ── 7. 匯出 Excel 兩欄
  console.log('== 7. 匯出 Excel 有兩欄 ==')
  // GET /api/companies/[id] = 405 — 用 list 撈（同 UI 同一資料源）
  const cmpList = await api(`/api/companies`)
  const cmp = (cmpList.body ?? []).find((c: any) => c.id === COMPANY)
  const origCols: string[] = cmp?.payrollExportCols ? JSON.parse(cmp.payrollExportCols) : null
  if (Array.isArray(origCols) && !origCols.includes('adjPreMpf')) {
    const upd = await api(`/api/companies/${COMPANY}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: cmp?.name, payrollExportCols: [...origCols, 'adjPreMpf', 'adjPostMpf'] }),
    })
    check('公司 export cols 加兩 key（同 UI 欄位揀選同一 API）', upd.status === 200, JSON.stringify(upd).slice(0, 200))
  } else {
    check('公司 export cols 已含兩 key（或 NULL=預設）', true)
  }
  const ex = await page.evaluate(async (rid: string) => {
    const r = await fetch(`/api/payroll-runs/${rid}/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: 'xlsx' }),
    })
    if (!r.ok) return { status: r.status, err: (await r.text()).slice(0, 200) }
    const buf = await r.arrayBuffer()
    return { status: r.status, bytes: Array.from(new Uint8Array(buf)) }
  }, runId)
  check('匯出 xlsx 200', ex.status === 200, JSON.stringify(ex).slice(0, 200))
  if (ex.status === 200) {
    const xlsxPath = '/tmp/e2e-payadj-export.xlsx'
    fs.writeFileSync(xlsxPath, Buffer.from(ex.bytes))
    // ⚠️ 呢個 xlsx writer 用 inline string（sheet1.xml），未必有 sharedStrings.xml — 兩邊都搜
    const shared = execSync(`unzip -p ${xlsxPath} xl/sharedStrings.xml 2>/dev/null || true`).toString()
    const sheet = execSync(`unzip -p ${xlsxPath} xl/worksheets/sheet1.xml 2>/dev/null || true`).toString()
    const all = shared + sheet
    check('有「調整（MPF前）」欄 header', all.includes('調整（MPF前）'), sheet.slice(0, 120))
    check('有「調整（MPF後）」欄 header', all.includes('調整（MPF後）'))
    check('sheet 有 Winkie 嘅 500 調整值', all.includes('500'), '500 應該喺 cell')
  }
  if (Array.isArray(origCols)) {
    await api(`/api/companies/${COMPANY}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: cmp?.name, payrollExportCols: origCols }),
    })
  }

  // ── 8. 確認計糧 → 掣消失
  console.log('== 8. 確認計糧（FINALIZED）→ 「＋ 新增調整」消失 ==')
  const fin = await api(`/api/payroll-runs/${runId}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'FINALIZED' }),
  })
  check('PUT FINALIZED 200', fin.status === 200, JSON.stringify(fin).slice(0, 300))
  await page.reload({ waitUntil: 'load' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1500)
  body = await page.locator('body').innerText()
  check('FINALIZED 後「＋ 新增調整」掣消失', !body.includes('＋ 新增調整'))
  check('調整行照顯示（審計可睇）', body.includes('調整：e2e payadj 前'))

  // ── 9. cleanup
  console.log('== 9. cleanup（還 DRAFT（要原因）→ 刪行 → 刪 run）==')
  const rev = await api(`/api/payroll-runs/${runId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'DRAFT', reason: 'e2e payadj cleanup 還原草稿' }) })
  check('還 DRAFT（cleanup）', rev.status === 200, JSON.stringify(rev).slice(0, 200))
  const g = await api(`/api/payroll-runs/${runId}/employee/${WINKIE}/adjustments`)
  for (const row of g.body?.adjustments ?? []) {
    await api(`/api/payroll-runs/${runId}/employee/${WINKIE}/adjustments/${row.id}`, { method: 'DELETE' })
  }
  const delRun = await api(`/api/payroll-runs/${runId}`, { method: 'DELETE' })
  check('刪 run（cleanup）', delRun.status === 200, JSON.stringify(delRun).slice(0, 200))

  // 零殘留
  const res = await api(`/api/payroll-runs/${runId}`)
  check('run 已刪（404）', res.status === 404, `status=${res.status}`)

  await browser.close()
  console.log(`\n===== ${pass} pass / ${fail} fail =====`)
  if (fails.length) { console.log('FAILS:\n' + fails.join('\n')); process.exitCode = 1 }
}

main().catch(e => { console.error('E2E CRASH:', e); process.exit(2) })
