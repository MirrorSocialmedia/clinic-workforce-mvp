/**
 * ★ 2026-09-30：打卡時限 + 網絡失敗自動重試（punch-retry.ts）
 *   規格 §10.1 表列 10 情境逐項。fetchImpl 注入 mock（timeoutMs: 50、gapMs: 0），
 *   mock 回應用 new Response(body, { status })。
 * 跑法: TZ=UTC npx tsx --test src/lib/punch-retry.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { postPunchWithRetry, failureOutcome, isRescueMatch, PUNCH_TIMEOUT_MS, PUNCH_ATTEMPTS, PUNCH_RETRY_GAP_MS } from './punch-retry'

const FAST = { timeoutMs: 50, gapMs: 0 } as const

/** 永遠唔 resolve；signal abort 時 reject AbortError（同真 fetch 逾時行為） */
function hangingFetch() {
  let count = 0
  const fetchImpl = (_url: string, init: any) => {
    count++
    return new Promise((_resolve, reject) => {
      const onAbort = () => {
        const e = new Error('The operation was aborted')
        e.name = 'AbortError'
        reject(e)
      }
      if (init.signal?.aborted) { onAbort(); return }
      init.signal?.addEventListener('abort', onAbort)
    })
  }
  return { fetchImpl, count: () => count }
}

describe('postPunchWithRetry（§10.1 #1–8）', () => {
  it('#1 第 1 次 Load failed、第 2 次 200 → attempt 2 + recordId', async () => {
    let n = 0
    const out = await postPunchWithRetry({ x: 1 }, {
      ...FAST,
      fetchImpl: async () => {
        n++
        if (n === 1) throw new TypeError('Load failed')
        return new Response(JSON.stringify({ success: true, recordId: 'r1' }), { status: 200 })
      },
    })
    assert.equal(n, 2)
    assert.equal(out.kind, 'response')
    if (out.kind === 'response') {
      assert.equal(out.attempt, 2)
      assert.equal(out.data.recordId, 'r1')
    }
  })

  it('#2 兩次都 Load failed → kind network、errName 保留、fetch 剛好 2 次', async () => {
    let n = 0
    const out = await postPunchWithRetry({ x: 1 }, {
      ...FAST,
      fetchImpl: async () => { n++; throw new TypeError('Load failed') },
    })
    assert.equal(n, 2)
    assert.equal(out.kind, 'network')
    if (out.kind === 'network') assert.equal(out.errName, 'Load failed')
  })

  it('#3 第 1 次永遠唔 resolve（abort 時 reject）、第 2 次 200 → attempt 2', async () => {
    const hang = hangingFetch()
    let n = 0
    const out = await postPunchWithRetry({ x: 1 }, {
      ...FAST,
      fetchImpl: async (url, init) => {
        n++
        if (n === 1) return hang.fetchImpl(url, init)
        return new Response(JSON.stringify({ success: true, recordId: 'r2' }), { status: 200 })
      },
    })
    assert.equal(hang.count(), 1)
    assert.equal(out.kind, 'response')
    if (out.kind === 'response') assert.equal(out.attempt, 2)
  })

  it('#4 兩次都逾時 → kind network、errName TIMEOUT', async () => {
    const hang = hangingFetch()
    const out = await postPunchWithRetry({ x: 1 }, { ...FAST, fetchImpl: hang.fetchImpl })
    assert.equal(hang.count(), 2)
    assert.equal(out.kind, 'network')
    if (out.kind === 'network') assert.equal(out.errName, 'TIMEOUT')
  })

  it('#5 第 1 次 400 {code: EXPIRED} → 唔重試（fetch 1 次、attempt 1）', async () => {
    let n = 0
    const out = await postPunchWithRetry({ x: 1 }, {
      ...FAST,
      fetchImpl: async () => {
        n++
        return new Response(JSON.stringify({ code: 'EXPIRED', error: 'QR 碼已過期' }), { status: 400 })
      },
    })
    assert.equal(n, 1)
    assert.equal(out.kind, 'response')
    if (out.kind === 'response') assert.equal(out.attempt, 1)
  })

  it('#6 第 1 次 500 → 唔重試（fetch 1 次）', async () => {
    let n = 0
    const out = await postPunchWithRetry({ x: 1 }, {
      ...FAST,
      fetchImpl: async () => {
        n++
        return new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
      },
    })
    assert.equal(n, 1)
    assert.equal(out.kind, 'response')
    if (out.kind === 'response') {
      assert.equal(out.attempt, 1)
      assert.equal(out.res.status, 500)
    }
  })

  it('#7 第 1 次 200 但 body 唔係 JSON、第 2 次 400 ALREADY_PUNCHED → attempt 2 + data.code', async () => {
    let n = 0
    const out = await postPunchWithRetry({ x: 1 }, {
      ...FAST,
      fetchImpl: async () => {
        n++
        if (n === 1) return new Response('<html>truncated', { status: 200 })
        return new Response(JSON.stringify({ code: 'ALREADY_PUNCHED', error: '今日已打過呢種卡' }), { status: 400 })
      },
    })
    assert.equal(n, 2)
    assert.equal(out.kind, 'response')
    if (out.kind === 'response') {
      assert.equal(out.attempt, 2)
      assert.equal(out.data.code, 'ALREADY_PUNCHED')
    }
  })

  it('#8 第 1 次 502 HTML → 唔重試；data = {}', async () => {
    let n = 0
    const out = await postPunchWithRetry({ x: 1 }, {
      ...FAST,
      fetchImpl: async () => {
        n++
        return new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })
      },
    })
    assert.equal(n, 1)
    assert.equal(out.kind, 'response')
    if (out.kind === 'response') assert.deepEqual(out.data, {})
  })
})

