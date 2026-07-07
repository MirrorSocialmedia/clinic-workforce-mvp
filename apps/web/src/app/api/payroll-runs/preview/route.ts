export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { calculateEmployeePayroll, calculatePayrollWithRules } from '@/lib/payroll-engine'

// ============================================================
// POST /api/payroll-runs/preview — Preview payroll calculation
// Roles: OWNER (does not write to database)
// ============================================================
export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', req.url)
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

    // Get employees
    const where: any = {
      status: 'ACTIVE',
    }
    if (clinicId) where.clinics = { some: { clinicId } }
    if (employeeId) where.id = employeeId

    const employees = await prisma.employee.findMany({
      where,
      include: { user: { select: { name: true } } },
      orderBy: { id: 'asc' },
    })

    // Calculate payroll for each employee WITHOUT writing to DB
    const items = []
    for (const emp of employees) {
      try {
        // Read employee pay rule to determine engine
        const payRule = await prisma.payRule.findFirst({
          where: {
            employeeId: emp.id,
            isActive: true,
          },
          orderBy: { effectiveFrom: 'desc' },
        })

        let result
        if (payRule?.configJson) {
          const config = JSON.parse(payRule.configJson)
          if (config.base_type || config.modifiers) {
            // New modular format → use new engine
            result = await calculatePayrollWithRules(emp.id, monthDate, clinicId || null, config)
          } else {
            // Legacy format → use old engine (backward compat)
            result = await calculateEmployeePayroll(emp.id, monthDate, clinicId || null)
          }
        } else {
          // No rule → use old engine
          result = await calculateEmployeePayroll(emp.id, monthDate, clinicId || null)
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
          splitPay: result.splitPay,
          deduction: result.deduction,
          totalPayable: result.totalPayable,
          detail: result.detail,
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
    })
  } catch (err: any) {
    console.error('Payroll preview error:', err)
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 })
  }
}
