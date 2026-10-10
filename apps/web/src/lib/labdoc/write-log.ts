/**
 * cwm-labdoc P2 — §7.8 冪等（T4）：LabDocWriteLog
 *
 * 流程（spec §7.8 第 1 步 + 第 11 步）：
 * - 同 key 已有：requestHash 一樣 → 回舊 response（replay）；唔一樣 → 409（conflict）。
 * - 未有 → 寫 IN_PROGRESS → 做大 transaction → DONE + response。
 *
 * 保守決定（decision log）：
 * - IN_PROGRESS（上次做到一半 / process 死咗）+ 同 hash → 照回 conflict（409）：
 *   唔知上次有冇寫過 DB，重放有雙寫風險；前端換新 key 重試（佢本來就每次開畫面生新 key）。
 * - 確定冇寫到 DB 嘅失敗（驗證 400／403／404／409、transaction rollback）→ releaseWriteLog 刪返
 *   IN_PROGRESS 行，同一 key 可以再試（2026-10-10 模擬：burn key 令網絡重試永遠 409）。
 *   唔肯定有冇寫（process 死咗、未知 500）→ 照舊留 IN_PROGRESS（防雙寫）。
 */
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

export interface WriteLogAcquire {
  kind: 'replay'
  response: unknown
}
export interface WriteLogConflict {
  kind: 'conflict'
  reason: 'hash_mismatch' | 'in_progress'
}
export interface WriteLogAcquired {
  kind: 'acquired'
}
export type WriteLogResult = WriteLogAcquire | WriteLogConflict | WriteLogAcquired

/** 穩定 hash：key 排序嘅 JSON（唔受欄位順序影響）。 */
export function stableRequestHash(body: unknown): string {
  const canonical = JSON.stringify(body, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v).sort().reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k]
          return acc
        }, {})
      : v,
  )
  return createHash('sha256').update(canonical).digest('hex')
}

export async function acquireWriteLog(
  idempotencyKey: string,
  route: string,
  requestHash: string,
  userId: string,
): Promise<WriteLogResult> {
  const existing = await prisma.labDocWriteLog.findUnique({ where: { idempotencyKey } })
  if (existing) {
    if (existing.requestHash !== requestHash) return { kind: 'conflict', reason: 'hash_mismatch' }
    if (existing.status === 'DONE' && existing.responseJson !== null) {
      return { kind: 'replay', response: existing.responseJson }
    }
    return { kind: 'conflict', reason: 'in_progress' }
  }
  try {
    await prisma.labDocWriteLog.create({
      data: { idempotencyKey, requestHash, route, status: 'IN_PROGRESS', createdBy: userId },
    })
    return { kind: 'acquired' }
  } catch (e: unknown) {
    // 並發撞 unique key → 重讀判定（對方快咗就 replay/conflict）
    const code = (e as { code?: string })?.code
    if (code === 'P2002') {
      const again = await prisma.labDocWriteLog.findUnique({ where: { idempotencyKey } })
      if (again) {
        if (again.requestHash !== requestHash) return { kind: 'conflict', reason: 'hash_mismatch' }
        if (again.status === 'DONE' && again.responseJson !== null) {
          return { kind: 'replay', response: again.responseJson }
        }
      }
    }
    throw e
  }
}

export async function completeWriteLog(idempotencyKey: string, response: unknown): Promise<void> {
  await prisma.labDocWriteLog.update({
    where: { idempotencyKey },
    data: { status: 'DONE', responseJson: response as Prisma.InputJsonValue },
  })
}

/** 確定冇寫入（驗證失敗／transaction 已 rollback）→ 釋放 key，准同一 key 重試。只刪 IN_PROGRESS。 */
export async function releaseWriteLog(idempotencyKey: string): Promise<void> {
  await prisma.labDocWriteLog.deleteMany({ where: { idempotencyKey, status: 'IN_PROGRESS' } })
}
