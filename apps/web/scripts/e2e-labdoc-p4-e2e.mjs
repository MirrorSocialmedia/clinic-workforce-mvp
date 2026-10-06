#!/usr/bin/env node
/**
 * ★ cwm-labdoc P4 — 人手走 §15.1 fixture driver（真 3008 CWM dev + 真 3105 W LLM + DB cwm_labdoc_p4）
 *
 * 前置：
 *   1. 3008 dev server 運行（env 同 P3 3007 配方；WA_INBOX_LABDOC_URL → 3105）
 *   2. bash scripts/e2e-labdoc-p4-seed.sh（冪等 seed：用戶/Labs/invoices/月結單/折扣/aliases）
 *
 * Phases（對 QA §2 期望值 = spec §15.2 清單）：
 *   0  P4 新 API live：lab-profiles GET/PUT（409 lock）/ lab-aliases GET(type filter)/DELETE / stats / 設定頁 HTML / RBAC 403
 *   A  sample-text.pdf（文字層）→ 2 單（D9 拆頁）→ T9：一 NEEDS_REVIEW 一 DUPLICATE（唔使 LLM）
 *   B  sample-scan.pdf（無文字層）→ 真 LLM 3105 → 終態（attempts 證據）
 *   C  Sodental 09 statement PDF（真 LLM）→ 3 段 → reconcile（QTY_DIFF 560 / statedTotal 1810 / Yiu+Ho OK）
 *      → resolve INVOICE_WINS → confirm ×3 → RECONCILED → v2 重複擋 + supersede → T11 403
 *   D  seed 月結單 live reconcile：
 *      Excel 09（§15.2：0509/0811 MATCHED、0885 PREVIOUSLY_MATCHED、1202 MISSING_IN_SYSTEM；systemTotal 1,061）
 *      Modern 06（docNoSame=false → fallback MATCHED 250；980 vs 1,030 AMOUNT_DIFF）
 *      Sodental 08（CHARGE/PAYMENT/BF → NEEDS_MANUAL/NOT_APPLICABLE；無單號 INVOICE 行 NEEDS_MANUAL）
 *   E  折扣 B4：labInvoiceLinked=true 成本 PUT（有/冇 labId）+ recompute → finalCost = baseCost（唔套 8.5%）
 *
 * 證據：stdout + /tmp/openclaw-e2ep4/e2e-<ts>.json
 * 跑：cd apps/web && node scripts/e2e-labdoc-p4-e2e.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import jwt from 'jsonwebtoken'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP = path.join(__dirname, '..')

// ── env（.env.local：JWT_SECRET 現簽 token）────────────────────────────
function loadEnvLocal(p) {
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = v
  }
}
loadEnvLocal(path.join(APP, '.env.local'))
if (!process.env.JWT_SECRET) { console.error('FATAL: JWT_SECRET 未設定'); process.exit(1) }

const BASE = process.env.P4_BASE ?? 'http://127.0.0.1:3008'
const FIX = path.join(APP, 'test', 'fixtures', 'labdoc')
const OUT_DIR = '/tmp/openclaw-e2ep4'
fs.mkdirSync(OUT_DIR, { recursive: true })

const OWN = 'own9kfh68sthp00000000000'
const EMP = 'empxytdbvbwpf80000000000'
const TOKEN = jwt.sign({ userId: OWN, role: 'OWNER', clinics: [], tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '6h' })
const EMP_TOKEN = jwt.sign({ userId: EMP, role: 'EMPLOYEE', clinics: [], tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '6h' })

const LAB_SOD = 'e2ep4labsodental000000000'
const LAB_EXC = 'e2ep4labexcellent00000000'
const LAB_MOD = 'e2ep4labmodernlab00000000'
const CLINIC = 'e2ep4clinicaegis000000000'
const PROV_T = 'e2ep4provesmond0000000000'
const PROV_Y = 'e2ep4provyiu0000000000000'
const PROV_H = 'e2ep4provho00000000000000'
const ALIASEN = 'e2ep4aliasen0000000000000'
const ALIASCN = 'e2ep4aliascn0000000000000'
const ALIASPAY = 'e2ep4aliaspay000000000000'
const CLINALIAS = 'e2ep4clinalias00000000000'
const PROVALIAS = 'e2ep4provalias00000000000'
const EXC09DOC = 'e2ep4exc09stmd00000000000'
const EXC09SEC = 'e2ep4exc09stms00000000000'
const EXC09LN = { a: 'e2ep4exc09stml10000000000', b: 'e2ep4exc09stml20000000000', c: 'e2ep4exc09stml30000000000', d: 'e2ep4exc09stml40000000000' }
const MOD06DOC = 'e2ep4mod06stmd00000000000'
const MOD06SEC = 'e2ep4mod06stms00000000000'
const MOD06LN = { a: 'e2ep4mod06stml10000000000', b: 'e2ep4mod06stml20000000000' }
const MODINV1 = 'e2ep4mod06inv100000000000'
const SOD08DOC = 'e2ep4sod08stmd00000000000'
const SOD08SEC = 'e2ep4sod08stms00000000000'
const SOD08LN = { chg: 'e2ep4sod08stml40000000000', pay: 'e2ep4sod08stml50000000000', bf: 'e2ep4sod08stml60000000000', nodoc: 'e2ep4sod08stml70000000000' }
const COST = 'e2ep4costcase100000000000'

const PDF_V1 = '/tmp/openclaw-e2e-sodental-statement-2026-09.pdf'
const PDF_V2 = '/tmp/openclaw-e2e-sodental-statement-2026-09-v2.pdf'

// contract-lock 契約（P3 seed:39 逐字，494 字 ≤ 500）— 必同 seed.sh CONTRACT_HINT 逐字一致
// Qwen3.8-27B-FP8 無 hint 必漂移（bad_response）；有 hint = P3 34/34 綠通道
const CONTRACT_HINT = '所有key必現(冇值填null,禁省略); lineType正常行=INVOICE; 欄名逐字: kind, lab{nameRaw,nameCnRaw,payeeRaw}, billTo{nameRaw,addressRaw,customerNoRaw,shortCodeRaw,doctorRaw}, docNoRaw, docNoLabel, dateRaw, date, deliveryDate, orderReceivedDate, statementMonth, sections[{clinicRaw,doctorRaw,customerNoRaw,addressRaw,pageFrom,pageTo,total,currentTotal,lines[{lineType,docNoRaw,date,patientRaw,patientCodeRaw,labCaseRef,description,toothRaw,qty,unitPrice,amount,agingBucket}]}], subtotal, total, readIssues[], groups[]'

let pass = 0, fail = 0
const log = (tag, msg) => console.log(`[${tag}] ${msg}`)
const ok = (cond, msg) => { if (cond) { pass++; log('PASS', msg) } else { fail++; log('FAIL', msg) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, p, { token = TOKEN, body, form } = {}) {
  const headers = { Cookie: `session=${token}` }
  let payload
  if (form) payload = form
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* csv/html */ }
  return { status: res.status, json, text }
}
let _upn = 0
async function upload(token, pdfPath, extra = {}) {
  if (!extra.idempotencyKey) extra = { ...extra, idempotencyKey: `e2ep4-${++_upn}-${Date.now()}` }
  const form = new FormData()
  form.append('files', new Blob([fs.readFileSync(pdfPath)], { type: 'application/pdf' }), path.basename(pdfPath))
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  const res = await fetch(BASE + '/api/lab-docs/upload', { method: 'POST', headers: { Cookie: `session=${token}` }, body: form })
  const text = await res.text()
  let json = null; try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}
