#!/usr/bin/env node
// ★ E2E 2 acceptance driver（spec §15.4）— cwm-labdoc P3（T11/T19/T20 + 月結單全流程）
// 前置：bash scripts/e2e-labdoc-p3-seed.sh（冪等 seed）+ /tmp/openclaw-e2e-users.env（OWNER_TOKEN/EMP_TOKEN）
//     + /tmp/openclaw-e2e-sodental-statement-2026-09{,-v2}.pdf（fixture PDF）+ 3007 CWM dev + 3105 W（真 LLM）
// 跑：node scripts/e2e-labdoc-p3-e2e2.mjs
// openclaw-e2e2-driver.mjs — cwm-labdoc P3 E2E 2（spec §15.4 第 2 項）＋ T11／T19／T20 實跑
// 真 LLM（3105 W 實例 → 30000 Qwen3.8-27B-FP8），CWM dev 3007，DB cwm_labdoc_p3。
import fs from 'node:fs'

const BASE = 'http://127.0.0.1:3007'
const env = Object.fromEntries(
  fs.readFileSync('/tmp/openclaw-e2e-users.env', 'utf8').split('\n').filter(Boolean)
    .map((l) => l.split('=').map((s, i) => (i === 0 ? s : s)))
    .filter(([k]) => k && !k.includes(' ')),
)
const TOKEN = env.OWNER_TOKEN
const EMP_TOKEN = env.EMP_TOKEN
const LAB_ID = 'e2ep3lab0000000000000001'
const CLINIC_ID = 'e2ep3clin00000000000001'
const PROV = { tong: 'e2ep3prov00000000000001', yiu: 'e2ep3prov00000000000002', ho: 'e2ep3prov00000000000003' }
const PDF_V1 = '/tmp/openclaw-e2e-sodental-statement-2026-09.pdf'
const PDF_V2 = '/tmp/openclaw-e2e-sodental-statement-2026-09-v2.pdf'

let pass = 0, fail = 0
const log = (tag, msg) => console.log(`[${tag}] ${msg}`)
const ok = (cond, msg) => { if (cond) { pass++; log('PASS', msg) } else { fail++; log('FAIL', msg) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, path, { token = TOKEN, body, form } = {}) {
  const headers = { Cookie: `session=${token}` }
  let payload
  if (form) payload = form
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' })
  const ct = res.headers.get('content-type') || ''
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* csv/text */ }
  return { status: res.status, json, text, ct }
}
let _upn = 0
async function upload(token, pdfPath, extra = {}) {
  if (!extra.idempotencyKey) extra = { ...extra, idempotencyKey: `e2e2-${++_upn}-${Date.now()}` }
  const form = new FormData()
  form.append('files', new Blob([fs.readFileSync(pdfPath)], { type: 'application/pdf' }), 'sodental-statement-2026-09.pdf')
  form.append('kind', 'STATEMENT')
  form.append('labId', LAB_ID)
  form.append('statementMonth', '2026-09')
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  const res = await fetch(BASE + '/api/lab-docs/upload', { method: 'POST', headers: { Cookie: `session=${token}` }, body: form })
  const text = await res.text()
  let json = null; try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}
async function getDoc(docId) {
  const r = await api('GET', `/api/lab-docs/${docId}`)
  if (r.status !== 200) return null
  const d = r.json?.document ?? r.json
  return { ...d, sections: r.json?.sections ?? d.sections, lines: r.json?.lines ?? d.lines, pages: r.json?.pages ?? d.pages }
}
async function waitExtract(docId, timeoutMs = 300000) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    const doc = await getDoc(docId)
    if (!doc) { await sleep(4000); continue }
    last = doc
    const st = doc.status
    // extraction done = no longer UPLOADED/EXTRACTING and we have sections (or terminal failure)
    if (st === 'EXTRACT_FAILED') return doc
    if (!['UPLOADED', 'EXTRACTING'].includes(st) && (doc.sections?.length ?? 0) > 0) return doc
    await sleep(4000)
  }
  throw new Error(`waitExtract timeout — last status=${last?.status} err=${last?.extractError}`)
}
const sectionsOf = (doc) => doc.sections ?? []
const linesOf = (doc, sid) => sectionsOf(doc).find((s) => s.id === sid)?.lines ?? []

// ════════════════════════════ PHASE 1: upload + 真 LLM extract ════════════════════════════
log('STEP', 'P1 上傳 v1（真 LLM 讀單）…')
const up1 = await upload(TOKEN, PDF_V1)
ok(up1.status === 201 || up1.status === 200, `upload v1 → ${up1.status} ${up1.text.slice(0, 120)}`)
const docV1 = up1.json?.documents?.[0]?.id ?? up1.json?.id ?? up1.json?.documentId ?? up1.json?.document?.id
ok(!!docV1, `docV1 id=${docV1}`)

