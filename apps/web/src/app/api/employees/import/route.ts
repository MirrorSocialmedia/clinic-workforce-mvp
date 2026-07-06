export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { runWithAudit } from '@/lib/audit-context'

// POST /api/employees/import — bulk CSV import
export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    const formData = await req.formData()
    const file = formData.get('file') as File | null

    if (!file) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })

    const csvText = await file.text()
    const lines = csvText.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean)

    if (lines.length < 2) {
      return NextResponse.json(
        { error: 'CSV must have a header row and at least one data row' },
        { status: 400 }
      )
    }

    const header = parseCSVLine(lines[0])
    const requiredColumns = ['name', 'phone', 'clinicName', 'role', 'payType', 'baseAmount']
    const missingColumns = requiredColumns.filter((col) => !header.includes(col))

    if (missingColumns.length > 0) {
      return NextResponse.json(
        { error: `Missing required columns: ${missingColumns.join(', ')}`, foundColumns: header },
        { status: 400 }
      )
    }

    const rows = lines.slice(1).map((line, idx) => ({
      lineNum: idx + 2,
      data: parseCSVLine(line),
    }))

    const colIdx: Record<string, number> = {}
    header.forEach((col, idx) => { colIdx[col.trim().toLowerCase()] = idx })

    const clinics = await prisma.clinic.findMany({ select: { id: true, name: true } })
    const clinicMap = new Map(clinics.map((c) => [c.name.toLowerCase(), c.id]))

    const results = {
      success: [] as any[],
      skipped: [] as any[],
      errors: [] as any[],
    }

    for (const row of rows) {
      const getData = (col: string) => {
        const idx = colIdx[col.toLowerCase()]
        return idx !== undefined ? (row.data[idx] || '').trim() : ''
      }

      const name = getData('name')
      const phone = getData('phone')
      const clinicName = getData('clinicName')
      const role = getData('role')
      const payType = getData('payType')
      const baseAmount = getData('baseAmount')
      const email = getData('email')
      const joinDate = getData('joinDate')

      if (!name || !phone || !clinicName) {
        results.errors.push({ lineNum: row.lineNum, error: 'Missing required fields: name, phone, clinicName', data: { name, phone, clinicName } })
        continue
      }

      const clinicId = clinicMap.get(clinicName.toLowerCase())
      if (!clinicId) {
        results.errors.push({ lineNum: row.lineNum, error: `Clinic "${clinicName}" not found`, data: { name, phone, clinicName } })
        continue
      }

      const existing = await prisma.user.findUnique({ where: { phone } })
      if (existing) {
        results.skipped.push({ lineNum: row.lineNum, reason: `Phone ${phone} already registered`, data: { name, phone } })
        continue
      }

      results.success.push({
        name, phone, email: email || null, clinicId, role, payType,
        baseAmount: baseAmount ? parseFloat(baseAmount) : null,
        joinDate: joinDate ? new Date(joinDate) : new Date(),
      })
    }

    const preview = formData.get('preview')
    if (preview) {
      return NextResponse.json({ preview: true, totalLines: rows.length, ...results })
    }

    const imported = []
    const importErrors = []

    for (const item of results.success) {
      try {
        const hashedPassword = await bcrypt.hash('demo1234', 12)

        const result = await prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              name: item.name, phone: item.phone, email: item.email,
              password: hashedPassword, role: 'EMPLOYEE',
              clinics: { create: [{ clinic: { connect: { id: item.clinicId } }, isPrimary: true }] },
            },
          })

          const employee = await tx.employee.create({
            data: {
              userId: user.id, joinDate: item.joinDate, status: 'ACTIVE',
              clinics: { create: [{ clinic: { connect: { id: item.clinicId } }, isPrimary: true }] },
              payRules: item.payType ? {
                create: {
                  payType: item.payType, baseAmount: item.baseAmount,
                  effectiveFrom: item.joinDate, createdBy: session.userId,
                },
              } : undefined,
            },
            include: { user: { select: { id: true, name: true, phone: true } } },
          })

          return employee
        })

        imported.push({ lineNum: null, employeeId: result.id, name: result.user.name })
      } catch (err: any) {
        importErrors.push({ lineNum: null, error: err.message || 'Unknown error' })
      }
    }

    // Audit handled by Prisma extension (Employee ∈ AUDIT_ENTITIES)

    return NextResponse.json({
      success: true, imported, skipped: results.skipped,
      errors: [...results.errors, ...importErrors],
      summary: {
        totalLines: rows.length, imported: imported.length,
        skipped: results.skipped.length, errors: [...results.errors, ...importErrors].length,
      },
    })
  })
}

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else { inQuotes = !inQuotes }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else { current += ch }
  }
  result.push(current.trim())
  return result
}