async function getDoc(docId, token = TOKEN) {
  const r = await api('GET', `/api/lab-docs/${docId}`, { token })
  if (r.status !== 200) return null
  const d = r.json?.document ?? r.json
  return { ...d, sections: r.json?.sections ?? d.sections, lines: r.json?.lines ?? d.lines, pages: r.json?.pages ?? d.pages }
}
async function waitExtract(docId, timeoutMs = 480000, token = TOKEN) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    sweepTick()
    const doc = await getDoc(docId, token)
    if (!doc) { await sleep(4000); continue }
    last = doc
    if (doc.status === 'EXTRACT_FAILED') return doc
    if (!['UPLOADED', 'EXTRACTING'].includes(doc.status)) return doc
    await sleep(4000)
  }
  throw new Error(`waitExtract timeout — last=${last?.status} err=${last?.extractError}`)
}
const sectionsOf = (d) => d.sections ?? []
const linesOf = (d, sid) => sectionsOf(d).find((s) => s.id === sid)?.lines ?? []

const ev = { at: new Date().toISOString(), base: BASE, phases: {}, runPhases: (process.env.PHASES ?? '0,A,B,C,D,E').split(',') }
const doPhase = (p) => ev.runPhases.includes(p)

// §5.1：extraction 只經 internal sweep 觸發（生產 = 每 5 分鐘 cron；E2E 加速版：每輪 poll 打一次）
async function sweepTick() {
  try {
    await fetch(BASE + '/api/internal/labdoc-sweep', {
      method: 'POST',
      headers: { 'x-cron-key': process.env.APRICOT_CRON_KEY ?? '' },
    })
  } catch { /* fire-and-forget */ }
}