describe('failureOutcome（§10.1 #9）', () => {
  it('5xx / BUSY → retry；其餘 → rejected', () => {
    assert.equal(failureOutcome(500), 'retry')
    assert.equal(failureOutcome(502), 'retry')
    assert.equal(failureOutcome(409, 'BUSY'), 'retry')
    assert.equal(failureOutcome(409, 'ALREADY_USED'), 'rejected')
    assert.equal(failureOutcome(400, 'EXPIRED'), 'rejected')
    assert.equal(failureOutcome(403), 'rejected')
  })
})

describe('isRescueMatch（§10.1 #10）', () => {
  const start = 1_000_000_000_000
  it('同類型且 ≥ 開始−60s → true', () => {
    assert.equal(isRescueMatch({ punchType: 'CLOCK_IN', punchTime: new Date(start + 5_000).toISOString() }, 'CLOCK_IN', start), true)
    // 剛好差 60 秒（時鐘偏差容許範圍）→ 仍然 true
    assert.equal(isRescueMatch({ punchType: 'CLOCK_IN', punchTime: new Date(start - 60_000).toISOString() }, 'CLOCK_IN', start), true)
  })
  it('類型唔同 → false', () => {
    assert.equal(isRescueMatch({ punchType: 'CLOCK_OUT', punchTime: new Date(start + 5_000).toISOString() }, 'CLOCK_IN', start), false)
  })
  it('早過開始−60s → false', () => {
    assert.equal(isRescueMatch({ punchType: 'CLOCK_IN', punchTime: new Date(start - 61_000).toISOString() }, 'CLOCK_IN', start), false)
  })
  it('冇 punchTime → false', () => {
    assert.equal(isRescueMatch({ punchType: 'CLOCK_IN' }, 'CLOCK_IN', start), false)
    assert.equal(isRescueMatch({ punchTime: '' }, 'CLOCK_IN', start), false)
  })
})

describe('常數（守衛：唔好静默改重試參數）', () => {
  it('預設 = 規格值', () => {
    assert.equal(PUNCH_TIMEOUT_MS, 6000)
    assert.equal(PUNCH_ATTEMPTS, 2)
    assert.equal(PUNCH_RETRY_GAP_MS, 500)
  })
})
