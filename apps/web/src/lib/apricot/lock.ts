// ============================================================
// Apricot 全局限流鎖（advisory lock 776001）
//
// ★ cwi-refresh-20260831 修復（T143 live 實測事故 2026-08-31）：
//   舊版用 prisma.$queryRaw 做 try_lock 同 unlock —— 兩次 call 各自向
//   Prisma pool 借 connection，pool 有 >1 條活 connection 時 unlock 會
//   落到**另一條** connection（pg_advisory_unlock 對唔持鎖嘅 connection
//   係 silent no-op）→ session 級鎖永久漏喺原 connection → 之後所有
//   Apricot call 永遠 skip/409，直到 server 重啟。
//   實測鏈：T140 200 → 1 秒後 T143 try_lock 失敗 409（持鎖者係上一 request
//   嘅 idle prisma connection，pg_locks classid=0/objid=776001 可查）。
//   修復：lock 嘅 try/unlock 綁定**同一條 dedicated pg client**
//   （connect → try → fn → unlock → release），pool interleaving 唔再影響。
//   語義完全唔變：攞唔到即 return null（唔排隊）；fn 拋錯都照 unlock。
// ============================================================
const LOCK_KEY = 776001
import { Pool } from 'pg'

// ── test seam（unit test 用 fake lock client；傳 null 還原真實現）──
export type LockClientLike = {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  release(): void | Promise<void>
}

let lockPool: Pool | null = null

/** 真實現：dedicated pg pool（max:1）借一條 client 包住 try/unlock */
async function defaultLockClient(): Promise<LockClientLike> {
  if (!lockPool) {
    lockPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      // 攞唔到 connection 唔好 hang 死（pool 只有 1 條；死鎖防護）
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 60_000,
    })
  }
  return (await lockPool.connect()) as unknown as LockClientLike
}

let clientFactory: () => Promise<LockClientLike> = defaultLockClient

/** test-only：inject fake lock client factory（傳 null 還原真實現） */
export function setApricotLockClientFactoryForTest(
  factory: (() => Promise<LockClientLike>) | null,
): void {
  clientFactory = factory ?? defaultLockClient
}

export async function withApricotLock<T>(fn: () => Promise<T>): Promise<T | null> {
  let client: LockClientLike | null = null
  try {
    client = await clientFactory()
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY])
    if (!rows[0] || rows[0].locked !== true) {
      console.warn('[apricot] 已有 call 進行中，今次跳過')
      return null
    }
    try {
      return await fn()
    } finally {
      // unlock 必喺同一條 client；失敗只 log（connection 死咗嘅話
      // server 側 session 斷開會自動釋放鎖 — 自愈）
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
      } catch (e) {
        console.error('[apricot] advisory unlock 失敗（connection 可能已斷 — 鎖會隨 session 斷開自動釋放）', e)
      }
    }
  } finally {
    client?.release()
  }
}