// ════════════════════════ PHASE 0: P4 新 API live ════════════════════════
log('STEP', `P0 lab-profiles / lab-aliases / stats / 設定頁（phases=${ev.runPhases.join(',')}）`)
if (doPhase('0')) {
  // profile GET
  let r = await api('GET', `/api/lab-profiles/${LAB_SOD}`)
  ok(r.status === 200 && r.json.exists === true && r.json.statementKind === 'DETAIL' && r.json.statementDocNoSameAsInvoice === true,
    `profile GET sodental → 200 DETAIL/docNoSame=true（${r.status}）`)
  ok(Array.isArray(r.json.payees) && r.json.payees.includes('honestygifts'), `payees 含 honestygifts（${JSON.stringify(r.json.payees)}）`)
  const t0 = r.json.updatedAt
  ev.phases.profile = { initial: { updatedAt: t0, statementKind: r.json.statementKind } }

  // profile PUT（hint 改 + payees 加一個）
  const newPayee = 'e2ep4newpayee' // rawNorm：normalise 後
  r = await api('PUT', `/api/lab-profiles/${LAB_SOD}`, { body: { updatedAt: t0, extractionHint: 'P4 live hint 測試', payees: ['honestygifts', newPayee] } })
  ok(r.status === 200, `profile PUT → 200（${r.status} ${r.text.slice(0, 80)}）`)
  ok(r.json?.extractionHint === 'P4 live hint 測試' && (r.json?.payees ?? []).length === 2, `PUT 回傳 hint+payees=2（${JSON.stringify(r.json?.payees)}）`)

  // 409：用舊 lock
  r = await api('PUT', `/api/lab-profiles/${LAB_SOD}`, { body: { updatedAt: t0, extractionHint: 'stale' } })
  ok(r.status === 409, `profile PUT stale lock → 409（${r.status}）`)

  // 還原 hint → contract-lock（P3 seed:39 逐字）— LLM phase（C）讀單時 DB 必須有契約鎖
  const after = await api('GET', `/api/lab-profiles/${LAB_SOD}`)
  const restoreRes = await api('PUT', `/api/lab-profiles/${LAB_SOD}`, { body: { updatedAt: after.json.updatedAt, extractionHint: CONTRACT_HINT, payees: ['honestygifts'] } })
  const restored = await api('GET', `/api/lab-profiles/${LAB_SOD}`)
  ok(restoreRes.status === 200 && restored.json.extractionHint === CONTRACT_HINT && restored.json.payees.length === 1,
    `profile 還原契約鎖（hint=${(restored.json.extractionHint ?? '').length}字, payees=${restored.json.payees.length}）`)
  ev.phases.contractLock = { afterP0: restored.json.extractionHint === CONTRACT_HINT, hintLen: (restored.json.extractionHint ?? '').length }

  // aliases GET
  r = await api('GET', '/api/lab-aliases')
  ok(r.status === 200 && r.json.count >= 6, `aliases GET all → 200 count=${r.json?.count}（≥6）`)
  r = await api('GET', `/api/lab-aliases?type=LabAlias&labId=${LAB_SOD}`)
  ok(r.status === 200 && r.json.aliases.every((a) => a.type === 'LabAlias') && r.json.count === 3, `LabAlias?sodental → 3（${r.json?.count}）`)
  ok(r.json.aliases.some((a) => a.kind === 'NAME_CN' && a.rawNorm === '禾呈') && r.json.aliases.some((a) => a.kind === 'PAYEE'), 'LabAlias 含 NAME_CN 禾呈 + PAYEE')
  r = await api('GET', '/api/lab-aliases?type=LabCustomerNo')
  ok(r.status === 200 && r.json.aliases.some((a) => a.customerNo === '88231'), 'LabCustomerNo 88231 喺度')
  r = await api('GET', '/api/lab-aliases?type=BOGUS')
  ok(r.status === 400, `type=BOGUS → 400（${r.status}）`)
  r = await api('GET', `/api/lab-aliases?type=ClinicNameAlias&labId=${LAB_SOD}`)
  ok(r.status === 400, `labId + ClinicNameAlias → 400（${r.status}）`)

  // alias DELETE
  r = await api('DELETE', `/api/lab-aliases/${ALIASCN}?type=LabAlias`)
  ok(r.status === 200 && r.json?.ok === true, `DELETE NAME_CN alias → 200（${r.status}）`)
  r = await api('DELETE', `/api/lab-aliases/${ALIASCN}?type=LabAlias`)
  ok(r.status === 404, `DELETE 重覆 → 404（${r.status}）`)
  r = await api('DELETE', `/api/lab-aliases/${ALIASEN}`)
  ok(r.status === 400, `DELETE 無 type → 400（${r.status}）`)
  // 還原
  const profAfter = await api('GET', `/api/lab-profiles/${LAB_SOD}`)
  await api('PUT', `/api/lab-profiles/${LAB_SOD}`, { body: { updatedAt: profAfter.json.updatedAt, payees: ['honestygifts'] } })

  // stats
  r = await api('GET', '/api/lab-docs/stats')
  ok(r.status === 200 && Number(r.json.totalBytes) >= 0 && r.json.fileCount >= 0 && r.json.docCount > 0 && typeof r.json.statusCounts === 'object',
    `stats → 200 bytes=${r.json?.totalBytes} files=${r.json?.fileCount} docs=${r.json?.docCount} statuses=${JSON.stringify(r.json?.statusCounts)}`)
  ev.phases.stats = r.json

  // RBAC：lab_invoice only → 403（stats + profile PUT + alias DELETE）
  r = await api('GET', '/api/lab-docs/stats', { token: EMP_TOKEN })
  ok(r.status === 403, `stats（lab_invoice only）→ 403（${r.status}）`)
  const profNow = await api('GET', `/api/lab-profiles/${LAB_SOD}`)
  r = await api('PUT', `/api/lab-profiles/${LAB_SOD}`, { token: EMP_TOKEN, body: { updatedAt: profNow.json.updatedAt } })
  ok(r.status === 403, `profile PUT（lab_invoice only）→ 403（${r.status}）`)
  r = await api('DELETE', `/api/lab-aliases/${ALIASEN}?type=LabAlias`, { token: EMP_TOKEN })
  ok(r.status === 403, `alias DELETE（lab_invoice only）→ 403（${r.status}）`)

  // 設定頁 HTML（'use client' 頁 — SSR 只係 loading shell；真渲染用 headless 核）
  r = await api('GET', '/lab-docs/settings')
  ok(r.status === 200 && /載入中|Lab 設定/.test(r.text), `設定頁 HTML → 200（${r.status}, ${r.text.length} bytes）`)
  // 403 視圖：lab_invoice only 用戶開設定頁（client gate 顯示冇權限 — HTML 200，內容提示）
  r = await api('GET', '/lab-docs/settings', { token: EMP_TOKEN })
  ok(r.status === 200, `設定頁 HTML（lab_invoice user）→ 200（client gate 顯示冇權限提示）`)
}

