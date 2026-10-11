/**
 * ★ 2026-10-11：讀單排隊位置（列表／單據頁顯示「排隊中 · 第 N 位」）。
 * 隊 = status UPLOADED，按 queuedAt（同 extract.ts 排隊 worker 一樣次序）。1 = 下一張讀。
 */
import { prisma } from '../prisma'

export async function labDocQueuePositions(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (ids.length === 0) return out
  const queue = await prisma.labDocument.findMany({
    where: { status: 'UPLOADED' },
    orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
    take: 500,
  })
  queue.forEach((d, i) => {
    if (ids.includes(d.id)) out.set(d.id, i + 1)
  })
  return out
}
