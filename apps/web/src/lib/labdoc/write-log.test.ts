/**
 * cwm-labdoc P2 — §7.8 冪等（T4 相鄰）：LabDocWriteLog unit
 *
 *  - 新 key → acquired
 *  - 同 key 同 hash DONE → replay 舊 response
 *  - 同 key 唔同 hash → conflict hash_mismatch
 *  - IN_PROGRESS（上次做到一半）→ conflict in_progress（保守：唔重放）
 *  - 並發 P2002 → 重讀判定（replay / conflict）
 *  - stableRequestHash：key 順序唔敏感
 */
import assert from 'node:assert'
import { test, before, after } from 'node:test'
import { prisma } from '../prisma'
import { acquireWriteLog, completeWriteLog, releaseWriteLog, stableRequestHash } from './write-log'

const KEYS = ['labDocWriteLog', '$transaction'] as const
const saved: Record<string, unknown> = {}
for (const k of KEYS) saved[k] = (prisma as any)[k]

interface Row {
  idempotencyKey: string
  requestHash: string
  status: string
  responseJson: unknown
}

let store: Map<string, Row>
let createThrow: { code: string } | null

function install() {
  store = new Map()
  createThrow = null
  const fake = {
    findUnique: async ({ where }: any) => store.get(where.idempotencyKey) ?? null,
    create: async ({ data }: any) => {
      if (createThrow) throw createThrow
      store.set(data.idempotencyKey, { ...data })
      return store.get(data.idempotencyKey)
    },
    update: async ({ where, data }: any) => {
      const row = store.get(where.idempotencyKey)
      if (!row) throw { code: 'P2025' }
      Object.assign(row, data)
      return row
    },
    deleteMany: async ({ where }: any) => {
      const row = store.get(where.idempotencyKey)
      if (row && (!where.status || row.status === where.status)) {
        store.delete(where.idempotencyKey)
        return { count: 1 }
      }
      return { count: 0 }
    },
  }
  for (const k of KEYS) {
    Object.defineProperty(prisma, k, { value: k === '$transaction' ? saved[k] : (fake as any), configurable: true, writable: true })
  }
}

before(() => install())
after(() => {
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
})

const H1 = stableRequestHash({ a: 1, b: 'x' })
const H2 = stableRequestHash({ a: 1, b: 'y' })

test('T4 相鄰：新 key → acquired；complete 後同 key 同 hash → replay 舊 response', async () => {
  install()
  const r1 = await acquireWriteLog('key-1', '/save', H1, 'u')
  assert.deepStrictEqual(r1, { kind: 'acquired' })

  await completeWriteLog('key-1', { ok: true, costCaseId: 'cc' })

  // 第二次同 key 同 hash（客戶端重發同一請求）→ replay
  const r2 = await acquireWriteLog('key-1', '/save', H1, 'u')
  assert.strictEqual(r2.kind, 'replay')
  if (r2.kind === 'replay') assert.deepStrictEqual(r2.response, { ok: true, costCaseId: 'cc' })

  // 同 key 但內容改咗 → 409 資料
  const r3 = await acquireWriteLog('key-1', '/save', H2, 'u')
  assert.deepStrictEqual(r3, { kind: 'conflict', reason: 'hash_mismatch' })
})

test('T4 相鄰：IN_PROGRESS（上次做到一半）→ conflict in_progress（唔重放）', async () => {
  install()
  await acquireWriteLog('key-2', '/save', H1, 'u')
  // 唔 complete（模擬 process 死咗／做到一半）
  const r = await acquireWriteLog('key-2', '/save', H1, 'u')
  assert.deepStrictEqual(r, { kind: 'conflict', reason: 'in_progress' })
})

test('T4 相鄰：並發 P2002（對方快咗寫）→ 重讀判定 replay', async () => {
  install()
  // 模擬：findUnique 第一次搵唔到，create 撞 unique key，重讀搵到 DONE 行
  store.set('key-3', { idempotencyKey: 'key-3', requestHash: H1, status: 'DONE', responseJson: { n: 1 } })
  const origFind = (prisma as any).labDocWriteLog.findUnique
  ;(prisma as any).labDocWriteLog.findUnique = async ({ where }: any) => {
    if (!origFind.__called) {
      origFind.__called = true
      return null // 第一次：仲冇
    }
    return origFind({ where })
  }
  ;(prisma as any).labDocWriteLog.create = async ({ data }: any) => {
    throw { code: 'P2002' }
  }
  const r = await acquireWriteLog('key-3', '/save', H1, 'u')
  assert.strictEqual(r.kind, 'replay')
  if (r.kind === 'replay') assert.deepStrictEqual(r.response, { n: 1 })
})

test('releaseWriteLog：確定冇寫入 → 同 key 可以再 acquire；DONE 行唔會被刪', async () => {
  install()
  await acquireWriteLog('key-4', '/save', H1, 'u')
  await releaseWriteLog('key-4')
  assert.deepStrictEqual(await acquireWriteLog('key-4', '/save', H1, 'u'), { kind: 'acquired' })
  await completeWriteLog('key-4', { ok: 1 })
  await releaseWriteLog('key-4')
  const r = await acquireWriteLog('key-4', '/save', H1, 'u')
  assert.strictEqual(r.kind, 'replay')
})

test('stableRequestHash：key 順序唔敏感', () => {
  assert.strictEqual(stableRequestHash({ a: 1, b: { d: 2, c: 3 } }), stableRequestHash({ b: { c: 3, d: 2 }, a: 1 }))
  assert.notStrictEqual(stableRequestHash({ a: 1 }), stableRequestHash({ a: 2 }))
})
