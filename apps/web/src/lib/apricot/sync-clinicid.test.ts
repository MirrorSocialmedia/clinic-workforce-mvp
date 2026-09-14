/**
 * cwm-syncclinicid-20260914 — syncClinicForJob 入口防呆 unit tests（node:test，全 mock，零 DB 零網絡）
 *
 * 覆蓋（驗收矩陣 ★★ 行，dev 無 Apricot key 無法真 E2E）：
 *   A. 傳本地 cuid（08-04 事故 id cmrt63o2q000pqz01543wflo9）→ 即刻 APRICOT_BAD_CLINIC_ID，
 *      零 fetch（唔去到 Apricot → 冇返個好難讀嘅 500
 *      "invalid hexadecimal representation of an ObjectId"）
 *   B. hex24 + 正常範圍 → 兩個 guard 都 pass、行入真流程（payments/search mock 返空）→
 *      cancelled=false, paymentsSynced=0（證 hex24 唔係假陽性 reject）
 *   C. 大寫 hex24 + from===to → regex /i 收得 id guard，但被 C2 零長度 guard 攔
 *     （證兩個 guard 獨立、大寫 hex 亦收）
 *   D. from === to（同一個 ISO，模擬舊 backfill 純日期被當 UTC 午夜）→ APRICOT_BAD_DATE_RANGE 零長度
 *   E. 範圍倒轉（from > to）→ APRICOT_BAD_DATE_RANGE
 *
 * 鐵律（CEO/MD）：dev E2E MF/TW 嘅 apricotClinicId 係字面 MF/TW，唔係 hex24 →
 *   regex 【故意唔 loosen】收佢哋；dev 對 MF/TW 嘅 sync job FAILED 係預期行為唔係 regression。
 *
 * Mock 策略（repo 慣例，同 sync-force.test.ts）：
 *   - prisma models：Object.defineProperty monkey-patch
 *   - Apricot API：patch global fetch（client.ts exports 係 getter-only，patch 唔到）
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { prisma, basePrisma } from '../prisma'
import { syncClinicForJob } from './sync'

// 08-04 事故個 id（我哋本地 Clinic.id，cuid）
const CUID = 'cmrt63o2q000pqz01543wflo9'
// Apricot 24 位 hex ObjectId（MD 實例）
const HEX24 = '695e6e491e430c48022a768a'
const HEX24_UPPER = HEX24.toUpperCase()

// backfill 新格式（B 章）：成日範圍 ~0.999 日
const FROM = '2026-08-04T00:00:00+08:00'
const TO = '2026-08-04T23:59:59+08:00'

// ── fake Apricot creds（throwaway AES key，格式同 sync-force.test.ts）──────────────
const ENC_KEY = crypto.randomBytes(32)
function encCreds(plain: string) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
}
const FAKE_CREDS_ROW = {
  cipherText: encCreds(JSON.stringify({ accessToken: 'FAKE_AT', refreshToken: 'FAKE_RT', iat: '1755000000' })),
}

// ── counters ─────────────────────────────────────────────────────────
let fetchCalls = 0

// ── fake fetch（apricotCall 層面：payments/search 返空頁）────────────
function fakeRes(payload: any) {
  return {
    ok: true,
    status: 200,
    headers: { getSetCookie: () => [] as string[], get: () => null },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  } as any
}

// ── fakes ────────────────────────────────────────────────────────────
const fakes: Record<string, any> = {
  apricotSyncJob: {
    findUnique: async () => ({ cancelRequested: false }),
    update: async () => ({}),
  },
  // B 空數據路徑會行到呢三條
  apricotPaymentRef: { findMany: async () => [] },
  paymentMethodRule: { findMany: async () => [] },
  clinic: { findFirst: async () => ({ name: '測試診所' }) },
  externalCredential: {
    findUnique: async () => FAKE_CREDS_ROW,
    update: async () => ({}),
  },
  // 空 payments → 唔應該行到 bill / payment / allocation 寫入 —— 真觸及即爆
  apricotBill: { findUnique: async () => { throw new Error('test 唔應該行到 apricotBill') } },
  apricotPayment: { upsert: async () => { throw new Error('test 唔應該行到 apricotPayment') } },
  paymentAllocation: { findMany: async () => { throw new Error('no') }, upsert: async () => { throw new Error('no') } },
  $transaction: async () => { throw new Error('test 唔應該行到 $transaction') },
}

const realFetch = globalThis.fetch
const saved: [any, string, any][] = []

before(() => {
  process.env.APRICOT_ENC_KEY = ENC_KEY.toString('base64')
  for (const obj of [prisma, basePrisma]) {
    for (const k of Object.keys(fakes)) {
      saved.push([obj, k, (obj as any)[k]])
      Object.defineProperty(obj, k, { value: fakes[k], configurable: true, writable: true })
    }
  }
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    if (url.includes('/api/payments/search')) {
      fetchCalls++
      return fakeRes([])
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as any
})

after(() => {
  for (const [obj, k, orig] of saved) {
    Object.defineProperty(obj, k, { value: orig, configurable: true, writable: true })
  }
  globalThis.fetch = realFetch
  delete process.env.APRICOT_ENC_KEY
})

describe('cwm-syncclinicid-20260914 syncClinicForJob 入口防呆', () => {
  it('A: cuid → APRICOT_BAD_CLINIC_ID + 零 fetch（唔去到 Apricot）', async () => {
    fetchCalls = 0
    await assert.rejects(
      () => syncClinicForJob(CUID, FROM, TO, 'job-ci-a'),
      (e: any) => e.message.startsWith('APRICOT_BAD_CLINIC_ID') && e.message.includes(CUID),
    )
    assert.equal(fetchCalls, 0)
  })

  it('B: hex24 + 正常範圍 → 兩個 guard pass、行入真流程（空數據完整回傳）', async () => {
    fetchCalls = 0
    const r = await syncClinicForJob(HEX24, FROM, TO, 'job-ci-b')
    assert.equal(r.cancelled, false)
    assert.equal(r.paymentsSynced, 0)
    assert.equal(r.billsChecked, 0)
    assert.equal(r.billsFetched, 0)
    assert.equal(fetchCalls, 1) // 行咗 payments/search 真流程
  })

  it('C: 大寫 hex24 → id regex /i 收得（先至被 C2 零長度 guard 攔）', async () => {
    await assert.rejects(
      () => syncClinicForJob(HEX24_UPPER, FROM, FROM, 'job-ci-c'),
      (e: any) => e.message.startsWith('APRICOT_BAD_DATE_RANGE'),
    )
  })

  it('D: from === to → APRICOT_BAD_DATE_RANGE 零長度（今次純日期 bug 嘅直接模擬）', async () => {
    // 純日期 '2026-08-04' 被 new Date() 當 UTC 午夜 — 舊 backfill from/to 都係呢個值
    const T = '2026-08-04T08:00:00.000Z'
    await assert.rejects(
      () => syncClinicForJob(HEX24, T, T, 'job-ci-d'),
      (e: any) => e.message.startsWith('APRICOT_BAD_DATE_RANGE') && e.message.includes('零長度'),
    )
  })

  it('E: 範圍倒轉（from > to）→ APRICOT_BAD_DATE_RANGE', async () => {
    await assert.rejects(
      () => syncClinicForJob(HEX24, TO, FROM, 'job-ci-e'),
      (e: any) => e.message.startsWith('APRICOT_BAD_DATE_RANGE'),
    )
  })
})