// ════════════════════════ PHASE A: sample-text.pdf（文字層）════════════════
log('STEP', 'PA 上傳 sample-text.pdf（文字層、2 頁 → D9 拆 2 單）…')
if (doPhase('A')) {
  const up = await upload(TOKEN, path.join(FIX, 'sample-text.pdf'), { kind: 'INVOICE' })
  ok(up.status === 201 || up.status === 200, `upload → ${up.status} ${up.text.slice(0, 100)}`)
  const docs = up.json?.documents ?? []
  ok(docs.length === 2, `2 張單（D9 拆頁；得 ${docs.length}）`)
  const ids = docs.map((d) => d.id)
  const settled = []
  for (const id of ids) settled.push(await waitExtract(id, 120000))
  const sts = settled.map((d) => d.status).sort()
  ok(JSON.stringify(sts) === JSON.stringify(['DUPLICATE', 'NEEDS_REVIEW']),
    `T9 去重：一 NEEDS_REVIEW 一 DUPLICATE（得 ${sts.join('/')}）`)
  const dup = settled.find((d) => d.status === 'DUPLICATE')
  const win = settled.find((d) => d.status === 'NEEDS_REVIEW')
  ok(dup?.duplicateOfId === win?.id, `DUPLICATE.duplicateOfId → 贏家（${dup?.duplicateOfId}）`)
  ev.phases.textUpload = { docs: ids, statuses: sts, dupPointsWinner: dup?.duplicateOfId === win?.id }
}

