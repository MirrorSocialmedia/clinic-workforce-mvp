export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { basePrisma } from '@/lib/prisma'
import { hkDateStart, hkDateEnd, todayHK } from '@/lib/hk-date'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/external/duty-roster — 外部當值狹窄 API（wa-clinic-inbox 專用）
// Phase 4（MD §9.2）：clinic-workforce ↔ wa-inbox 唯一外部讀通道。
//
//   GET /api/external/duty-roster?clinicId=<clinic cuid 或 shortName 代號>&date=YYYY-MM-DD
//   Header: X-Api-Key: <EXTERNAL_DUTY_API_KEY>
//
// Auth（fail-closed，兩層都要過）：
//   1) 來源 IP ∈ EXTERNAL_API_ALLOWED_IPS（comma-separated，預設 127.0.0.1）→ 唔喺內 403
//   2) X-Api-Key 同 EXTERNAL_DUTY_API_KEY timing-safe 相等 → 冇設/唔對 401
//   次序 IP 先、key 後：allowlist 以外嘅 IP 永遠只會見到 403，
//   無法透過回應差異探測 key 啱唔啱（唔洩漏邊層）。
//   兩層失敗 body 一樣：{ error: "unauthorized" }（只有 status code 分 401/403）。
//
// 回覆白名單（PII 鐵律 — 只准四欄）：
//   [{ staffName, role, shiftStart: "HH:MM", shiftEnd: "HH:MM" }]
//   冇 id、冇 payroll、冇打卡、冇 email/phone。無當值 → 200 []。
//   clinicId 唔存在 → 404 { error: "not_found" }。
//
// 數據源（全部跟現有「某日某店班表」慣例，有先回、唔硬造）：
//   - Shift（員工）：status != CANCELLED（同 /api/my/schedule 口徑）
//     staffName = employee.user.name；role = shift.role（Doctor/Nurse/Receptionist…）
//   - ProviderShift（醫生）：staffName = provider.name；role = "Doctor"
//   同一人當日兩班（早+午）會合併成一行（min start / max end）。
//   date 用 HK 時區（hkDateStart/hkDateEnd），缺省 = 今日（todayHK）。
//
// Audit（metadata only — 冇員工 PII，action 已登記 sensitive-audit.ts EXEMPT）：
//   200     → EXTERNAL_DUTY_ROSTER_READ        { clinicId, date, count }
//   401/403 → EXTERNAL_DUTY_ROSTER_AUTH_FAIL   { reason: ip_denied|key_invalid } + ip
//
// 防 abuse：每 key（冇 key 就每 IP）每分鐘 ≤ 60 calls → 429（in-memory，重啟即清）。
// 呢把 key 只對呢條 route 有效 — 唔入 JWT/RBAC，無法過任何現有 auth。
// ============================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const RATE_LIMIT_PER_MIN = 60
const AUDIT_ENTITY = 'ExternalDutyRoster'

// ── 來源 IP（跟 require-auth.ts 慣例：Cloudflare 優先）────────────
function clientIp(req: NextRequest): string {
  let ip = (req.headers.get('cf-connecting-ip')
    || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || 'unknown')
  // IPv4-mapped IPv6（dual-stack VPS 上常見 ::ffff:127.0.0.1）→ 正規化，allowlist 先匹配到
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7)
  return ip
}

// ── IP allowlist（跟 KIOSK checkIpAllowlist 語義：exact 或 prefix）──
function ipAllowed(ip: string): boolean {
  // 預設 127.0.0.1（只准本機）；explicit 設咗但係空 = deny all（ops kill switch）
  const raw = process.env.EXTERNAL_API_ALLOWED_IPS
  const rules = (raw === undefined || raw.trim() === '' ? '127.0.0.1' : raw)
    .split(',').map(s => s.trim()).filter(Boolean)
  return rules.some(rule => ip === rule || ip.startsWith(rule))
}

