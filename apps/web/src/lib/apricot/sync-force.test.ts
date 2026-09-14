/**
 * cwm-syncforce-20260913 — syncClinicForJob force 模式 unit tests（node:test，全 mock，零 DB 零網絡）
 *
 * 覆蓋（驗收矩陣「sync 中途取消 → billsFetched 照回」+ force 語義，dev 無 Apricot key 無法真 E2E）：
 *   A. force=true + 拉 bill 中途 cancel → cancelled=true, billsFetched=10（前 10 張照拉），
 *      stats map 記到 10，upsertBill 被 call 10 次
 *   B. force=false 對照：existing bill 四條件全唔成立 → 12 張單 0 次 bill API call，
 *      拉完 bill 後 cancel → billsFetched=0（快取跳過 = 舊行為保持）
 *   C. 同一 jobId 兩間 clinic 累積 → stats map 10 + 10 = 20（job 跨 clinic 語義）
 *
 * Mock 策略（repo 慣例 + 實測限制）：
 *   - prisma models：Object.defineProperty monkey-patch（同 sync-availability-cache.test.ts）
 *   - Apricot API：patch global fetch + 真 `apricotCall` 流程
 *     （client.ts exports 係 esbuild getter-only 且 configurable:false — 實測 patch 唔到，
 *      所以行 global fetch 層；fake creds 用 throwaway AES key 加密入 fake externalCredential row）
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { prisma, basePrisma } from '../prisma'
import {
  syncClinicForJob,
  getBillFetchStats,
  _resetBillFetchStatsForTest,
} from './sync'

// ── fixtures ─────────────────────────────────────────────────────────
const BILL_IDS = Array.from({ length: 12 }, (_, i) => `B${i + 1}`)

const RAW_PAYMENT = {
  id: 'P1',
  code: 'PM-001',
  paymentTime: '2026-08-04T01:00:00.000Z',
  amt: 1200,
  isVoid: false,
  payerType: 'patient',
  paymentMethods: [{ paymentMethod: { code: 'CASH', des: 'Cash' }, amt: 1200, payType: 'cash' }],
  refList: BILL_IDS.map((b, i) => ({ billId: b, billCode: `BL-${i + 1}`, amt: 100 })),
}

function rawBillFor(billId: string) {
  return {
    id: billId,
    code: `BL-${billId}`,
    billTime: '2026-08-04T02:00:00.000Z',
    amt: 100,
    ttlAmt: 100,
    paidAmt: 100,
    osAmt: 0,
    isVoid: false,
    isRefunded: false,
    refundRefId: null,
    practitioner: { id: 'PR1' },
    clinic: { id: 'MF' },
    billDetails: [],
  }
}

// existing bill：2026-08-04（非本月）+ 1 小時前 sync 過（7 日內）→ 四條件全唔成立
function existingBill(extId: string) {
  return { extId, billTime: new Date('2026-08-04T02:00:00.000Z'), syncedAt: new Date(Date.now() - 3600_000) }
}

// ── fake Apricot creds（throwaway AES-256-GCM key，格式同 token.ts 嘅 enc()）──────────────
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
let billApiCalls = 0
let upsertBillCalls = 0
let cancelCalls = 0
let shouldCancelImpl: () => boolean = () => false

// ── fake fetch（apricotCall 層面）────────────────────────────────────
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
    findUnique: async () => ({ cancelRequested: shouldCancelImpl() }),
    update: async () => ({}),
  },
  apricotBill: {
    findUnique: async ({ where }: any) => existingBill(where.extId),
    upsert: async () => { upsertBillCalls++; return {} },
  },
  apricotPayment: { upsert: async () => ({}) },
  externalCredential: {
    findUnique: async () => FAKE_CREDS_ROW,
    update: async () => ({}),
  },
  // 呢三條 test 路径唔應該行到 allocation / sweep —— 真觸及即爆
  $transaction: async () => { throw new Error('test 唔應該行到 $transaction') },
  paymentAllocation: { findMany: async () => { throw new Error('test 唔應該行到 paymentAllocation') }, upsert: async () => { throw new Error('no') } },
  clinic: { findFirst: async () => { throw new Error('test 唔應該行到 clinic.findFirst') } },
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
    if (url.includes('/api/payments/search')) return fakeRes([RAW_PAYMENT])
    if (url.includes('/api/bills/')) {
      billApiCalls++
      return fakeRes(rawBillFor(url.split('/api/bills/')[1]))
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

beforeEach(() => {
  billApiCalls = 0
  upsertBillCalls = 0
  cancelCalls = 0
  _resetBillFetchStatsForTest()
})

const FROM = '2026-08-04T00:00:00.000Z'
const TO = '2026-08-04T23:59:59.000Z'
// ★ cwm-syncclinicid-20260914：入口加咗 24 位 hex ObjectId 防呆 → 測試 clinic id 要用 hex24。
//   舊版 'MF'/'TW' 係 dev E2E fixture 嘅 apricotClinicId 字面值，regex 【故意唔 loosen】收佢哋
//   （dev 對 MF/TW 嘅 sync job FAILED 係預期行為 — 見 MD 鐵律）。
const CLINIC_A = '695e6e491e430c48022a768a'
const CLINIC_B = '695e6e491e430c48022a768b'

describe('cwm-syncforce-20260913 syncClinicForJob force', () => {
  it('A: force=true 拉 bill 中途 cancel → billsFetched=10 照回 + stats map 記到', async () => {
    shouldCancelImpl = () => billApiCalls >= 10 // 拉咗 10 張先 cancel（billsChecked=10 嗰次 check 觸發）
    const r = await syncClinicForJob(CLINIC_A, FROM, TO, 'job-sf-a', true)
    assert.equal(r.cancelled, true)
    assert.equal(r.billsFetched, 10)
    assert.equal(r.billsChecked, 10)
    assert.equal(r.allocRows, 0)
    assert.equal(r.paymentsSynced, 1)
    assert.equal(billApiCalls, 10)
    assert.equal(upsertBillCalls, 10)
    assert.equal(getBillFetchStats('job-sf-a'), 10)
  })

  it('B: force=false 對照 — 四條件全唔成立 → 12 張單 0 次 bill API call, billsFetched=0', async () => {
    // cancel 次序：①page-loop ②拉完付款 ③upsert idx0 ④拉完 bill → 第 4 次返 true（行完 bill loop 先 cancel）
    shouldCancelImpl = () => ++cancelCalls >= 4
    const r = await syncClinicForJob(CLINIC_A, FROM, TO, 'job-sf-b', false)
    assert.equal(r.cancelled, true)
    assert.equal(r.billsFetched, 0)
    assert.equal(r.billsChecked, 12) // 12 張全部「檢查」咗
    assert.equal(billApiCalls, 0) // ★ 核心：force=false 一次 bill API 都唔 call（快取跳過保持）
    assert.equal(upsertBillCalls, 0)
    assert.equal(getBillFetchStats('job-sf-b'), 0) // 0 都要記錄（「行咗但 0 重拉」vs「無記錄」有分別）
  })

  it('C: 同一 jobId 兩間 clinic 累積 → stats map 10+10=20', async () => {
    shouldCancelImpl = () => billApiCalls >= 10
    const r1 = await syncClinicForJob(CLINIC_A, FROM, TO, 'job-sf-c', true)
    assert.equal(r1.billsFetched, 10)
    billApiCalls = 0 // 第二間 clinic 重新計
    shouldCancelImpl = () => billApiCalls >= 10
    const r2 = await syncClinicForJob(CLINIC_B, FROM, TO, 'job-sf-c', true)
    assert.equal(r2.billsFetched, 10) // 每次 call 嘅回傳係該 clinic 自己嘅數
    assert.equal(getBillFetchStats('job-sf-c'), 20) // map 係 job 級累積
  })
})