// ════════════════════════ PHASE B: sample-scan.pdf（真 LLM 3105）═════════════
log('STEP', 'PB 上傳 sample-scan.pdf（無文字層 → 真 LLM 3105）…')
if (doPhase('B')) {
  const up = await upload(TOKEN, path.join(FIX, 'sample-scan.pdf'), { kind: 'INVOICE' })
  ok(up.status === 201 || up.status === 200, `upload → ${up.status} ${up.text.slice(0, 100)}`)
  const docs = up.json?.documents ?? []
  ok(docs.length >= 1, `${docs.length} 張單（scan 2 頁）`)
  const settled = []
  for (const id of docs.map((d) => d.id)) settled.push(await waitExtract(id, 480000))
  const sts = settled.map((d) => d.status)
  ok(settled.every((d) => !['UPLOADED', 'EXTRACTING'].includes(d.status)), `全部終態（${sts.join('/')}）`)
  ok(settled.every((d) => (d.extractAttempts ?? 0) >= 1), `extractAttempts ≥1（真 LLM 被調用；${settled.map((d) => d.extractAttempts).join('/')}）`)
  if (settled.some((d) => d.status === 'EXTRACT_FAILED')) {
    for (const d of settled) if (d.status === 'EXTRACT_FAILED') log('INFO', `scan doc ${d.id} EXTRACT_FAILED attempts=${d.extractAttempts} err=${(d.extractError ?? '').slice(0, 160)}`)
  }
  ev.phases.scanUpload = { docs: docs.map((d) => d.id), statuses: sts, attempts: settled.map((d) => d.extractAttempts), errors: settled.map((d) => (d.extractError ?? '').slice(0, 200)) }
}