const d1 = await waitExtract(docV1)
ok(d1.status !== 'EXTRACT_FAILED', `extract done status=${d1.status} err=${d1.extractError ?? 'null'}`)
if (d1.status === 'EXTRACT_FAILED') { log('ABORT', 'extract failed — dump'); console.log(JSON.stringify(d1, null, 2).slice(0, 3000)); process.exit(1) }
const secs1 = sectionsOf(d1)
ok(secs1.length === 3, `3 段（得 ${secs1.length}）`)
const secNames = secs1.map((s) => `${s.providerId ?? 'UNASSIGNED'}:${s.clinicId ?? 'NOCLINIC'}`).join(',')
log('INFO', `sections: ${secNames}`)
ok(secs1.every((s) => s.clinicId === CLINIC_ID), '全部段 clinic=CUSTOMER_NO 命中')
const secTong = secs1.find((s) => s.providerId === PROV.tong)
const secYiu = secs1.find((s) => s.providerId === PROV.yiu)
const secHo = secs1.find((s) => s.providerId === PROV.ho)
ok(!!secTong && !!secYiu && !!secHo, '3 段 provider 識別（Tong/Yiu/Ho）')

// ════════════════════════════ PHASE 2: reconcile（三型匹配）════════════════════════
for (const [name, s] of [['Tong', secTong], ['Yiu', secYiu], ['Ho', secHo]]) {
  if (!s) continue
  const r = await api('POST', `/api/lab-docs/${docV1}/sections/${s.id}/reconcile`, { body: {} })
  ok(r.status === 200, `reconcile ${name} → ${r.status} ${r.text.slice(0, 150)}`)
}
const d2 = await getDoc(docV1)
const tongLines = linesOf(d2, secTong.id)
const qd = tongLines.find((l) => l.result === 'QTY_DIFF')
ok(!!qd, `Tong 段有 QTY_DIFF（${tongLines.map((l) => l.result).join(',') }）`)
ok(tongLines.some((l) => l.result === 'MATCHED'), 'Tong 段有 MATCHED')
ok(Math.abs(Number(secTong && d2.sections.find((s) => s.id === secTong.id).statedTotal) - 1810) < 0.01, `Tong statedTotal=1810（得 ${d2.sections.find((s) => s.id === secTong.id).statedTotal}）`)
const yiuSt = d2.sections.find((s) => s.id === secYiu.id)
const hoSt = d2.sections.find((s) => s.id === secHo.id)
ok(yiuSt.status === 'OK' && hoSt.status === 'OK', `Yiu/Ho 段 OK（${yiuSt.status}/${hoSt.status}）`)

// ════════════════════════════ PHASE 3: QTY_DIFF → INVOICE_WINS ════════════════════════════
const note = '月結單數量正確，系統 invoice 多打一次'
const rs = await api('POST', `/api/lab-docs/${docV1}/sections/${secTong.id}/lines/${qd.id}/resolve`, { body: { resolution: 'INVOICE_WINS', note } })
ok(rs.status === 200, `resolve INVOICE_WINS → ${rs.status} ${rs.text.slice(0, 150)}`)
const pend = await api('GET', '/api/lab-docs/pending?category=STATEMENT_DIFF')
ok(pend.status === 200, `pending STATEMENT_DIFF → ${pend.status}`)
const items = pend.json?.categories?.find((c) => c.key === 'STATEMENT_DIFF')?.items ?? pend.json?.items ?? []
ok(items.some((i) => i.id === qd.id && /跟進/.test(i.extra ?? '')), `待處理見到 INVOICE_WINS 跟進（items=${items.length}）`)

// ════════════════════════════ PHASE 4: confirm 三段 → RECONCILED ════════════════════════════
for (const [name, s] of [['Tong', secTong], ['Yiu', secYiu], ['Ho', secHo]]) {
  const r = await api('POST', `/api/lab-docs/${docV1}/sections/${s.id}/confirm`, { body: {} })
  ok(r.status === 200, `confirm ${name} → ${r.status} ${r.text.slice(0, 150)}`)
}
const d3 = await getDoc(docV1)
ok(d3.status === 'RECONCILED', `文件 RECONCILED（得 ${d3.status}）`)

// ════════════════════════════ PHASE 5: T19 — 重複擋 + supersede ════════════════════════════
log('STEP', 'T19a 同檔重傳（sha256 重複）…')
const upDup = await upload(TOKEN, PDF_V1)
ok(upDup.status === 409 || upDup.json?.error === 'DUPLICATE' || /DUPLICATE|重複/i.test(upDup.text), `同檔重傳 → ${upDup.status} ${upDup.text.slice(0, 120)}`)

