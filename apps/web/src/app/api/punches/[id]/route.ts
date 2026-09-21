export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'
import { invalidateTimeBankFrom } from '@/lib/punch-query'
import { revokeStaleEarlyOt } from '@/lib/early-in-ot'
import { getMonthRange, toHKDateStr } from '@/lib/hk-date'
import { lockEmployee, toHttpResponse } from '@/lib/emp-lock'
import { assertMonthsUnlockedTx } from '@/lib/payroll-lock'

// GET /api/punches/[id] — Single punch record + full correction chain
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const record = await prisma.punchRecord.findUnique({
    where: { id: params.id },
    include: {
      employee: { include: { user: { select: { id: true, name: true, phone: true } } } },
      clinic: { select: { id: true, name: true } },
      corrections: { orderBy: { createdAt: 'asc' } },
    },
  })

  if (!record) return NextResponse.json({ error: 'Record not found' }, { status: 404 })

  // ★ IDOR: MANAGER 只可以睇自己店嘅打卡
  // ★ 用 resolveClinicScope 取代 assertClinicAccess（2026-08-03）
  // forPerms: 單筆打卡記錄 → companyWide（考勤跨店）
  const allowedClinics = await resolveClinicScope(session, auth.perms ?? [], {
    companyWide: ['attendance_manage', 'scheduling'],
  })
  if (allowedClinics !== null && !allowedClinics.includes(record.clinicId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const chain: any[] = [{
    type: 'original', id: record.id,
    punchTime: record.punchTime.toISOString(), punchType: record.punchType,
    source: record.source, tokenValid: record.tokenValid,
    deviceInfo: record.deviceInfo, notes: record.notes,
    createdAt: record.createdAt.toISOString(),
  }]

  for (const correction of record.corrections) {
    chain.push({
      type: 'correction', id: correction.id,
      correctedTime: correction.correctedTime.toISOString(),
      punchType: correction.punchType, reason: correction.reason,
      requestedBy: correction.requestedBy, approvedBy: correction.approvedBy,
      status: correction.status,
      createdAt: correction.createdAt.toISOString(),
      updatedAt: correction.updatedAt.toISOString(),
    })
  }

  return jsonNoStore({
    record: {
      id: record.id, employeeId: record.employeeId, clinicId: record.clinicId,
      punchTime: record.punchTime.toISOString(), punchType: record.punchType,
      source: record.source, tokenValid: record.tokenValid,
      deviceInfo: record.deviceInfo, notes: record.notes,
      createdAt: record.createdAt.toISOString(),
      employee: record.employee, clinic: record.clinic,
      // Face verification fields
      faceStatus: record.faceStatus,
      faceScore: record.faceScore,
      faceReason: record.faceReason,
      faceFramePath: record.faceFramePath,
      faceReviewedAt: record.faceReviewedAt?.toISOString() ?? null,
      faceReviewedBy: record.faceReviewedBy,
      // GPS location fields
      punchLat: record.punchLat,
      punchLng: record.punchLng,
      distanceM: record.distanceM,
      locationFlag: record.locationFlag,
      geoAccuracy: record.geoAccuracy,
    },
    chain,
  })
}

// PUT /api/punches/[id] — 編輯打卡（void 舊筆 + 建新筆）
// Roles: OWNER, MANAGER
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const body = await req.json().catch(() => ({}))
  const { punchTime, punchType, notes, reason } = body

  const oldRecord = await prisma.punchRecord.findUnique({ where: { id: params.id } })
  if (!oldRecord) return NextResponse.json({ error: '記錄不存在' }, { status: 404 })

  // ★ cwm-antitamper P1-5：手改必有原因，時間唔可以係未來
  if (!reason || String(reason).trim().length < 2) return NextResponse.json({ error: '請填寫修改原因' }, { status: 400 })
  if (punchTime && (isNaN(new Date(punchTime).getTime()) || new Date(punchTime).getTime() > Date.now() + 60_000)) {
    return NextResponse.json({ error: '時間無效' }, { status: 400 })
  }

  // ★ IDOR: MANAGER 只可以改自己店嘅打卡
  // ★ 用 resolveClinicScope 取代 assertClinicAccess（2026-08-03）
  // forPerms: 編輯打卡 → companyWide（考勤跨店）
  const allowedClinics = await resolveClinicScope(session, auth.perms ?? [], {
    companyWide: ['attendance_manage', 'scheduling'],
  })
  if (allowedClinics !== null && !allowedClinics.includes(oldRecord.clinicId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // 檢查是否已被 void
  const existingVoid = await prisma.punchVoid.findUnique({ where: { punchRecordId: params.id } })
  if (existingVoid) return NextResponse.json({ error: '此記錄已被作廢' }, { status: 400 })

  // 在 transaction 內執行三步（★ Stage 4A（D1 硬鎖）：先鎖人 + 新舊兩個月份都查）
  let newRecord
  try {
    newRecord = await prisma.$transaction(async (tx) => {
      await lockEmployee(tx, oldRecord.employeeId)
      await assertMonthsUnlockedTx(tx, {
        actorId: session.userId, employeeId: oldRecord.employeeId, what: '修改打卡',
        months: [toHKDateStr(oldRecord.punchTime), punchTime ? toHKDateStr(new Date(punchTime)) : null],
      })
      // ① 作廢舊筆
      await tx.punchVoid.create({
        data: {
          punchRecordId: params.id,
          voidedBy: session.userId,
          reason: reason || '管理端更正',
        },
      })
      // ② 建新筆
      const nr = await tx.punchRecord.create({
        data: {
          employeeId: oldRecord.employeeId,
          clinicId: oldRecord.clinicId,
          punchTime: punchTime ? new Date(punchTime) : oldRecord.punchTime,
          punchType: punchType || oldRecord.punchType,
          source: 'MANUAL_CORRECTION' as any,   // ★ cwm-antitamper：手改嘅卡唔准再顯示「動態QR碼 · QR有效」
          tokenValid: null,
          deviceInfo: null,
          notes: notes !== undefined ? notes : oldRecord.notes,
        },
      })
      // ③ 審計
      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'PUNCH_EDIT',
          entity: 'PunchRecord',
          entityId: params.id,
          targetEmployeeId: oldRecord.employeeId,
          afterJson: JSON.stringify({
            oldRecordId: params.id,
            newRecordId: nr.id,
            oldValue: { punchTime: oldRecord.punchTime.toISOString(), punchType: oldRecord.punchType },
            newValue: { punchTime, punchType },
            reason: reason || '管理端編輯',
          }),
          ipAddress: req.headers.get('x-forwarded-for') || null,
          userAgent: req.headers.get('user-agent') || null,
        },
      })
      // ★ Stage 2.4：改 punchTime / punchType 直接影響遲到／早退／OT 配對，快取失效 + OT 撤回入 tx（失敗 = rollback）
      // ⚠️ 新舊時間所屬月份【兩個都要清】—— 由 5/31 改去 6/1，兩個月嘅數字都變咗。
      await invalidateTimeBankFrom(oldRecord.employeeId, oldRecord.punchTime, tx)
      await revokeStaleEarlyOt(oldRecord.employeeId, toHKDateStr(oldRecord.punchTime), session.userId, 'PUNCH_EDIT', tx)
      if (punchTime) {
        const newTime = new Date(punchTime)
        const { start: oldMonth } = getMonthRange(oldRecord.punchTime)
        const { start: newMonth } = getMonthRange(newTime)
        if (newMonth.getTime() !== oldMonth.getTime()) {
          await invalidateTimeBankFrom(oldRecord.employeeId, newTime, tx)
        }
        await revokeStaleEarlyOt(oldRecord.employeeId, toHKDateStr(newTime), session.userId, 'PUNCH_EDIT', tx)
      }
      return nr
    })
  } catch (e: any) {
    const r = toHttpResponse(e, '此打卡記錄已被作廢'); if (r) return r
    throw e
  }

  return NextResponse.json({ ok: true, record: { id: newRecord.id } })
}