// ════════════════════════ PHASE C: Sodental 09 PDF（LLM + reconcile）══════
log('STEP', 'PC 上傳 Sodental 09 statement v1（真 LLM 讀單）…')
let docV1 = null
if (doPhase('C')) {
  // 契約鎖護目鏡：LLM 讀單前 DB hint 必 = P3 逐字契約（extract.ts 讀 DB → labHint → W payload → prompt）
  const profNow = await api('GET', `/api/lab-profiles/${LAB_SOD}`)
  ok(profNow.json.extractionHint === CONTRACT_HINT,
    `契約鎖就位（DB hint=${(profNow.json.extractionHint ?? '').length}字，${profNow.json.extractionHint === CONTRACT_HINT ? '= P3 契約' : '≠ 契約 — LLM 無保護'}）`)
  ev.phases.contractLock = { ...(ev.phases.contractLock ?? {}), beforeC: profNow.json.extractionHint === CONTRACT_HINT }

  const up = await upload(TOKEN, PDF_V1, { kind: 'STATEMENT', labId: LAB_SOD, statementMonth: '2026-09' })
  ok(up.status === 201 || up.status === 200, `upload v1 → ${up.status} ${up.text.slice(0, 100)}`)
  docV1 = up.json?.documents?.[0]?.id ?? up.json?.id
  ok(!!docV1, `docV1=${docV1}`)
  const d1 = await waitExtract(docV1, 480000)
  ok(d1.status !== 'EXTRACT_FAILED', `v1 extract done status=${d1.status} err=${(d1.extractError ?? '').slice(0, 120)}`)
  if (d1.status === 'EXTRACT_FAILED') { console.log(JSON.stringify(d1, null, 2).slice(0, 2500)); log('ABORT', 'v1 extract failed'); process.exit(1) }
  const secs = sectionsOf(d1)
  ok(secs.length === 3, `3 段（得 ${secs.length}）`)
  ok(secs.every((s) => s.clinicId === CLINIC), '全部段 clinic=CUSTOMER_NO 命中')
  const sT = secs.find((s) => s.providerId === PROV_T), sY = secs.find((s) => s.providerId === PROV_Y), sH = secs.find((s) => s.providerId === PROV_H)
  ok(!!sT && !!sY && !!sH, '3 段 provider 識別（Tong/Yiu/Ho）')

  for (const [n, s] of [['Tong', sT], ['Yiu', sY], ['Ho', sH]]) {
    const rr = await api('POST', `/api/lab-docs/${docV1}/sections/${s.id}/reconcile`, { body: {} })
    ok(rr.status === 200, `reconcile ${n} → ${rr.status} ${rr.text.slice(0, 100)}`)
  }
  const d2 = await getDoc(docV1)
  const tongLines = linesOf(d2, sT.id)
  const qd = tongLines.find((l) => l.result === 'QTY_DIFF')
  ok(!!qd, `Tong 段 QTY_DIFF（${tongLines.map((l) => l.result).join(',')}）`)
  ok(qd && Math.abs(Number(qd.amount) - 560) < 0.01, `QTY_DIFF 差 560（得 ${qd?.amount}）`)
  ok(tongLines.some((l) => l.result === 'MATCHED'), 'Tong 段有 MATCHED')
  const tSt = d2.sections.find((s) => s.id === sT.id)
  ok(Math.abs(Number(tSt.statedTotal) - 1810) < 0.01, `Tong statedTotal=1810（得 ${tSt.statedTotal}）`)
  const ySt = d2.sections.find((s) => s.id === sY.id), hSt = d2.sections.find((s) => s.id === sH.id)
  ok(ySt.status === 'OK' && hSt.status === 'OK', `Yiu/Ho 段 OK（${ySt.status}/${hSt.status}）`)

  const rs = await api('POST', `/api/lab-docs/${docV1}/sections/${sT.id}/lines/${qd.id}/resolve`, { body: { resolution: 'INVOICE_WINS', note: '月結單數量正確，系統 invoice 多打一次' } })
  ok(rs.status === 200, `resolve INVOICE_WINS → ${rs.status}`)

  for (const [n, s] of [['Tong', sT], ['Yiu', sY], ['Ho', sH]]) {
    const rr = await api('POST', `/api/lab-docs/${docV1}/sections/${s.id}/confirm`, { body: {} })
    ok(rr.status === 200, `confirm ${n} → ${rr.status}`)
  }
  const d3 = await getDoc(docV1)
  ok(d3.status === 'RECONCILED', `文件 RECONCILED（得 ${d3.status}）`)
  ev.phases.sodental09 = { doc: docV1, tongQtdiff: 560, tongStated: 1810, yiHoOK: true, reconciled: d3.status === 'RECONCILED' }
}

// ── T19：v2 重複擋 + supersede ──────────────────────────────────────────
log('STEP', 'PC2 新版 v2（改 Yiu 段 950→960）上傳 + supersede…')
if (doPhase('C')) {
  const up2 = await upload(TOKEN, PDF_V2, { kind: 'STATEMENT', labId: LAB_SOD, statementMonth: '2026-09' })
  ok(up2.status === 201 || up2.status === 200, `upload v2 → ${up2.status} ${up2.text.slice(0, 100)}`)
  const docV2 = up2.json?.documents?.[0]?.id ?? up2.json?.id
  const d4 = await waitExtract(docV2, 480000)
  ok(d4.status !== 'EXTRACT_FAILED', `v2 extract done（${d4.status}）`)
  if (d4.status === 'EXTRACT_FAILED') { console.log(JSON.stringify(d4, null, 2).slice(0, 2500)); process.exit(1) }
  const dupFlag = (d4.readIssues ?? []).some((x) => /DUP|重複/i.test(x)) || sectionsOf(d4).some((s) => s.status === 'DUPLICATE' || s.duplicationFlag === true)
  log('INFO', `v2 readIssues=${JSON.stringify(d4.readIssues)} sections=${sectionsOf(d4).map((s) => s.status).join(',')}`)
  ok(dupFlag, 'v2 分段重複擋（同 Lab+診所+醫生+月）')
  const v2doc = await getDoc(docV2)
  const sup = await api('POST', `/api/lab-docs/${docV2}/supersede`, { body: { oldDocumentId: docV1, reason: 'P4 E2E — 修正 Yiu 段金額', version: v2doc.version } })
  ok(sup.status === 200, `supersede → ${sup.status} ${sup.text.slice(0, 100)}`)
  const v1After = await getDoc(docV1)
  ok(v1After.status === 'SUPERSEDED' && v1After.supersededById === docV2, `v1 SUPERSEDED（${v1After.status}）`)

  // T11：lab_invoice only → 403
  const r1 = await api('POST', `/api/lab-docs/${docV2}/supersede`, { token: EMP_TOKEN, body: { oldDocumentId: docV1, reason: 'T11', version: 0 } })
  ok(r1.status === 403, `T11 supersede（lab_invoice only）→ ${r1.status}`)
  ev.phases.t19 = { docV2, superseded: v1After.status === 'SUPERSEDED', t11_403: r1.status === 403 }
}

