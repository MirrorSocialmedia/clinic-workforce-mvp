export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import {
  requireExternalKey,
  withExternalAudit,
  ExternalApiError,
  isValidDateStr,
  takeRefreshToken,
} from '@/lib/external-api'
import { runAvailabilityCacheSync } from '@/lib/apricot/sync-availability-cache'
import { basePrisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { resolveClinic } from '@/app/api/external/v1/bookings/guards'

// ============================================================
// POST /api/external/v1/availability/refresh — 強制刷新空檔 cache
// cwi-refresh-20260831 §2（方案 C · F 側）
//
//   Body: { clinicCode: string, dates: string[] }  // 1–7 個 YYYY-MM-DD
//   Header: X-Api-Key（scope: availability — 沿用，唔開新 scope）
//
//   200: { v:1, refreshed:[{ date, ok, syncedAt? , error? }], durationMs }
//   400: body/日期格式錯（dates > 7 都係 400）
//   404: 未知 clinicCode（CLINIC_NOT_FOUND）
//   429: 該 clinic 60 秒內已刷新過 { error, code, retryAfterSec }
//   409: APRICOT_BUSY — advisory lock 被另一 Apricot call 佔住，
//        唔排隊唔 hang，叫 caller 遲啲再試
//
// 實現要點（MD §2 逐條）：
//   - 逐日 call runAvailabilityCacheSync({ clinicId, dateOnly }) —
//     單日 mode 自帶 withApricotLock（pg_try_advisory_lock 非阻塞），
//     呢度唔自己寫任何同步邏輯。
//   - 限流：takeRefreshToken（capacity 1 / refill 1 per 60s），bucket
//     key 用 *resolved clinic id*（防 shortName/cuid 別名繞過）。
//   - 逐日獨立 try/catch：普通失敗 → 該日 ok:false + error code，
//     唔阻其餘日；lock busy 係全級條件（同一把 global advisory lock）
//     → 首次撞即 409 返，唔使逐日撞。
//   - 零 PII：response + audit notes 只有日期/ok/error code，
//     冇任何病人/電話/姓名。
//   - 落 AuditLog（action EXTERNAL_AVAILABILITY_REFRESH — 見
//     sensitive-audit.ts EXEMPT 分類）；ExternalApiAudit 由
//     withExternalAudit 自動落（keyName/path/status/latencyMs）。
//   - 🔴 唔准開放全店/全期間刷新：dates 必填、上限 7。
// ============================================================

const MAX_DATES = 7

/** runAvailabilityCacheSync 單日 mode lock busy 時嘅 throw 訊息特徵 */
const LOCK_BUSY_RE = /another apricot call in progress/

/** 逐日失敗 → 短 error code（🔴 零 PII：只提取 UPPER_SNAKE code，唔帶 message 內容） */
function syncErrorCode(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  const code = /^([A-Z][A-Z0-9_]{2,})(?::|$)/.exec(m)
  return code ? code[1] : 'SYNC_FAILED'
}

export async function POST(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/availability/refresh', async (ctx) => {
    const key = await requireExternalKey(req, 'availability')
    ctx.setKey(key.name)

    // ── body 驗證（400）────────────────────────────────────────
    let body: unknown
    try {
      body = await req.json()
    } catch {
      throw new ExternalApiError(400, 'invalid JSON body', 'BAD_REQUEST')
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ExternalApiError(400, 'object body required', 'BAD_REQUEST')
    }
    const b = body as Record<string, unknown>
    const clinicCode = typeof b.clinicCode === 'string' ? b.clinicCode.trim() : ''
    if (!clinicCode) {
      throw new ExternalApiError(400, 'clinicCode required', 'BAD_REQUEST')
    }
    if (!Array.isArray(b.dates) || b.dates.length === 0 || b.dates.length > MAX_DATES) {
      throw new ExternalApiError(400, `dates: 1-${MAX_DATES} required`, 'BAD_REQUEST')
    }
    for (const d of b.dates) {
      if (typeof d !== 'string' || !isValidDateStr(d)) {
        throw new ExternalApiError(400, 'invalid date (YYYY-MM-DD)', 'BAD_REQUEST')
      }
    }
    // 去重（保留原始順序）— 同日期 sync 兩次冇意義
    const dates = [...new Set(b.dates as string[])]

    // ── clinicCode → clinicId（404；無 Apricot mapping → 400）──
    const clinic = await resolveClinic(clinicCode)

    // ── 限流：每 clinic 每 60 秒 1 次（攞唔到唔排隊）───────────
    const rl = takeRefreshToken(clinic.id)
    if (!rl.ok) {
      throw new ExternalApiError(429, 'rate limited', 'RATE_LIMITED', {
        retryAfterSec: rl.retryAfterSec,
      })
    }

    // ── 逐日 sync（單日 mode 自帶 lock；唔自己寫同步邏輯）──────
    const t0 = Date.now()
    const refreshed: Array<{ date: string; ok: boolean; syncedAt?: string; error?: string }> = []
    let lockBusy = false
    for (const date of dates) {
      try {
        const res = await runAvailabilityCacheSync({ clinicId: clinic.id, dateOnly: date })
        refreshed.push({ date, ok: true, syncedAt: res.syncedAt })
      } catch (e) {
        if (e instanceof Error && LOCK_BUSY_RE.test(e.message)) {
          // global advisory lock 被佔（另一 Apricot call 進行中）—
          // 全級條件，繼續逐日撞只會全部 busy → 409 止損
          lockBusy = true
          break
        }
        refreshed.push({ date, ok: false, error: syncErrorCode(e) })
      }
    }
    const durationMs = Date.now() - t0

    // ── audit（🔴 零 PII：只記 dates + 逐日 ok/error code）────
    // 409 path 都落（partial results 入 notes），fire-and-forget。
    basePrisma.auditLog
      .create({
        data: {
          actorId: null, // external key / system — 冇 workforce User（keyName 喺 ExternalApiAudit）
          action: 'EXTERNAL_AVAILABILITY_REFRESH',
          entity: 'AvailabilityCache',
          entityId: clinic.id,
          clinicId: clinic.id,
          notes: JSON.stringify({
            dates,
            results: refreshed.map((r) => ({
              date: r.date,
              ok: r.ok,
              ...(r.error ? { error: r.error } : {}),
            })),
            ...(lockBusy ? { lockBusy: true } : {}),
          }),
        },
      })
      .catch((err) => console.error('[availability-refresh] audit 寫入失敗', err))

    if (lockBusy) {
      throw new ExternalApiError(409, 'APRICOT_BUSY', 'APRICOT_BUSY')
    }

    return jsonNoStore({ v: 1, refreshed, durationMs })
  })
}
