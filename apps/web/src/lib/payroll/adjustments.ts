// ============================================================
// ★ cwm-payadj-20261017 ②：計糧調整（MPF 前／MPF 後）— lib（MD §2.3 逐字）
//
// 概念：
//   · 調整掛【員工＋月份】（PayrollAdjustment 表），唔掛 PayrollItem
//     → 重新生成草稿唔會清走。
//   · PRE_MPF（MPF 前／當工資）：加落總薪酬 → 影響強積金、EO 工資（ADW）
//   · POST_MPF（MPF 後／唔當工資）：計完強積金先加／減 → 唔影響強積金、唔計 EO 工資
//
// 金額：DB 用 Decimal(12,2)；入引擎先 Number(x) + round2（MD §2.2 註）。
// hash：sha1(按 id 排序後 id|amount|timing 串埋) — 用於偵測草稿過期
//   （detail.adjHash vs live hash 唔同 = 改咗調整未重算，finalize 要擋）。
// ============================================================
import { createHash } from 'node:crypto'

export type AdjTiming = 'PRE_MPF' | 'POST_MPF'
export type AdjSign = 'ADD' | 'DEDUCT'

export type AdjRow = { id: string; amount: number; mpfTiming: AdjTiming; reason: string }

export type AdjInputValue = {
  /** 正數金額（> 0，≤ 1,000,000，最多 2 位小數）— 方向由 sign 決定 */
  amount: number
  sign: AdjSign
  mpfTiming: AdjTiming
  reason: string
}

/** 無調整時嘅 hash（同 sumAdjustments([]).hash 一致） */
export const ADJ_EMPTY_HASH = createHash('sha1').update('').digest('hex')

const round2 = (n: number): number => Math.round(n * 100) / 100

// ---- 驗證 -----------------------------------------------------------------
// ★ PR #81 教訓（TOOLS.md）：金額只收 number 或【純數字字串】— 唔收 [5]、{valueOf}、
//   萬用字串（'1e2' 唔收）。字串 trim 後要係 `123` 或 `123.45` 形式（可帶 .0）。
function parseMoney(v: unknown): { ok: true; value: number } | { ok: false; error: string } {
  if (v === null || v === undefined) return { ok: false, error: '缺少金額' }
  let s: string
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { ok: false, error: '金額必須係有效數字' }
    s = String(v)
  } else if (typeof v === 'string') {
    s = v.trim()
    if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: '金額格式錯誤（只收正數，最多 2 位小數）' }
  } else {
    return { ok: false, error: '金額必須係數字或數字字串' }
  }
  const n = Number(s)
  if (!Number.isFinite(n)) return { ok: false, error: '金額格式錯誤' }
  if (n <= 0) return { ok: false, error: '金額要大於 0（加／減由方向揀掣決定）' }
  if (n > 1_000_000) return { ok: false, error: '金額太大（上限 $1,000,000）' }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, error: '金額最多 2 位小數' }
  return { ok: true, value: round2(n) }
}

/**
 * MD §2.3：驗證 POST／PUT body。
 * body = { amount, sign: 'ADD'|'DEDUCT', mpfTiming: 'PRE_MPF'|'POST_MPF', reason }
 * 月份唔由 body 傳（由 run.periodMonth 決定）— 唔可以改調整掛喺邊個月。
 */
export function validateAdjustmentInput(body: unknown): { ok: true; value: AdjInputValue } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'request body 格式錯誤' }
  }
  const b = body as Record<string, unknown>

  const money = parseMoney(b.amount)
  if (!money.ok) return money

  if (b.sign !== 'ADD' && b.sign !== 'DEDUCT') {
    return { ok: false, error: "sign 必須係 'ADD' 或 'DEDUCT'" }
  }
  if (b.mpfTiming !== 'PRE_MPF' && b.mpfTiming !== 'POST_MPF') {
    return { ok: false, error: "mpfTiming 必須係 'PRE_MPF' 或 'POST_MPF'" }
  }
  if (typeof b.reason !== 'string') return { ok: false, error: '缺少原因' }
  const reason = b.reason.trim()
  if (reason.length < 1) return { ok: false, error: '原因唔可以空白' }
  if (reason.length > 200) return { ok: false, error: '原因太長（上限 200 字）' }

  return {
    ok: true,
    value: { amount: money.value, sign: b.sign, mpfTiming: b.mpfTiming, reason },
  }
}

/** sign + 正數金額 → DB 用 signed amount（正 = 加，負 = 減） */
export function signedAmount(value: AdjInputValue): number {
  return value.sign === 'ADD' ? value.amount : -value.amount
}

// ---- 讀取 -----------------------------------------------------------------

// Prisma 型（Decimal 欄）— 用 any 保持呢個 lib 對 prisma client 版本鬆耦合
type DbRow = {
  id: string
  amount: { toString: () => string } | number | string
  mpfTiming: string
  reason: string
}

function toAdjRow(r: DbRow): AdjRow {
  return {
    id: r.id,
    amount: round2(Number(r.amount)),
    mpfTiming: r.mpfTiming as AdjTiming,
    reason: r.reason,
  }
}

/** MD §2.3：deletedAt: null，按 createdAt 排（同月多行調整嘅顯示次序） */
export async function loadAdjustments(db: any, employeeId: string, ym: string): Promise<AdjRow[]> {
  const rows = await db.payrollAdjustment.findMany({
    where: { employeeId, periodMonth: ym, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  })
  return (rows as DbRow[]).map(toAdjRow)
}

// ---- sum + hash -----------------------------------------------------------

/**
 * hash = sha1(按 id 排序後逐行 `${id}|${amount}|${mpfTiming}` 串埋)。
 * ★ 次序無關（按 id 排序）— 同集調整任何讀取次序都得返同一 hash。
 *   冇調整 = sha1('') = ADJ_EMPTY_HASH。
 */
export function adjHashOf(rows: AdjRow[]): string {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const s = sorted.map(r => `${r.id}|${r.amount}|${r.mpfTiming}`).join(',')
  return createHash('sha1').update(s).digest('hex')
}

/** MD §2.3：分 timing 加總（round2）＋ stale 偵測 hash */
export function sumAdjustments(rows: AdjRow[]): { pre: number; post: number; hash: string } {
  let pre = 0
  let post = 0
  for (const r of rows) {
    if (r.mpfTiming === 'PRE_MPF') pre += r.amount
    else post += r.amount
  }
  return { pre: round2(pre), post: round2(post), hash: adjHashOf(rows) }
}

/**
 * 批量版（計糧總表 GET 用 — 避 N+1）：一次 query 攞晒一單全部員工嘅調整，
 * 按員工分組。無調整嘅員工唔會喺 map 入面（caller 用 get() ?? []）。
 */
export async function loadAdjustmentsByEmployees(
  db: any,
  employeeIds: string[],
  ym: string,
): Promise<Map<string, AdjRow[]>> {
  const out = new Map<string, AdjRow[]>()
  if (employeeIds.length === 0) return out
  const rows = await db.payrollAdjustment.findMany({
    where: { employeeId: { in: [...new Set(employeeIds)] }, periodMonth: ym, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  })
  for (const r of rows as DbRow[]) {
    // DbRow 要 employeeId 分組 — findMany select 齊
    const ar = toAdjRow(r)
    const empId = (r as any).employeeId as string
    const arr = out.get(empId) ?? []
    arr.push(ar)
    out.set(empId, arr)
  }
  return out
}
