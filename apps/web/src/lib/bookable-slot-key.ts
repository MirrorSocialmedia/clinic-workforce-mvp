// ============================================================
// slotKey 不透明簽發字串 — providerslot-20260830 T1
//
// MD §三.1：「slotKey 係不透明字串，由服務端簽發並驗證。唔好讓 client
// 自己拼 — 否則可以偽造。」
//
// 格式：base64url(canonical) . base64url(HMAC-SHA256(secret, canonical))
//   canonical = `v1|clinicCode|date|startHHmm|providerId|unitMin`
//
// 防偽造：signature 用 timingSafeEqual 驗證；body 由服務端 decode +
// 再算 signature 對照 — client 改任何一個 char 都會 fail。
// 用途：claim 時驗證「呢個位確實係我哋喺 response 出過嘅」；重算
// offerable 係另一道獨立防線（簽真但位已滿 → 照樣 409）。
// ============================================================

import { createHmac, timingSafeEqual } from 'node:crypto'

export const SLOT_KEY_VERSION = 1

export interface SlotKeyParts {
  clinicCode: string
  date: string // YYYY-MM-DD
  start: string // HH:mm
  providerId: string // 本系統 Provider.id (cuid)
  unitMin: number
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/**
 * HMAC secret 來源（優先序）：
 *   1. BOOKABLE_SLOT_HMAC_SECRET（dedicated env — 生產部署應設定）
 *   2. JWT_SECRET（repo 現有 secret；本地 .env.local 已有）
 *   3. dev fallback 常量（只在兩者都無時 — 首次使用 loud warn）
 */
let devFallbackWarned = false
export function getSlotKeySecret(): string {
  const s = (process.env.BOOKABLE_SLOT_HMAC_SECRET || process.env.JWT_SECRET || '').trim()
  if (s) return s.replace(/^"|"$/g, '') // .env 值可能帶雙引號（repo 已知慣例）
  if (!devFallbackWarned) {
    devFallbackWarned = true
    console.warn('[bookable-slots] ⚠️ 無 BOOKABLE_SLOT_HMAC_SECRET / JWT_SECRET — 用 dev fallback secret（slotKey 可被偽造，限本地開發）')
  }
  return 'dev-only-slot-key-secret-do-not-use-in-prod'
}

export function canonicalize(parts: SlotKeyParts): string {
  return `v${SLOT_KEY_VERSION}|${parts.clinicCode}|${parts.date}|${parts.start}|${parts.providerId}|${parts.unitMin}`
}

function hmacBase64url(canonical: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(canonical, 'utf8').digest())
}

/** 簽發（GET response 逐 slot 用） */
export function signSlotKey(parts: SlotKeyParts): string {
  const canonical = canonicalize(parts)
  const body = base64url(Buffer.from(canonical, 'utf8'))
  return `${body}.${hmacBase64url(canonical, getSlotKeySecret())}`
}

/**
 * 驗證 + 解出 fields。偽造 / 壞格式 / 版本唔對 → null（route 層 400）。
 * 唔洩內部細節（唔分「簽名錯」同「格式錯」— 都係 forged key）。
 */
export function verifySlotKey(key: string): SlotKeyParts | null {
  if (typeof key !== 'string' || key.length < 8 || key.length > 512) return null
  const dot = key.indexOf('.')
  if (dot < 1) return null
  const bodyB64 = key.slice(0, dot)
  const sigB64 = key.slice(dot + 1)
  if (!/^[A-Za-z0-9_-]+$/.test(bodyB64) || !/^[A-Za-z0-9_-]+$/.test(sigB64)) return null

  let canonical: string
  try {
    canonical = fromBase64url(bodyB64).toString('utf8')
  } catch {
    return null
  }
  const m = canonical.match(/^v(\d+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|(\d+)$/)
  if (!m) return null
  const version = Number(m[1])
  const unitMin = Number(m[6])
  if (version !== SLOT_KEY_VERSION) return null
  if (unitMin !== 30) return null // 本 API 只出 30 分鐘位
  const date = m[3]
  const start = m[4]
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  if (!/^\d{2}:\d{2}$/.test(start) || Number(start.slice(3)) > 59) return null
  // 對齊 :00/:30（30 分鐘出位鐵律）
  const mm = Number(start.slice(3))
  if (mm !== 0 && mm !== 30) return null

  const expected = Buffer.from(hmacBase64url(canonical, getSlotKeySecret()), 'utf8')
  const actual = Buffer.from(sigB64, 'utf8')
  // 同長度先 timingSafeEqual
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null

  return { clinicCode: m[2], date, start, providerId: m[5], unitMin }
}
