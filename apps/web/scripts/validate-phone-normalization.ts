/**
 * ★ cwi-followup-p0-20260915（S4）：電話正規化驗證腳本（MD §1.2 / §1.4）
 *
 * 抽 200 病人，report「可正規化 / 唔合法 / 多號」比例。
 * **可正規化率 < 90% → exit 1（停手檢討 — CEO 拍板，唔好硬 push）**。
 *
 * dev 無 APRICOT credential（CEO 明令唔好打真 Apricot）→ 無真病人電話。
 * 本腳本內置 200 條 deterministic stub corpus，格式分布照 MD §0.4 實測：
 *   8 位本地（無號內空位）／11 位 852／+852／19 字多號（852+8 位 + 斜線 + 8 位）
 *   + phoneList-only + 空欄 + 唔合法邊界（含號內空位 — spec 會丟，要量到影響）。
 * 上線前喺有 APRICOT credential 嘅環境用真數據重跑：
 *   npx tsx scripts/validate-phone-normalization.ts --input /path/to/patients.json
 * （input 形狀：[{ "id": "...", "phoneNum": "...", "phoneList": [{ "type": "mobile", "number": "..." }] }]）
 *
 * 用法：
 *   npx tsx scripts/validate-phone-normalization.ts [--input file.json] [--report out.md]
 * report 存 test/reports/phone-normalization-report-20260915.md（commit 存檔）。
 * 真數據模式下 report 內 raw 電話只露前 3 位（mask）— 原始號碼只留喺 workforce。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeHkPhones } from '../src/lib/phone'

const THRESHOLD = 0.9

// ── deterministic PRNG（mulberry32 — stub 可重現）────────────────────
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Patient = { id: string; phoneNum: string | null; phoneList?: { type: string; number: string }[] }

/** 造 200 條 stub（格式分布照 MD §0.4 實測 + 邊界情況） */
function makeStubCorpus(): Patient[] {
  const rng = mulberry32(20260915)
  const d = () => Math.floor(rng() * 10)
  const out: Patient[] = []
  let n = 0
  const push = (phoneNum: string | null, phoneList?: Patient['phoneList']) =>
    out.push({ id: `stub-p-${String(++n).padStart(3, '0')}`, phoneNum, phoneList })

  // 100 × 8 位本地（手機 5/6/9 開頭 + 固話 2/3 開頭）
  for (let i = 0; i < 100; i++) {
    const lead = [5, 6, 9, 9, 9, 2, 3][Math.floor(rng() * 7)]
    push(`${lead}${d()}${d()}${d()}${d()}${d()}${d()}${d()}`)
  }
  // 40 × 11 位 852
  for (let i = 0; i < 40; i++) push(`852${[6, 9][Math.floor(rng() * 2)]}${d()}${d()}${d()}${d()}${d()}${d()}${d()}`)
  // 20 × +852
  for (let i = 0; i < 20; i++) push(`+852${[5, 6, 9][Math.floor(rng() * 3)]}${d()}${d()}${d()}${d()}${d()}${d()}`)
  // 18 × 19 字多號（MD §0.4 實測 19 字：852+8 位 / 8 位）
  for (let i = 0; i < 18; i++) push(`852${d()}${d()}${d()}${d()}${d()}${d()}${d()}${d()}/${d()}${d()}${d()}${d()}${d()}${d()}${d()}${d()}`)
  // 8 × 只喺 phoneList（phoneNum 空 — phoneList mobile 優先）
  for (let i = 0; i < 8; i++) push(null, [{ type: 'mobile', number: `${[6, 9][Math.floor(rng() * 2)]}${d()}${d()}${d()}${d()}${d()}${d()}${d()}` }])
  // 6 × 完全無電話（phoneNum null + phoneList 空）
  for (let i = 0; i < 6; i++) push(null, [])
  // 4 × 唔合法邊界（短號／1 開頭 8 位）
  push('12345')
  push('11111111')
  push('852123456')
  push('234567')
  // 4 × 號內空位（spec 逐字 → 全 fragment 丟 — 實測量影響）
  push('9123 4567')
  push('6123 4567')
  push('9123 4567 / 6123 4567')
  push('+852 9123 4567')

  return out
}

/** 病人 → hash 集合（phoneNum + phoneList mobile 優先 — MD §1.2） */
function patientHashes(p: Patient): string[] {
  const cands: (string | null)[] = []
  const mob = (p.phoneList ?? []).filter((x) => x.type === 'mobile').map((x) => x.number)
  const others = (p.phoneList ?? []).filter((x) => x.type !== 'mobile').map((x) => x.number)
  cands.push(p.phoneNum, ...mob, ...others) // mobile 優先（MD：mobile 優先）
  const seen = new Set<string>()
  for (const c of cands) for (const h of normalizeHkPhones(c)) seen.add(h)
  return [...seen]
}

const mask = (s: string | null) => (s ? s.slice(0, 3) + '***' : '(空)')

