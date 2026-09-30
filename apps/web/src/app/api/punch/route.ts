export const dynamic = 'force-dynamic'
import { lockEmployee, HttpError, isLockBusy } from '@/lib/emp-lock'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveQrToken } from '@/lib/qr-token'
import { maybeCreateNetworkCorrection } from '@/lib/punch-evidence'
import { todayHK, hkDateStart } from '@/lib/hk-date'
import { distanceMeters } from '@/lib/geo'
import { invalidateTimeBankFrom } from '@/lib/punch-query'

// ============================================================
// POST /api/punch — Clock in/out via QR token or manual lunch punch
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================

/**
 * Get start of today in Asia/Hong_Kong timezone (UTC+8).
 * Returns a Date object at midnight HK time, converted to UTC for DB comparison.
 */
function getTodayStartHK(): Date {
  return hkDateStart(todayHK())
}

// ★ 2026-09-30 C3：body 清洗 —— 壞值當「冇」，唔 reject（盡量唔擋打卡；舊版 lat:"abc" 會 500）
const finiteNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// ★ 2026-09-30 C4：GPS 硬擋預設關（盡量唔擋打卡）—— 越界照標 OUT_OF_RANGE 俾考勤頁睇。
//   要開返「距離 > radius×3 就擋」：PUNCH_GEO_HARD_BLOCK=1
const GEO_HARD_BLOCK = process.env.PUNCH_GEO_HARD_BLOCK === '1'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const body = await req.json()
      const { token: qrToken, geoFlag, firstToken, firstScanAt } = body
      const lat = finiteNum(body.lat)
      const lng = finiteNum(body.lng)
      const hasLatLng = lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      const geoAccRaw = finiteNum(body.geoAcc)
      const deviceInfo = typeof body.deviceInfo === 'string' ? body.deviceInfo.slice(0, 300) : null
      // ⚠️ body.notes 唔再接受：前端從來冇送，舊版照寫入 PunchRecord.notes（員工可以自己塞「經理已批」之類）

      // Accept optional explicit punchType (CLOCK_IN/CLOCK_OUT/LUNCH_START/LUNCH_END)
      const explicitPunchType = body.punchType
      const VALID_TYPES = ['CLOCK_IN', 'CLOCK_OUT', 'LUNCH_START', 'LUNCH_END']
      const hasExplicitType = VALID_TYPES.includes(explicitPunchType)

      // Get the employee for this user
      const employee = await prisma.employee.findUnique({
        where: { userId: session.userId },
        include: {
          clinics: { select: { clinicId: true } },
        },
      })

      if (!employee) {
        return NextResponse.json(
          { error: 'Employee profile not found' },
          { status: 400 }
        )
      }

      let clinicId: string | null = null
      let source: string = 'QR_DYNAMIC'
      let tokenValid: boolean | null = true
      let crossClinic = false
      let tokenIdForUsage: string | null = null
      let qrLateSec = 0 // ★ C1：QR 過期寬限內接受 → 標記秒數（考勤頁 ❌）

      // ★ Token + clinic resolution: token-first, explicit-fallback
      if (qrToken) {
        const tokenCheck = await resolveQrToken(String(qrToken))
        if (!tokenCheck.valid) {
          return NextResponse.json({
            error: tokenCheck.reason === 'EXPIRED'
              ? 'QR 碼已過期，請掃 iPad 上最新嘅 QR（今次未打到卡）。如果 iPad 個碼一直冇轉，請通知同事檢查 iPad 網絡'
              : 'QR 碼無效，請掃診所 iPad 上最新嘅 QR（今次未打到卡）',
            code: tokenCheck.reason,
          }, { status: 400 })
        }
        // ★ cwm-antitamper P1-1：唔准用自己裝置發出嘅 QR
        if (tokenCheck.issuedByUserId && tokenCheck.issuedByUserId === session.userId) {
          return NextResponse.json({ error: '唔可以用自己裝置顯示嘅 QR 打卡，請掃診所 iPad（今次未打到卡）', code: 'SELF_ISSUED' }, { status: 403 })
        }
        clinicId = tokenCheck.clinicId
        tokenIdForUsage = tokenCheck.tokenId
        qrLateSec = tokenCheck.lateSec
        tokenValid = qrLateSec === 0 // ★ C1：寬限期內接受嘅過期碼 → false（考勤頁 ❌），唔擋

        // ★ 決定（2026-08-01）：借調係常態，唔擋跨店打卡。
        // 排班嗰邊已經唔檢查 EmployeeClinic（2026-07-28 全店排班權），
        // 打卡呢邊繼續擋就會出現「排到更但打唔到卡」。
        // 改為標記，考勤報表顯示，經理自行判斷。
        const empClinicIds = employee.clinics.map((ec: any) => ec.clinicId)
        if (!empClinicIds.includes(clinicId)) {
          crossClinic = true
        }

        source = 'QR_DYNAMIC'
        // ★ Explicit type + valid token = normal punch, NOT MANUAL_CORRECTION
      } else {
        // ★ 決定 6：一律要 QR token（含午休卡）。
        // 舊嘅免 token 分支已刪：任何人 POST {"punchType":"CLOCK_IN"} 就可以喺屋企打卡，
        // 而且 clinics[0] 喺調鋪時會攞錯店。現行前端一定帶 token，冇相容性問題。
        return NextResponse.json({ error: 'token is required' }, { status: 400 })
      }

      // Determine punch type
      const todayStart = getTodayStartHK()
      const todayPunches = await prisma.punchRecord.findMany({
        where: {
          employeeId: employee.id,
          clinicId,
          punchTime: { gte: todayStart },
          void: { is: null }, // 已作廢的不算存在
        },
        orderBy: { punchTime: 'desc' },
        take: 20,
      })

      let punchType: string
      if (hasExplicitType) {
        punchType = explicitPunchType
        // Per-type daily limit: max 1 of each type per day
        if (todayPunches.some(p => p.punchType === punchType)) {
          const label = punchType === 'CLOCK_IN' ? '上班' : punchType === 'CLOCK_OUT' ? '下班' : punchType === 'LUNCH_START' ? '午休開始' : '午休結束'
          return NextResponse.json(
            { error: `今天已打${label}卡`, code: 'ALREADY_PUNCHED' },   // ★ A-5：同 tx 內重驗一致 → 打卡頁顯示琥珀色提示唔係紅色失敗
            { status: 400 }
          )
        }
      } else {
        // Fallback: old frontend compatibility — auto-detect CLOCK_IN/CLOCK_OUT
        const hasClockInToday = todayPunches.some(p => p.punchType === 'CLOCK_IN')
        const hasClockOutToday = todayPunches.some(p => p.punchType === 'CLOCK_OUT')

        if (!hasClockInToday) {
          punchType = 'CLOCK_IN'
        } else if (!hasClockOutToday) {
          punchType = 'CLOCK_OUT'
        } else {
          return NextResponse.json(
            { error: '今天已完成上下班打卡，如需修改請用補打卡' },
            { status: 400 }
          )
        }
      }

      // ★ GPS location verification (shadow mode — observation only, never blocks)
      // ★ geoFlag 只接受白名單值，而且唔可以用嚟 skip 距離計算
      const ALLOWED_GEO_FLAGS = ['NO_GPS', 'DENIED', 'TIMEOUT']
      let punchLat: number | null = null
      let punchLng: number | null = null
      let distanceM: number | null = null
      let locationFlag: string | null =
        ALLOWED_GEO_FLAGS.includes(geoFlag) ? geoFlag : null
      const geoAccuracy: number | null = geoAccRaw != null ? Math.max(0, Math.round(geoAccRaw)) : null

      if (hasLatLng) {
        punchLat = lat
        punchLng = lng
        const clinic = await prisma.clinic.findUnique({
          where: { id: clinicId! },
          select: { latitude: true, longitude: true, geoRadius: true },
        })
        if (clinic?.latitude != null && clinic?.longitude != null) {
          distanceM = distanceMeters(lat!, lng!, clinic.latitude, clinic.longitude)
          const radius = clinic.geoRadius ?? Number(process.env.GEO_DEFAULT_RADIUS || 200)
          if (distanceM > radius) locationFlag = 'OUT_OF_RANGE'
          // ★ C4：硬擋預設關（見 GEO_HARD_BLOCK）
          const hardLimit = radius * 3
          const accOk = geoAccuracy == null || geoAccuracy < 100
          if (GEO_HARD_BLOCK && distanceM > hardLimit && accOk) {
            return NextResponse.json({
              error: `距離診所 ${Math.round(distanceM)} 米，超出打卡範圍。如喺診所內請重新定位再試。`,
              distanceM: Math.round(distanceM),
            }, { status: 403 })
          }
        }
      } else if (!locationFlag) {
        locationFlag = 'NO_GPS'
      }

      // Transaction: punch record (audit auto-handled by Prisma extension)
      const result = await prisma.$transaction(async (tx) => {
        // ★ Stage 1.6：同員工串行化 + 鎖入面再驗（:103-124 只係 fast-fail）
        await lockEmployee(tx, employee.id)
        const dupTx = await tx.punchRecord.findFirst({
          where: { employeeId: employee.id, clinicId, punchType: punchType as any, punchTime: { gte: todayStart }, void: { is: null } },
          select: { id: true },
        })
        if (dupTx) throw new HttpError(400, '今天已打呢種卡（上一次已成功）', { code: 'ALREADY_PUNCHED' })
        // ★ cwm-antitamper：所有檢查通過先消耗 token（之前喺一開頭就消耗，失敗都會食咗）
        await tx.qRTokenUsage.create({ data: { tokenId: tokenIdForUsage!, employeeId: employee.id } })
        const record = await tx.punchRecord.create({
          data: {
            employeeId: employee.id,
            clinicId,
            punchTime: new Date(),
            punchType: punchType as any,
            source: source as any,
            tokenValid,
            deviceInfo,
            punchLat,
            punchLng,
            distanceM,
            locationFlag,
            geoAccuracy,
            notes: [
              crossClinic ? '跨店打卡（非指派診所）' : null,
              qrLateSec > 0 ? `QR 過期 ${qrLateSec} 秒（寬限內接受）` : null,
            ].filter(Boolean).join(' · ') || null,
          },
        })
        // ★ cwm-antitamper P1-2：每張卡入 audit（入 SENSITIVE_AUDIT_EXEMPT，唔入敏感摘要）
        await tx.auditLog.create({
          data: {
            actorId: session.userId,
            action: 'PUNCH_CREATE',
            entity: 'PunchRecord',
            entityId: record.id,
            targetEmployeeId: employee.id,
            clinicId,
            afterJson: JSON.stringify({ punchType, locationFlag, distanceM, crossClinic, qrLateSec }),
            ipAddress: req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || null,
            userAgent: req.headers.get('user-agent') || null,
          },
        })
        // ★ Stage 2.4：打卡影響缺勤判斷同午飯扣減 → 快取失效入 tx（失敗 = rollback）
        await invalidateTimeBankFrom(employee.id, record.punchTime, tx)
        return record
      })

      // ★ C2：網絡失敗證據 → 自動補登申請（best-effort：任何錯誤都唔影響今次打卡結果）
      let autoCorrectionAt: string | null = null
      try {
        const at = await maybeCreateNetworkCorrection({
          employeeId: employee.id, clinicId: clinicId!, recordId: result.id,
          punchType, punchTime: result.punchTime, firstToken, firstScanAt, userId: session.userId,
        })
        autoCorrectionAt = at ? at.toISOString() : null
      } catch (e) {
        console.error('[punch] network evidence 失敗（唔影響打卡）', e)
      }

      return NextResponse.json({
        success: true,
        recordId: result.id,
        punchTime: result.punchTime.toISOString(),
        punchType,
        autoCorrectionAt,
      })
    } catch (error: any) {
      if (error instanceof HttpError) {
        return NextResponse.json({ error: error.message, ...(error.extra ?? {}) }, { status: error.status })
      }
      if (isLockBusy(error)) {
        // ★ H0-2c：等鎖超時 —— 未寫入，叫佢再撳一次（唔好顯示「系統錯誤」）
        return NextResponse.json({ error: '系統忙緊（資料處理中），今次未打到卡，請 5 秒後再撳一次', code: 'BUSY' }, { status: 409 })
      }
      console.error('Punch error:', error)
      // Transaction rollback already happened
      if (error.code === 'P2002') {
        // ★ cwm-antitamper：QRTokenUsage unique(tokenId, employeeId) — 同碼第二次 = 已用
        return NextResponse.json({ error: '呢個 QR 你啱啱已經用咗（上一次已打卡成功），請等螢幕更新', code: 'ALREADY_USED' }, { status: 409 })
      }
      if (error.code === 'P2025') {
        // Record not unique — token already used
        return NextResponse.json({ error: 'Token invalid or already used' }, { status: 400 })
      }
      return NextResponse.json({ error: '系統錯誤，今次未打到卡，請再試或者搵主管' }, { status: 500 })
    }
  })
}