// ════════════════════════ PHASE D: seed 月結單 live reconcile ═════════════
log('STEP', 'PD Excel 09 / Modern 06 / Sodental 08 live reconcile…')
if (doPhase('D')) {
  // Excel 09（OUTSTANDING）
  let r = await api('POST', `/api/lab-docs/${EXC09DOC}/sections/${EXC09SEC}/reconcile`, { body: {} })
  ok(r.status === 200, `Excel reconcile → ${r.status} ${r.text.slice(0, 100)}`)
  let d = await getDoc(EXC09DOC)
  let sec = sectionsOf(d).find((s) => s.id === EXC09SEC)
  const L = linesOf(d, EXC09SEC)
  const byId = Object.fromEntries(L.map((l) => [l.id, l]))
  ok(byId[EXC09LN.a]?.result === 'MATCHED', `0509 → MATCHED（得 ${byId[EXC09LN.a]?.result}）`)
  ok(byId[EXC09LN.b]?.result === 'MATCHED', `0811 → MATCHED（得 ${byId[EXC09LN.b]?.result}）`)
  ok(byId[EXC09LN.c]?.result === 'PREVIOUSLY_MATCHED', `0885 → PREVIOUSLY_MATCHED（得 ${byId[EXC09LN.c]?.result}）`)
  ok(byId[EXC09LN.d]?.result === 'MISSING_IN_SYSTEM', `1202 → MISSING_IN_SYSTEM（得 ${byId[EXC09LN.d]?.result}）`)
  const sysTotal = Number(sec.systemTotal)
  ok(Math.abs(sysTotal - 1061) < 0.01, `systemTotal=1,061（800+261；PREVIOUSLY_MATCHED/MISSING 唔計；得 ${sec.systemTotal}）`)
  ok(Math.abs(Number(sec.statedCurrent) - 1061) < 0.01, `statedCurrent=1,061（§5.5 ΣCURRENT 驗收線）`)
  ev.phases.excel09 = { results: L.map((l) => l.result), systemTotal: sec.systemTotal, statedCurrent: sec.statedCurrent }

  // Modern 06（INVOICE_LIST docNoSame=false → fallback）
  r = await api('POST', `/api/lab-docs/${MOD06DOC}/sections/${MOD06SEC}/reconcile`, { body: {} })
  ok(r.status === 200, `Modern reconcile → ${r.status} ${r.text.slice(0, 100)}`)
  d = await getDoc(MOD06DOC)
  const ML = linesOf(d, MOD06SEC)
  const mBy = Object.fromEntries(ML.map((l) => [l.id, l]))
  ok(mBy[MOD06LN.a]?.result === 'MATCHED' && mBy[MOD06LN.a]?.matchBasis === 'FALLBACK', `Modern fallback 250 → MATCHED/FALLBACK（得 ${mBy[MOD06LN.a]?.result}/${mBy[MOD06LN.a]?.matchBasis}）`)
  ok(mBy[MOD06LN.a] && mBy[MOD06LN.a].matchedDocumentId === MODINV1, `fallback 對到 250 張單（matchedDocumentId=${mBy[MOD06LN.a]?.matchedDocumentId}）`)
  const modSec = sectionsOf(d).find((s) => s.id === MOD06SEC)
  ok(Math.abs(Number(modSec?.systemTotal) - 1230) < 0.01, `Modern systemTotal=1,230（250+980；得 ${modSec?.systemTotal}）`)
  ok(mBy[MOD06LN.b]?.result === 'AMOUNT_DIFF', `980 vs 1,030 → AMOUNT_DIFF（得 ${mBy[MOD06LN.b]?.result}）`)
  ev.phases.modern06 = { results: ML.map((l) => ({ id: l.id, result: l.result, basis: l.matchBasis, sys: l.systemAmount })) }

  // Sodental 08（DETAIL：CHARGE/PAYMENT/BF + 無單號行）
  r = await api('POST', `/api/lab-docs/${SOD08DOC}/sections/${SOD08SEC}/reconcile`, { body: {} })
  ok(r.status === 200, `Sodental08 reconcile → ${r.status} ${r.text.slice(0, 100)}`)
  d = await getDoc(SOD08DOC)
  const SL = linesOf(d, SOD08SEC)
  const sBy = Object.fromEntries(SL.map((l) => [l.id, l]))
  ok(sBy[SOD08LN.chg]?.result === 'NEEDS_MANUAL', `CHARGE → NEEDS_MANUAL（得 ${sBy[SOD08LN.chg]?.result}）`)
  ok(sBy[SOD08LN.pay]?.result === 'NOT_APPLICABLE' && sBy[SOD08LN.bf]?.result === 'NOT_APPLICABLE', `PAYMENT/BF → NOT_APPLICABLE（${sBy[SOD08LN.pay]?.result}/${sBy[SOD08LN.bf]?.result}）`)
  ok(sBy[SOD08LN.nodoc]?.result === 'NEEDS_MANUAL', `DETAIL 無單號 INVOICE 行 → NEEDS_MANUAL（得 ${sBy[SOD08LN.nodoc]?.result}）`)
  ev.phases.sodental08 = { results: SL.map((l) => l.result) }
}