function main() {
  const args = process.argv.slice(2)
  const inIdx = args.indexOf('--input')
  const reportIdx = args.indexOf('--report')
  let patients: Patient[]
  let source: string
  if (inIdx >= 0 && args[inIdx + 1]) {
    patients = JSON.parse(readFileSync(args[inIdx + 1], 'utf8')) as Patient[]
    source = `真數據：${args[inIdx + 1]}（${patients.length} 病人）`
  } else {
    patients = makeStubCorpus()
    source = '內置 stub corpus（dev 無 APRICOT credential — 格式分布照 MD §0.4 實測）'
  }

  let normal = 0, multi = 0, bad = 0
  const badSamples: { id: string; raw: string[] }[] = []
  const multiSamples: { id: string; n: number }[] = []
  const lenBucket = new Map<number, { total: number; ok: number }>()

  for (const p of patients) {
    const raw = [p.phoneNum, ...(p.phoneList ?? []).map((x) => x.number)].filter(Boolean) as string[]
    const lens = new Set(raw.map((r) => r.length))
    for (const L of lens) {
      const b = lenBucket.get(L) ?? { total: 0, ok: 0 }
      b.total++
      lenBucket.set(L, b)
    }
    const hashes = patientHashes(p)
    if (hashes.length >= 1) {
      normal++
      for (const L of lens) lenBucket.get(L)!.ok++
      if (hashes.length > 1) { multi++; multiSamples.push({ id: p.id, n: hashes.length }) }
    } else {
      bad++
      if (badSamples.length < 20) badSamples.push({ id: p.id, raw: raw.map(mask) })
    }
  }

  const total = patients.length
  const rate = normal / total
  const pass = rate >= THRESHOLD

  // ── report ──
  const lines: string[] = []
  lines.push(`# 電話正規化驗證 report — cwi-followup-p0-20260915（S4）`)
  lines.push('')
  lines.push(`- 日期：2026-09-15（Asia/Hong_Kong）`)
  lines.push(`- 數據源：${source}`)
  lines.push(`- 函數：src/lib/phone.ts normalizeHkPhones（MD §1.2 逐字）`)
  lines.push('')
  lines.push(`## 結果：${(rate * 100).toFixed(1)}% 可正規化（門檻 ≥ ${(THRESHOLD * 100).toFixed(0)}%）→ **${pass ? 'PASS ✅' : 'FAIL 🔴 停手檢討'}**`)
  lines.push('')
  lines.push(`| 類別 | 數目 | 比例 |`)
  lines.push(`|---|---|---|`)
  lines.push(`| 可正規化（含多號） | ${normal} | ${((normal / total) * 100).toFixed(1)}% |`)
  lines.push(`| 其中多號（>1 hash） | ${multi} | ${((multi / total) * 100).toFixed(1)}% |`)
  lines.push(`| 唔合法（0 hash） | ${bad} | ${((bad / total) * 100).toFixed(1)}% |`)
  lines.push('')
  lines.push(`## 按 raw 長度分桶（MD §0.4 實測 8 / 19 字）`)
  lines.push('')
  lines.push(`| 長度 | 病人 | 可正規化 |`)
  lines.push(`|---|---|---|`)
  for (const [L, b] of [...lenBucket.entries()].sort((a, b2) => a[0] - b2[0])) {
    lines.push(`| ${L} | ${b.total} | ${b.ok} |`)
  }
  lines.push('')
  if (badSamples.length) {
    lines.push(`## 唔合法 sample（raw 已 mask — 原始號碼唔離 workforce）`)
    lines.push('')
    for (const s of badSamples) lines.push(`- ${s.id}: [${s.raw.join(' | ')}]`)
    lines.push('')
  }
  if (multiSamples.length) {
    lines.push(`## 多號 sample（前 10）`)
    lines.push('')
    for (const s of multiSamples.slice(0, 10)) lines.push(`- ${s.id}: ${s.n} 個 hash`)
    lines.push('')
  }
  lines.push(`## 備註`)
  lines.push('')
  lines.push('- dev 環境無 APRICOT credential — 呢份 report 係 stub corpus 結果（格式分布照 MD §0.4 實測）。')
  lines.push('- **上線前必喺有 credential 嘅環境用真 200 病人重跑**（--input 模式），rate < 90% 要停手檢討。')
  lines.push('- spec 已知行為：號內空位會被當分隔符（fragment 4 位 → 丟）。MD §0.4 實測 8/19 字格式均無號內空位。')

  const reportPath = reportIdx >= 0 && args[reportIdx + 1]
    ? args[reportIdx + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '../test/reports/phone-normalization-report-20260915.md')
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, lines.join('\n') + '\n')

  console.log(`[validate-phone] ${source}`)
  console.log(`[validate-phone] total=${total} normalizable=${normal} (${(rate * 100).toFixed(1)}%) multi=${multi} invalid=${bad}`)
  console.log(`[validate-phone] report → ${reportPath}`)
  if (!pass) console.log(`[validate-phone] 🔴 < 90% — 停手檢討（MD §1.2）`)
  process.exitCode = pass ? 0 : 1
}

main()
