const LOCK_KEY = 776001
import { prisma } from '@/lib/prisma'

export async function withApricotLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const [{ locked }] = await prisma.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`
  if (!locked) {
    console.warn('[apricot] 已有 call 進行中，今次跳過')
    return null
  }
  try { return await fn() }
  finally { await prisma.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY})` }
}
