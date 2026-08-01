export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { CONFIG } from '@/lib/config'
import { buildDefaultPayConfig, syncConfigToPayType } from '@/lib/pay-rule-defaults'
import { toHKDateStr, hkDateOnly } from '@/lib/hk-date'
import { serviceMonths, totalAccruedLeave, PROBATION_MONTHS } from '@/lib/leave-calculation'
import { jsonNoStore } from '@/lib/api-response'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const user = await prisma.user.findUnique({
    where: { id: params.id },
    include: {
      clinics: { include: { clinic: true } },
      employee: {
        include: {
          clinics: { include: { clinic: true } },
          payRules: true,
        },
      },
    },
  })

  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { password, ...safeUser } = user
  return jsonNoStore({ account: safeUser })
}

// ============================================================
// DELETE /api/accounts/[id] — Hard delete account (OWNER only)
// Clean accounts: cascade delete in transaction
// Accounts with business records: rejected (use deactivation instead)
// ============================================================
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  if (session.role !== 'OWNER') { // ROLE-OK: 刪除帳號限 OWNER（含最後一個 OWNER 保護）
    return NextResponse.json({ error: '只有 OWNER 可以刪除帳號' }, { status: 403 })
  }

  if (session.userId === params.id) {
    return NextResponse.json({ error: '不能刪除自己的帳號' }, { status: 400 })
  }

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const user = await prisma.user.findUnique({
      where: { id: params.id },
      include: { employee: true },
    })

    if (!user) return NextResponse.json({ error: '帳號不存在' }, { status: 404 })

    const targetEmpId = user.employee?.id ?? null

    if (user.employee) {
      const empId = user.employee.id

      // Check business records
      const [punches, shifts, items, leaves, corrections, expenses, changes] = await Promise.all([
        prisma.punchRecord.count({ where: { employeeId: empId } }),
        prisma.shift.count({ where: { employeeId: empId } }),
        prisma.payrollItem.count({ where: { employeeId: empId } }),
        prisma.leaveRequest.count({ where: { employeeId: empId } }),
        prisma.punchCorrection.count({ where: { employeeId: empId } }),
        prisma.expenseEntry.count({ where: { employeeId: empId } }),
        prisma.shiftChangeRequest.count({ where: { fromEmployeeId: empId } }),
      ])
      const total = punches + shifts + items + leaves + corrections + expenses + changes

      if (total > 0) {
        return NextResponse.json({
          error: `此員工已有 ${total} 筆業務記錄（打卡${punches}/排班${shifts}/計糧${items}/假期${leaves}/補登${corrections}/報銷${expenses}/換更${changes}），不可刪除。請改為「停用」（保留歷史與審計）。`,
        }, { status: 400 })
      }

      // ★ 永久保留參考照 ⇒ 刪員工時一定要清走實體檔，否則變成孤兒生物特徵資料
      const faceTemplates = await prisma.faceTemplate.findMany({
       where: { employeeId: empId, refFrameId: { not: null } },
       select: { refFrameId: true },
      })
      for (const t of faceTemplates) {
       try {
        await fetch(`${CONFIG.FACE_SERVICE_URL}/frame/${t.refFrameId}?allow_ref=1`, {
         method: 'DELETE',
         signal: AbortSignal.timeout(CONFIG.FACE_TIMEOUT_MS),
        })
       } catch { /* 檔可能早已不存在 */ }
      }

      // ★ 以下 model 對 Employee 係 Restrict（schema 冇寫 onDelete），
      //   唔喺交易入面刪就會擲 P2003 → 500。
      try {
        await prisma.$transaction([
          prisma.faceEnrollCode.deleteMany({ where: { employeeId: empId } }),
          prisma.faceTemplate.deleteMany({ where: { employeeId: empId } }),
          prisma.punchCorrection.deleteMany({ where: { employeeId: empId } }),
          prisma.expenseEntry.deleteMany({ where: { employeeId: empId } }),
          prisma.shiftChangeRequest.deleteMany({
            where: {
              OR: [
                { fromEmployeeId: empId },
                { toEmployeeId: empId },
                { approverId: empId },
              ],
            },
          }),
          prisma.timeBankEntry.deleteMany({ where: { employeeId: empId } }),
          prisma.leaveBalance.deleteMany({ where: { employeeId: empId } }),
          prisma.employeeClinic.deleteMany({ where: { employeeId: empId } }),
          prisma.payRule.deleteMany({ where: { employeeId: empId } }),
          prisma.employee.delete({ where: { id: empId } }),
          prisma.user.delete({ where: { id: params.id } }),
        ])
      } catch (e: any) {
        if (e?.code === 'P2003') {
          const field = e?.meta?.field_name || e?.meta?.constraint || '未知關聯'
          return NextResponse.json({
            error: `此員工仍被其他記錄引用（${field}），無法刪除。請改為「停用」以保留歷史與審計。`,
            code: 'P2003',
          }, { status: 409 })
        }
        throw e
      }
    } else {
      await prisma.user.delete({ where: { id: params.id } })
    }

    await prisma.auditLog.create({
      data: {
        action: 'ACCOUNT_DELETE',
        entity: 'ACCOUNT',
        entityId: params.id,
        actorId: session.userId,
        ...(targetEmpId ? { targetEmployeeId: targetEmpId } : {}),
        notes: JSON.stringify({ name: user.name, email: user.email }),
      },
    })

    return NextResponse.json({ ok: true })
  })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const body = await req.json()
      const { name, phone, email, role, status, clinicIds, payType, baseAmount, configJson, effectiveFrom, employeeStatus, newPassword, assignEmployee, joinDate, payConfidential, homeClinicId, permissionsJson, ipAllowlist } = body

      const existing = await prisma.user.findUnique({
        where: { id: params.id },
        include: { employee: true },
      })
      if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

      const userUpdate: any = {}
      if (name !== undefined) userUpdate.name = name
      if (phone !== undefined) userUpdate.phone = phone
      if (email !== undefined) userUpdate.email = email
      if (role !== undefined) userUpdate.role = role
      if (status !== undefined) userUpdate.status = status
      if (newPassword) {
        userUpdate.password = await bcrypt.hash(newPassword, 12)
        // Invalidate all existing sessions on password change
        userUpdate.tokenVersion = { increment: 1 }
      }
      if (status === 'INACTIVE' && existing.status !== 'INACTIVE') {
        // Invalidate all existing sessions on deactivation
        userUpdate.tokenVersion = { increment: 1 }
      }
      if (permissionsJson !== undefined) {
        userUpdate.permissionsJson = permissionsJson ? JSON.stringify(permissionsJson) : null
      }
      if (ipAllowlist !== undefined) {
        userUpdate.ipAllowlist = ipAllowlist || null
      }

      await prisma.user.update({
        where: { id: params.id },
        data: userUpdate,
      })

      // Update clinics
      if (clinicIds !== undefined) {
        await prisma.userClinic.deleteMany({ where: { userId: params.id } })
        if (clinicIds.length > 0) {
          await prisma.userClinic.createMany({
            data: clinicIds.map((cid: string, idx: number) => ({
              userId: params.id,
              clinicId: cid,
              isPrimary: idx === 0,
            })),
          })
        }
      }

      // ① Backfill employee record if assignEmployee is true but no employee exists
      // KIOSK accounts never get employee records
      let employee = existing.employee
      if (!employee && assignEmployee && role !== 'KIOSK') {
        employee = await prisma.employee.create({
          data: {
            userId: params.id,
            joinDate: joinDate ? hkDateOnly(joinDate) : new Date(),
            status: 'ACTIVE',
          },
        })
      }

      // ② Sync EmployeeClinic (scheduling reads from EmployeeClinic, not UserClinic)
      if (clinicIds !== undefined && employee) {
        await prisma.employeeClinic.deleteMany({ where: { employeeId: employee.id } })
        if (clinicIds.length > 0) {
          await prisma.employeeClinic.createMany({
            data: clinicIds.map((cid: string, idx: number) => ({
              employeeId: employee.id,
              clinicId: cid,
              isPrimary: idx === 0,
            })),
          })
        }
      }

      // Update employee if exists (may have just been backfilled above)
      let homeClinicCleared = false
      let empUpdate: any = {} // ★ declared here so AuditLog can reference it after the block
      if (employee && (employeeStatus !== undefined || payType !== undefined || baseAmount !== undefined || payConfidential !== undefined || homeClinicId !== undefined || joinDate !== undefined && joinDate !== '')) {
        empUpdate = {}
        if (employeeStatus !== undefined) empUpdate.status = employeeStatus
        if (payConfidential !== undefined) empUpdate.payConfidential = payConfidential

        // ★ joinDate 之前只在建立新 Employee 時用（:235），更新現有員工完全冇處理 ——
        //   前端改了入職日、API 回 200，但 DB 冇變（Prisma 對缺欄係「唔更新」唔係報錯）。
        //   employees/[id]/route.ts:91 做啱咗，呢條 route 漏咗。
        if (joinDate !== undefined && joinDate !== '') {
          const jd = hkDateOnly(joinDate) // ★ HK 午夜，同 create 一致
          if (isNaN(jd.getTime())) {
            return NextResponse.json({ error: '入職日期格式錯誤（需為 YYYY-MM-DD）' }, { status: 400 })
          }
          empUpdate.joinDate = jd
        }
        if (homeClinicId !== undefined) {
          if (homeClinicId === '' || homeClinicId === null) {
            empUpdate.homeClinicId = null
          } else if (clinicIds && clinicIds.includes(homeClinicId)) {
            empUpdate.homeClinicId = homeClinicId
          } else {
            return NextResponse.json({ error: '長駐店不在已指派診所中，請確認診所指派後重試' }, { status: 400 })
          }
        } else if (clinicIds && employee?.homeClinicId && !clinicIds.includes(employee.homeClinicId)) {
          // homeClinicId 沒被提交但舊值不在新 clinicIds 中 → 自動清空
          empUpdate.homeClinicId = null
          homeClinicCleared = true
        }

        await prisma.employee.update({
          where: { id: employee.id },
          data: empUpdate,
        })

        // ★ 入職日直接決定年假累積額度（totalAccruedLeave）——
        //   改了要即刻重算，否則 LeaveBalance 一直用舊值，
        //   要等有人手動撳「重新計算假期」先反映。
        if (empUpdate.joinDate) {
          const annualType = await prisma.leaveType.findUnique({
            where: { systemKey: 'ANNUAL_LEAVE' },
          })
          if (annualType) {
            const months = serviceMonths(empUpdate.joinDate, new Date())
            const entitled = months < PROBATION_MONTHS
              ? 0
              : totalAccruedLeave(empUpdate.joinDate, new Date(), 'earned')

            const bal = await prisma.leaveBalance.findUnique({
              where: {
                employeeId_leaveTypeId_year: {
                  employeeId: employee.id,
                  leaveTypeId: annualType.id,
                  year: 0, // ★ 累積制用 year=0
                },
              },
            })
            if (bal) {
              await prisma.leaveBalance.update({
                where: { id: bal.id },
                data: { entitled, remaining: Math.max(0, entitled - bal.used) },
              })
            } else if (entitled > 0) {
              await prisma.leaveBalance.create({
                data: {
                  employeeId: employee.id,
                  leaveTypeId: annualType.id,
                  year: 0,
                  entitled,
                  used: 0,
                  remaining: entitled,
                },
              })
            }
          }
        }

        if (payType !== undefined) {
          const effDate = effectiveFrom ? new Date(effectiveFrom) : new Date()

          // ① 檢查是否真的有變更——無變更就不建新規則（防連按兩次）
          const current = await prisma.payRule.findFirst({
            where: { employeeId: employee.id, isActive: true },
            orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
          })
          // 冇 active 就攞最近一筆（包括已停用），最後先落 default
          const fallback = current ?? await prisma.payRule.findFirst({
            where: { employeeId: employee.id, configJson: { not: null } },
            orderBy: [{ createdAt: 'desc' }],
          })
          const incomingConfig = configJson
            || (fallback?.configJson
                && syncConfigToPayType(fallback.configJson, payType, baseAmount))
            || JSON.stringify(buildDefaultPayConfig(payType, baseAmount))
          const unchanged = current
            && current.payType === payType
            && current.baseAmount === (baseAmount ?? null)
            && current.configJson === incomingConfig

          if (!unchanged) {
            try {
              // ② 包 $transaction 防止並發產生兩筆 active
              const newRule = await prisma.$transaction(async (tx) => {
                await tx.payRule.updateMany({
                  where: { employeeId: employee.id, isActive: true },
                  data: { isActive: false, effectiveTo: new Date(effDate.getTime() - 86400000) },
                })
                return tx.payRule.create({
                  data: {
                    employeeId: employee.id,
                    payType,
                    baseAmount: baseAmount ?? null,
                    configJson: incomingConfig,
                    effectiveFrom: effDate,
                    isActive: true,
                    createdBy: session.userId,
                  },
                })
              })

              // 審計記錄 PayRule 變更（保持 transaction 外，用 newRule.id）
              await prisma.auditLog.create({
                data: {
                  actorId: session.userId,
                  action: 'PAY_RULE_UPDATE_VIA_ACCOUNTS',
                  entity: 'PayRule',
                  entityId: newRule.id,
                  targetEmployeeId: employee.id,
                  afterJson: JSON.stringify({ payType, baseAmount, configJson: incomingConfig, effectiveFrom: effDate }),
                } as any,
              })

              // ★ 改 OT 門檻/午休設定會影響所有歷史月份的時間帳戶計算結果 →
              //   清晒該員工全部快取，唔使只清某個月
              await prisma.timeBank.deleteMany({
                where: { employeeId: employee.id },
              })
            } catch (e: any) {
              if (e?.code === 'P2002') {
                return NextResponse.json(
                  { error: '薪資規則正在更新中，請重新整理後再試' }, { status: 409 })
              }
              throw e
            }
          }
        }
      }

      // ★ 審計記錄：beforeJson/afterJson 對稱包含 joinDate
      const beforeJoinDate = existing.employee?.joinDate ? toHKDateStr(existing.employee.joinDate) : null
      const afterJoinDate = empUpdate.joinDate ? toHKDateStr(empUpdate.joinDate) : undefined

      await prisma.auditLog.create({
        data: {
          action: 'UPDATE_ACCOUNT',
          entity: 'ACCOUNT',
          entityId: params.id,
          actorId: session.userId,
          ...(employee ? { targetEmployeeId: employee.id } : {}),
          beforeJson: JSON.stringify({ joinDate: beforeJoinDate }),
          afterJson: JSON.stringify({ joinDate: afterJoinDate }),
        },
      })

      const updated = await prisma.user.findUnique({
        where: { id: params.id },
        include: { clinics: { include: { clinic: true } }, employee: { select: { id: true, payConfidential: true, joinDate: true, status: true, notes: true, leaveDate: true } } },
      })
      if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

      const { password, ...safeUser } = updated
      return NextResponse.json({
        account: safeUser,
        ...(homeClinicCleared ? { note: '長駐店已自動清空（已取消該診所指派）' } : {}),
      })
    } catch (err: any) {
      return NextResponse.json({ error: err.message || 'Failed to update' }, { status: 500 })
    }
  })
}
