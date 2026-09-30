// ============================================================
// ★ 2026-09-30 C2：網絡失敗證據 → 自動開「待批補登」
//   問題：網絡令員工 09:59 掃咗碼打唔到、10:01 先入庫 → 遲到 1 分（遲到零寬限）。
//   證據：手機記低第一次掃到嘅 QR（firstToken）。QR 只喺 iPad 螢幕出現 → 伺服器核實咗個碼係同一間診所、
//        啱啱先發出，就證明員工嗰個 24 秒窗口真係企喺 iPad 前面（偽造難度同打卡本身一樣）。
//   時間：客戶端聲稱嘅時間只准喺 [issuedAt, min(expiresAt, punchTime)] 入面移動 —— 最多郁 24 秒。
//   結果：PENDING 補登，經理一撳批核。punchTime 本身唔改（伺服器時間原則不變）。
//   只做 CLOCK_IN / LUNCH_END（遲咗入庫會蝕底嘅類型）。任何錯誤都唔影響打卡（caller try/catch）。
// ============================================================
import { prisma } from './prisma'
import { toHKDateStr, hkDateStart, hkDateEnd, fmtTime } from './hk-date'

export const EVIDENCE_WINDOW_MS = 10 * 60_000   // firstToken 要喺打卡前 10 分鐘內發出
export const EVIDENCE_MIN_GAP_MS = 60_000       // 差唔夠 1 分鐘唔影響遲到，唔使開單

/** 純函數：將客戶端聲稱嘅時間夾喺伺服器證實嘅窗口入面 */
export function evidenceTime(issuedAt: number, expiresAt: number, punchTime: number, claimed: unknown): number {
  const lo = issuedAt
  const hi = Math.max(lo, Math.min(expiresAt, punchTime))
  const c = typeof claimed === 'number' && Number.isFinite(claimed) ? claimed : lo
  return Math.min(hi, Math.max(lo, c))
}

export async function maybeCreateNetworkCorrection(a: {
  employeeId: string
  clinicId: string
  recordId: string
  punchType: string
  punchTime: Date
  firstToken: unknown
  firstScanAt: unknown
  userId: string
}): Promise<Date | null> {
  if (a.punchType !== 'CLOCK_IN' && a.punchType !== 'LUNCH_END') return null
  if (typeof a.firstToken !== 'string' || a.firstToken.trim() === '') return null
  const raw = a.firstToken.trim()
  const pt = a.punchTime.getTime()

  const tok = await prisma.qRToken.findFirst({
    where: {
      clinicId: a.clinicId,
      OR: [{ token: raw }, { shortCode: raw.toUpperCase() }],
      issuedAt: { gte: new Date(pt - EVIDENCE_WINDOW_MS), lte: a.punchTime },
    },
    orderBy: { issuedAt: 'desc' },
    select: { id: true, issuedAt: true, expiresAt: true },
  })
  if (!tok) return null

  const at = new Date(evidenceTime(tok.issuedAt.getTime(), tok.expiresAt.getTime(), pt, a.firstScanAt))
  if (pt - at.getTime() < EVIDENCE_MIN_GAP_MS) return null
  const day = toHKDateStr(a.punchTime)
  if (toHKDateStr(at) !== day) return null

  // 同日同類已有待批 → 唔再開（員工自己交咗都係）
  const dup = await prisma.punchCorrection.findFirst({
    where: {
      employeeId: a.employeeId, punchType: a.punchType as any, status: 'PENDING',
      correctedTime: { gte: hkDateStart(day), lte: hkDateEnd(day) },
    },
    select: { id: true },
  })
  if (dup) return null

  const c = await prisma.punchCorrection.create({
    data: {
      punchRecordId: a.recordId,
      employeeId: a.employeeId,
      clinicId: a.clinicId,
      correctedTime: at,
      punchType: a.punchType as any,
      reason: `網絡失敗自動補登：${fmtTime(at)} 已掃到診所 iPad QR（系統核實 QR #${tok.id}），${fmtTime(a.punchTime)} 先入到系統`,
      requestedBy: a.userId,
      status: 'PENDING',
    },
  })
  await prisma.auditLog.create({
    data: {
      actorId: a.userId,
      action: 'PUNCH_NETWORK_EVIDENCE',
      entity: 'PunchCorrection',
      entityId: c.id,
      targetEmployeeId: a.employeeId,
      clinicId: a.clinicId,
      afterJson: JSON.stringify({ recordId: a.recordId, tokenId: tok.id, correctedTime: at.toISOString(), punchTime: a.punchTime.toISOString() }),
    },
  })
  return at
}