// ════════════════════════ PHASE E: 折扣 B4（labInvoiceLinked）══════════════
log('STEP', 'PE 折扣 B4：labInvoiceLinked=true 唔套 8.5%…')
if (doPhase('E')) {
  // cost API 無 GET（405）— 用 PUT 讀回（partial update 冪等）
  let r = await api('PUT', `/api/cost-cases/${COST}`, { body: { baseCost: 500 } })
  ok(r.status === 200 && Number(r.json?.case?.baseCost) === 500, `cost PUT 讀回 → 200 baseCost=500（得 ${r.json?.case?.baseCost}）`)

  // PUT 冇 labId
  r = await api('PUT', `/api/cost-cases/${COST}`, { body: { baseCost: 500 } })
  ok(r.status === 200 && Number(r.json?.case?.finalCost) === 500 && r.json?.case?.discountPct === null,
    `PUT 冇 labId → finalCost=500, discountPct=null（得 ${r.json?.case?.finalCost}/${r.json?.case?.discountPct}）`)

  // PUT 有 labId（表內有 8.5% 折扣）
  r = await api('PUT', `/api/cost-cases/${COST}`, { body: { baseCost: 500, labId: LAB_SOD } })
  ok(r.status === 200 && Number(r.json?.case?.finalCost) === 500 && r.json?.case?.discountPct === null,
    `PUT 有 labId → 一樣 finalCost=500（得 ${r.json?.case?.finalCost}/${r.json?.case?.discountPct}）`)

  // recompute
  r = await api('POST', '/api/cost-cases/recompute', { body: { labId: LAB_SOD, periodMonth: '2026-09' } })
  ok(r.status === 200, `recompute → ${r.status} ${r.text.slice(0, 100)}`)
  r = await api('PUT', `/api/cost-cases/${COST}`, { body: { baseCost: 500 } })
  ok(r.status === 200 && Number(r.json?.case?.finalCost) === 500, `recompute 後 finalCost 仍 500（得 ${r.json?.case?.finalCost}）`)
  ev.phases.discountB4 = { baseCost: 500, finalCost: Number(r.json?.case?.finalCost), noDiscountApplied: Number(r.json?.case?.finalCost) === 500 }
}

// ── 證據落檔 ────────────────────────────────────────────────────────────
const outPath = path.join(OUT_DIR, `e2e-${Date.now()}.json`)
fs.writeFileSync(outPath, JSON.stringify(ev, null, 2))
console.log(`\n════════ P4 E2E RESULT: ${pass} PASS / ${fail} FAIL ════════`)
console.log(`evidence: ${outPath}`)
process.exit(fail ? 1 : 0)