// ── API key（timing-safe；先 sha256 消化避免長度洩漏）──────────────
function keyValid(provided: string | null): boolean {
  const expected = process.env.EXTERNAL_DUTY_API_KEY
  if (!provided || !expected) return false // env 冇設 = fail-closed 401
  const a = createHash('sha256').update(provided, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

// ── In-memory rate limit：每 key/分鐘 ≤ 60（冇 key 就按 IP 計）─────
// key 存 sha256 摘要（唔好 plaintext 落記憶體）；bucket 按分鐘窗口。
const rateBuckets = new Map<string, { minute: number; count: number }>()
function rateLimitKey(providedKey: string | null, ip: string): string {
  const raw = providedKey && providedKey.length > 0 ? `k:${providedKey}` : `ip:${ip}`
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}
function isRateLimited(bucketKey: string): boolean {
  const minute = Math.floor(Date.now() / 60000)
  let b = rateBuckets.get(bucketKey)
  if (!b || b.minute !== minute) {
    b = { minute, count: 0 }
    rateBuckets.set(bucketKey, b)
  }
  b.count += 1
  // 順手清理舊 bucket，防 map 無限生長
  if (rateBuckets.size > 1000) {
    for (const [k, v] of rateBuckets) if (v.minute < minute - 5) rateBuckets.delete(k)
  }
  return b.count > RATE_LIMIT_PER_MIN
}

// ── Audit（metadata only；失败唔阻讀回應，console 記錄跟進）────────
async function writeExternalAudit(args: {
  action: 'EXTERNAL_DUTY_ROSTER_READ' | 'EXTERNAL_DUTY_ROSTER_AUTH_FAIL'
  entityId: string
  clinicId?: string | null
  notes: Record<string, unknown>
  ip: string
  ua: string
}): Promise<void> {
  try {
    await basePrisma.auditLog.create({
      data: {
        actorId: null, // 外部系統呼叫，冇 session user
        action: args.action,
        entity: AUDIT_ENTITY,
        entityId: args.entityId,
        clinicId: args.clinicId ?? null,
        notes: JSON.stringify(args.notes),
        ipAddress: args.ip,
        userAgent: args.ua.slice(0, 200) || null,
      },
    })
  } catch (e) {
    console.error('[external/duty-roster] audit write failed', e)
  }
}

// ── HK 時區 HH:MM（formatter 只建一次）───────────────────────────
const HK_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Hong_Kong',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

type DutyRow = {
  staffName: string
  role: string | null
  start: Date
  end: Date
}

export async function GET(req: NextRequest) {
  const ip = clientIp(req)
  const ua = req.headers.get('user-agent') ?? ''
  const providedKey = req.headers.get('x-api-key')

  // 0) Rate limit（auth 之前 — 防 key 撞爆/探測洪水）
  if (isRateLimited(rateLimitKey(providedKey, ip))) {
    return jsonNoStore({ error: 'rate_limited' }, { status: 429 })
  }

  // 1) IP allowlist（先查 — 外面 IP 永遠見 403，唔知 key 啱唔啱）
  if (!ipAllowed(ip)) {
    await writeExternalAudit({
      action: 'EXTERNAL_DUTY_ROSTER_AUTH_FAIL',
      entityId: 'auth_fail',
      notes: { reason: 'ip_denied' },
      ip,
      ua,
    })
    return jsonNoStore({ error: 'unauthorized' }, { status: 403 })
  }

  // 2) API key（timing-safe）
  if (!keyValid(providedKey)) {
    await writeExternalAudit({
      action: 'EXTERNAL_DUTY_ROSTER_AUTH_FAIL',
      entityId: 'auth_fail',
      notes: { reason: 'key_invalid' },
      ip,
      ua,
    })
    return jsonNoStore({ error: 'unauthorized' }, { status: 401 })
  }

  // 3) 參數
  const params = new URL(req.url).searchParams
  const clinicId = params.get('clinicId')
  if (!clinicId) {
    return jsonNoStore({ error: 'bad_request' }, { status: 400 })
  }
  const dateStr = params.get('date') ?? todayHK() // 缺省 = 今日（HK）
  if (!DATE_RE.test(dateStr)) {
    return jsonNoStore({ error: 'bad_request' }, { status: 400 })
  }

  // 4) 搵 clinic — clinicId 接受 cuid（主）或 shortName 店代號（旺/仁/銅/荃/元/沙）
  const clinic = await basePrisma.clinic.findFirst({
    where: { OR: [{ id: clinicId }, { shortName: clinicId }] },
    select: { id: true },
  })
  if (!clinic) {
    return jsonNoStore({ error: 'not_found' }, { status: 404 })
  }

  // 5) 當日班表（HK 日期範圍；Shift 剔走 CANCELLED，同 /api/my/schedule 口徑）
  const dayStart = hkDateStart(dateStr)
  const dayEnd = hkDateEnd(dateStr)
  const [empShifts, providerShifts] = await Promise.all([
    basePrisma.shift.findMany({
      where: {
        clinicId: clinic.id,
        date: { gte: dayStart, lte: dayEnd },
        status: { not: 'CANCELLED' },
      },
      select: {
        startTime: true,
        endTime: true,
        role: true,
        employee: { select: { id: true, user: { select: { name: true } } } },
      },
      orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
    }),
    basePrisma.providerShift.findMany({
      where: {
        clinicId: clinic.id,
        date: { gte: dayStart, lte: dayEnd },
      },
      select: {
        startTime: true,
        endTime: true,
        provider: { select: { id: true, name: true } },
      },
      orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
    }),
  ])

  // 6) 合併同一人當日多班 → 一行（min start / max end；role 取第一非空）
  const byPerson = new Map<string, DutyRow>()
  for (const s of empShifts) {
    const name = s.employee?.user?.name
    if (!name) continue
    const key = `e:${s.employee.id}`
    const cur = byPerson.get(key)
    if (!cur) {
      byPerson.set(key, { staffName: name, role: s.role ?? null, start: s.startTime, end: s.endTime })
    } else {
      if (s.startTime < cur.start) cur.start = s.startTime
      if (s.endTime > cur.end) cur.end = s.endTime
      if (!cur.role && s.role) cur.role = s.role
    }
  }
  for (const s of providerShifts) {
    const name = s.provider?.name
    if (!name) continue
    const key = `p:${s.provider.id}`
    const cur = byPerson.get(key)
    if (!cur) {
      byPerson.set(key, { staffName: name, role: 'Doctor', start: s.startTime, end: s.endTime })
    } else {
      if (s.startTime < cur.start) cur.start = s.startTime
      if (s.endTime > cur.end) cur.end = s.endTime
    }
  }

  const rows = [...byPerson.values()]
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map(r => ({
      staffName: r.staffName,
      role: r.role,
      shiftStart: HK_TIME_FMT.format(r.start),
      shiftEnd: HK_TIME_FMT.format(r.end),
    }))

  // 7) Audit（metadata only：clinic cuid + date + count + ip — 冇員工 PII）
  await writeExternalAudit({
    action: 'EXTERNAL_DUTY_ROSTER_READ',
    entityId: `${clinic.id}|${dateStr}`,
    clinicId: clinic.id,
    notes: { clinicId: clinic.id, date: dateStr, count: rows.length },
    ip,
    ua,
  })

  return jsonNoStore(rows)
}
