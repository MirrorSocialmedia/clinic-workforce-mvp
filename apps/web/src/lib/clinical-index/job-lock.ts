// ============================================================
// clinical-index job 級排他鎖（cwi-qa FX-30 / QA-30）
//
// 防雙跑：cron + 手動 curl 同時打同一 endpoint（或上一晚未跑完、
// 新 cron 又觸發）→ 兩個 job 並行處理同一日（重複 Apricot call + 重複 LLM）。
//
// 同 Apricot 全局限流鎖 776001（lib/apricot/lock.ts）係兩樣嘢：
//   - 776001：串行化「單次 Apricot call」（token 防搶）
//   - 呢度：串行化「job 本身」（backfill / nightly 各一把，per-kind）
//
// session 級 advisory lock — try/unlock 綁定同一條 dedicated client
// （同 lock.ts 同一 pattern；T143 事故教訓：prisma pool 兩條 connection
// 各借一次，unlock 會落到另一條 = silent no-op → 鎖永久漏）。
//
// 攞唔到鎖唔排隊，即刻回 { running: true }（route → 409 ALREADY_RUNNING）。
// fn 拋錯都照 unlock + release。
// ============================================================

import { Pool } from 'pg'

export const CLINICAL_INDEX_LOCK_KEY = {
  BACKFILL: 776002,
  NIGHTLY: 776003,
} as const

export type ClinicalIndexJobKind = keyof typeof CLINICAL_INDEX_LOCK_KEY

type JobLockClientLike = {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  release(): void | Promise<void>
}

let clientFactory: (kind: ClinicalIndexJobKind) => Promise<JobLockClientLike> = (kind) => {
  // per-kind dedicated pool（max:1）— 鎖綁定 connection，pool 細到唔會 interleaving
  void kind
  return defaultPool().connect()
}

let sharedPool: Pool | null = null
function defaultPool(): Pool {
  if (!sharedPool) {
    sharedPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      // 攞唔到 connection 唔好 hang 死（死鎖防護 — 同 lock.ts 口徑）
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 60_000,
    })
  }
  return sharedPool
}

/** test-only：inject fake client factory（傳 null 還原真實現） */
export function setJobLockClientFactoryForTest(
  factory: ((kind: ClinicalIndexJobKind) => Promise<JobLockClientLike>) | null,
): void {
  clientFactory = factory ?? ((kind) => defaultPool().connect())
}

/**
 * 排他執行：
 *   - 攞唔到鎖 → `{ running: true }`（job 已喺跑 — 唔排隊、唔重跑）
 *   - 攞到 → 跑 fn → `{ running: false, result }`（finally 必 unlock + release）
 */
export async function runExclusive<T>(
  kind: ClinicalIndexJobKind,
  fn: () => Promise<T>,
): Promise<{ running: true } | { running: false; result: T }> {
  const key = CLINICAL_INDEX_LOCK_KEY[kind]
  let client: JobLockClientLike | null = null
  try {
    client = await clientFactory(kind)
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [key])
    if (!rows[0] || rows[0].locked !== true) {
      return { running: true }
    }
    try {
      const result = await fn()
      return { running: false, result }
    } finally {
      // unlock 必喺同一條 client；失敗只 log（connection 死咗 session 斷開會自動釋放 — 自愈）
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [key])
      } catch (e) {
        console.error(`[clinical-index] advisory unlock 失敗（${kind}）— 鎖會隨 session 斷開自動釋放`, e)
      }
    }
  } finally {
    try {
      await client?.release()
    } catch {
      /* release 失敗 = connection 已死，pool 會清理 */
    }
  }
}