log('STEP', 'T19b 新版 v2（改 Yiu 段 950→960）上傳…')
const up2 = await upload(TOKEN, PDF_V2)
ok(up2.status === 201 || up2.status === 200, `upload v2 → ${up2.status} ${up2.text.slice(0, 120)}`)
const docV2 = up2.json?.documents?.[0]?.id ?? up2.json?.id ?? up2.json?.documentId ?? up2.json?.document?.id
const d4 = await waitExtract(docV2)
ok(d4.status !== 'EXTRACT_FAILED', `v2 extract done（${d4.status}）`)
const dupFlag = (d4.readIssues ?? []).some((x) => /DUP|重複/i.test(x)) || sectionsOf(d4).some((s) => s.status === 'DUPLICATE' || s.duplicationFlag === true)
log('INFO', `v2 readIssues=${JSON.stringify(d4.readIssues)} sections=${sectionsOf(d4).map((s) => s.status).join(',')}`)
ok(dupFlag, 'v2 分段重複擋（同 Lab+診所+醫生+月）')

log('STEP', 'T19c v2 supersede v1…')
const v2doc = await getDoc(docV2)
const sup = await api('POST', `/api/lab-docs/${docV2}/supersede`, { body: { oldDocumentId: docV1, reason: 'E2E 重跑 — 修正 Yiu 段金額', version: v2doc.version } })
ok(sup.status === 200, `supersede → ${sup.status} ${sup.text.slice(0, 150)}`)
const v1After = await getDoc(docV1)
ok(v1After.status === 'SUPERSEDED' && v1After.supersededById === docV2, `v1 SUPERSEDED（${v1After.status} → ${v1After.supersededById}）`)
ok(sectionsOf(v1After).length > 0, 'v1 舊分段結果保留')

// ════════════════════════════ PHASE 6: T11 — lab_invoice 用戶 403 ════════════════════════════
const qdLine2 = (linesOf(await getDoc(docV2), sectionsOf(d4).find((s) => s.providerId === PROV.tong)?.id) ?? [])
  .find((l) => l.result === 'QTY_DIFF')
const targetLine = qdLine2 ?? qd
const targetSid = qdLine2 ? sectionsOf(d4).find((s) => s.providerId === PROV.tong).id : secTong.id
const r403a = await api('POST', `/api/lab-docs/${docV2}/sections/${targetSid}/lines/${targetLine.id}/resolve`, { token: EMP_TOKEN, body: { resolution: 'INVOICE_WINS', note: 'T11' } })
ok(r403a.status === 403, `T11 resolve（lab_invoice only）→ ${r403a.status}`)
const r403b = await api('POST', `/api/lab-docs/${docV2}/sections/${targetSid}/confirm`, { token: EMP_TOKEN, body: {} })
ok(r403b.status === 403, `T11 confirm → ${r403b.status}`)
const r403c = await api('POST', `/api/lab-docs/${docV2}/supersede`, { token: EMP_TOKEN, body: { oldDocumentId: docV1, reason: 'T11', version: 0 } })
ok(r403c.status === 403, `T11 supersede → ${r403c.status}`)

// ════════════════════════════ PHASE 7: T20 — CSV 公式注入守衛（live）════════════════════════
log('STEP', 'T20 CSV 匯出…')
// ★ 穩化（gen3 修）：① regex `/' =cmd/` 多咗空格 — guard 實際產 `'=cmd`（無空格），舊式永恆 fail；
//   ② bounded wait 等 escape 後形態入 CSV（≤20s）— guard 回歸（未 escape）就永遠等唔到 → 照樣 FAIL，唔係改弱斷言
let csv = await api('GET', '/api/lab-docs/pending?category=STATEMENT_DIFF&format=csv')
for (let i = 0; i < 10 && !/'=cmd/.test(csv.text ?? ''); i++) {
  await sleep(2000)
  csv = await api('GET', '/api/lab-docs/pending?category=STATEMENT_DIFF&format=csv')
}
ok(csv.status === 200, `CSV → ${csv.status} (${(csv.text ?? '').length} bytes)`)
ok(/=cmd/.test(csv.text ?? ''), 'CSV 含 =cmd 數據（raw INSERT 行）')
ok(/'=cmd/.test(csv.text ?? ''), 'CSV 開頭 = 嘅 cell 已加 \'（=cmd → \'=cmd，防公式注入）')
const csvEmp = await api('GET', '/api/lab-docs/pending?category=STATEMENT_DIFF&format=csv', { token: EMP_TOKEN })
ok(csvEmp.status === 403, `T20 CSV 權限（lab_invoice only）→ ${csvEmp.status}`)

console.log(`\n════════ E2E RESULT: ${pass} PASS / ${fail} FAIL ════════`)
process.exit(fail ? 1 : 0)
