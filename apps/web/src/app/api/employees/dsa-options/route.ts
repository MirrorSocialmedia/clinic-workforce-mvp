// ownership-ok: 非動態 route（無 [id]）；select 淨返 id + user.name，無敏感欄
export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/employees/dsa-options — 成本錄入「負責同事」picker（輕量）
//
// ★ 2026-08-22：/api/employees select 含敏感欄（payConfidential / user.phone /
//   user.email / payRules.payType），route 級 override 分唔到 query param，
//   直接開俾 cost_entry = 全 endpoint 開咗。呢條 route 淨返 { id, user: { name } }。
//
// Query: clinicId（可選）—— 按已分配診所 filter（同原 /api/employees?clinicId=
//   同一個 clinics.some 語義）
// Status: ACTIVE only（picker 只需要在職同事）
// Scope: 照 /api/employees 語義 —— scope=all / 管理權限睇全部，其餘收窄到
//   自己綁定嘅診所（session.clinics），唔洩其他店員工姓名。
// ============================================================

const MGMT_DATA_PERMS = [
  'scheduling', 'attendance_manage',
  'payroll_view', 'payroll_generate', 'employee_overview',
]

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope, perms } = auth

  const clinicId = req.nextUrl.searchParams.get('clinicId')
  const where: any = { status: 'ACTIVE' }
  if (clinicId) where.clinics = { some: { clinicId } }

  // ★ 同 /api/employees 一致：非管理權限收窄到自己嘅診所
  const canSeeAllEmployees =
    scope === 'all' || MGMT_DATA_PERMS.some(p => (perms ?? []).includes(p))
  if (!canSeeAllEmployees) {
    where.user = {
      ...(where.user || {}),
      clinics: { some: { clinicId: { in: session.clinics ?? [] } } },
    }
  }

  // ★ 排序同 /api/employees 一致（createdAt desc），下拉順序同改前相同
  const employees = await prisma.employee.findMany({
    where,
    select: { id: true, user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })

  return jsonNoStore({
    employees: employees.map(e => ({ id: e.id, user: { name: e.user.name } })),
  })
}
