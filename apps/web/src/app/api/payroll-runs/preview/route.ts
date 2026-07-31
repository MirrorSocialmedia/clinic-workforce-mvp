export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { calculatePayrollWithRules } from '@/lib/payroll-engine'

// ============================================================
// POST /api/payroll-runs/preview — Preview payroll calculation
// Roles: OWNER (does not write to database)
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  try {
    const body = await req.json()
    const { periodMonth, clinicId, employeeId } = body

    if (!periodMonth) {
      return NextResponse.json({ error: 'periodMonth (YYYY-MM) is required' }, { status: 400 })
    }

    // Parse YYYY-MM to Date
    const [yearStr, monthStr] = periodMonth.split('-')
    const monthDate = new Date(parseInt(yearStr), parseInt(monthStr) - 1, 1)

    // ★ Check for existing DRAFT to carry over storeBonus / splitPay
    const existing = await prisma.payrollRun.findFirst({
      where: {
        clinicId: clinicId ?? null,
        status: 'DRAFT',
        periodMonth: {
          gte: new Date(`${periodMonth}-01T00:00:00+08:00`),
          lte: new Date(`${periodMonth}-28T23:59:59+08:00`),
        },
      },
    })

    const carriedStoreBonus: Record<string, number> = {}
    const carriedSplitPay: Record<string, number> = {}
    if (existing) {
      const oldItems = await prisma.payrollItem.findMany({
        where: { runId: existing.id },
        select: { employeeId: true, storeBonus: true, splitPay: true },
      })
      for (const oi of oldItems) {
        if (oi.storeBonus) carriedStoreBonus[oi.employeeId] = oi.storeBonus
        if (oi.splitPay != null) carriedSplitPay[oi.employeeId] = oi.splitPay
      }
    }

    // Get employees — use homeClinicId instead of EmployeeClinic to avoid multi-clinic duplicates
    const where: any = {
      status: 'ACTIVE',
    }
    if (clinicId) where.homeClinicId = clinicId
    if (employeeId) where.id = employeeId

    // ★ Non-OWNER: exclude payConfidential employees from preview entirely
    if (session.role !== 'OWNER') {
      where.payConfidential = false
    }

    const employees = await prisma.employee.findMany({
      where,
      include: { user: { select: { name: true } } },
      orderBy: { id: 'asc' },
    })

    // Calculate payroll for each employee WITHOUT writing to DB
    const items = []
    const skipped: Array<{ employeeId: string; name: string; reason: string }> = []
    for (const emp of employees) {
      try {
        // Read employee pay rule to determine engine
        const payRule = await prisma.payRule.findFirst({
          where: {
            employeeId: emp.id,
            isActive: true,
          },
          orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        })

        let result
        if (payRule?.configJson) {
          const config = JSON.parse(payRule.configJson)
          if (!config.base_type && !config.modifiers) {
            console.error(`Employee ${emp.id} still has old-format payRule!`)
            skipped.push({ employeeId: emp.id, name: emp.user.name, reason: '薪酬規則格式過舊，請重新設定' })
            continue
          }
          result = await calculatePayrollWithRules(emp.id, monthDate, clinicId || null, config)
        } else {
          console.warn(`Employee ${emp.id} has no payRule, skipping`)
          skipped.push({ employeeId: emp.id, name: emp.user.name, reason: '未設定薪酬規則' })
          continue
        }

        items.push({
          employeeId: emp.id,
          employeeName: emp.user.name,
          payType: (result as any).payType || 'MONTHLY',
          workedHours: result.workedHours,
          otHours: result.otHours,
          leaveDays: result.leaveDays,
          absentDays: result.absentDays,
          basePay: result.basePay,
          otPay: result.otPay,
          deduction: result.deduction,
          totalPayable: result.totalPayable,
          detail: result.detail,
          // ★ Carry over existing draft values for pre-fill
          storeBonus: carriedStoreBonus[emp.id] ?? (result.detail as any)?.storeBonus ?? 0,
          splitPay: carriedSplitPay[emp.id] != null ? carriedSplitPay[emp.id] : result.splitPay,
        })
      } catch (err: any) {
        items.push({
          employeeId: emp.id,
          employeeName: emp.user.name,
          error: err.message || '計算失敗',
        })
      }
    }

    const totalPayable = items.reduce((sum, item) => sum + (item.totalPayable || 0), 0)

    return NextResponse.json({
      periodMonth,
      items,
      itemCount: items.length,
      totalPayable: Math.round(totalPayable * 100) / 100,
      skipped,
    })
  } catch (err: any) {
    console.error('Payroll preview error:', err)
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 })
  }
}
