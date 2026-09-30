// ============================================================
// 打卡請求：時限 + 網絡失敗自動重試（2026-09-30 Load failed 修正）
//   Safari 對 POST 唔會自動重試：轉網絡（4G ↔ Wi-Fi）後用返死連線就會 "Load failed"。
//   重試安全：/api/punch 有「今日已打呢種卡」檢查（tx 外 + tx 內鎖後）+ QRTokenUsage unique，
//   唔會打兩次。前端 abort 只係唔等，伺服器照做 → 第二次會被擋。
//   QR 碼掃到時剩 12–24 秒（+ 伺服器 60 秒寬限，見 qr-token.ts）：
//   GPS ≤3s + 6s + 0.5s → 第二次最遲 9.5s 送出，碼仍有效。
// ============================================================

/** ok = 已打卡；rejected = 伺服器拒絕（封鎖呢個碼）；retry = 網絡／伺服器暫時問題（唔封鎖碼） */
export type ScanOutcome = 'ok' | 'rejected' | 'retry'

export type PunchPost =
  | { kind: 'response'; res: Response; data: any; attempt: number }
  | { kind: 'network'; errName: string }

export const PUNCH_TIMEOUT_MS = 6000
export const PUNCH_ATTEMPTS = 2
export const PUNCH_RETRY_GAP_MS = 500

export interface PunchRetryOpts {
  timeoutMs?: number
  attempts?: number
  gapMs?: number
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>   // 測試用
}

export async function postPunchWithRetry(body: unknown, opts: PunchRetryOpts = {}): Promise<PunchPost> {
  const timeoutMs = opts.timeoutMs ?? PUNCH_TIMEOUT_MS
  const attempts = opts.attempts ?? PUNCH_ATTEMPTS
  const gapMs = opts.gapMs ?? PUNCH_RETRY_GAP_MS
  const doFetch = opts.fetchImpl ?? ((input: string, init: RequestInit) => fetch(input, init))
  let errName = 'UNKNOWN'

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await doFetch('/api/punch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        cache: 'no-store',
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      // ★ 時限包埋讀 body：回應讀到一半斷線都算網絡失敗
      const data = await res.json().catch(() => null)
      // ★ 200 但 body 唔完整 = 回應喺路上斷咗 → 當網絡失敗重試（第二次會回 ALREADY_PUNCHED → 前端查紀錄救返）
      if (res.ok && !data?.recordId) throw new Error('INCOMPLETE_RESPONSE')
      return { kind: 'response', res, data: data ?? {}, attempt }
    } catch (e: any) {
      // TypeError("Load failed") / AbortError（逾時）/ INCOMPLETE_RESPONSE
      errName = e?.name === 'AbortError' ? 'TIMEOUT' : String(e?.message || e?.name || 'UNKNOWN').slice(0, 60)
      if (attempt < attempts) await new Promise(r => setTimeout(r, gapMs))
    } finally {
      clearTimeout(timer)
    }
  }
  return { kind: 'network', errName }
}

/** 伺服器有回應但失敗：呢個碼仲用唔用得？
 *  5xx（app 500 已 rollback／Cloudflare 502 app 連唔到）同 BUSY（等鎖逾時、未寫入）→ 碼冇被食，唔封鎖。
 *  其餘（過期、無效、已打…）→ 封鎖，照舊等換碼。 */
export function failureOutcome(status: number, code?: string): ScanOutcome {
  if (status >= 500 || code === 'BUSY') return 'retry'
  return 'rejected'
}

/** 網絡斷咗之後，判斷某張卡係咪「今次」打嘅（容許電話時鐘偏差 60 秒） */
export function isRescueMatch(
  rec: { punchType?: string; punchTime?: string },
  type: string | null,
  scanStartedAt: number,
): boolean {
  if (!rec?.punchTime) return false
  if (type && rec.punchType !== type) return false
  return new Date(rec.punchTime).getTime() >= scanStartedAt - 60_000
}
