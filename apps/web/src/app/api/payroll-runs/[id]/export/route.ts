export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { toHKDateStr } from '@/lib/hk-date'
import { maskIfConfidential, hasConfidentialItems } from '@/lib/payroll-engine'
import * as XLSX from 'xlsx'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import fs from 'fs'
import path from 'path'

// Module-level cache: 12MB font should only be read once per process
let fontB64Cache: string | null = null
function getFontB64(): string | null {
  if (fontB64Cache) return fontB64Cache
  try {
    const fontPath = path.join(process.cwd(), 'public/fonts/NotoSansTC-Regular.ttf')
    fontB64Cache = fs.readFileSync(fontPath).toString('base64')
  } catch {
    return null
  }
  return fontB64Cache
}

// POST /api/payroll-runs/[id]/export — Export to Excel or PDF
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  const isOwner = session.role === 'OWNER'

  const body = await req.json()
  const format = body.format || 'xlsx'

  const run = await prisma.payrollRun.findUnique({
    where: { id: params.id },
    include: {
      clinic: {
        select: {
          id: true,
          name: true,
          company: { select: { name: true, logoData: true } },
        },
      },
      items: {
        include: {
          employee: {
            select: {
              payConfidential: true,
              user: { select: { name: true, phone: true } },
              clinics: { select: { clinicId: true, clinic: { select: { name: true } } } },
              payRules: { where: { isActive: true }, take: 1 },
            },
          },
        },
        orderBy: { employeeId: 'asc' },
      },
    },
  })

  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Apply confidential masking
  const items = run.items.map(item =>
    maskIfConfidential(item, session.role)
  )

  const runData = { ...run, items }
  const periodMonth = toHKDateStr(run.periodMonth).slice(0, 7)
  const clinicName = run.clinic?.name || '全部診所'

  if (format === 'xlsx') return exportToExcel(runData, periodMonth, clinicName, isOwner)
  return exportToPDF(runData, periodMonth, clinicName, isOwner)
}

function fmtConf(val: number | null | undefined, fallback: string = '保密'): string {
  return val != null ? val.toFixed(2) : fallback
}

function fmtConfInt(val: number | null | undefined, fallback: string = '-'): string {
  return val != null ? val.toFixed(0) : fallback
}

function exportToExcel(run: any, periodMonth: string, clinicName: string, isOwner: boolean): NextResponse {
  const hasConf = hasConfidentialItems(run.items, isOwner ? 'OWNER' : 'MANAGER')
  const rows = run.items.map((item: any) => {
    const clinics = item.employee.clinics.map((c: any) => c.clinic.name).join(', ')
    const payType = item.employee.payRules[0]?.payType || 'N/A'
    return {
      '員工姓名': item.employee.user.name,
      '聯絡電話': item.employee.user.phone,
      '診所': clinics,
      '薪酬類型': payType,
      '工作時數': item.workedHours.toFixed(2),
      '加班時數': item.otHours.toFixed(2),
      '請假日數': item.leaveDays.toFixed(2),
      '缺勤日數': item.absentDays.toFixed(2),
      '基本薪資': fmtConf(item.basePay),
      '加班費': fmtConf(item.otPay),
      '拆帳': item.splitPay != null ? fmtConf(item.splitPay) : '0.00',
      '扣款': fmtConf(item.deduction),
      '店舖獎金': fmtConf(item.storeBonus),
      '應付總額': fmtConf(item.totalPayable),
    }
  })

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.json_to_sheet(rows)
  ws['!cols'] = [
    { wch: 12 }, { wch: 15 }, { wch: 20 }, { wch: 10 },
    { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
    { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
  ]
  XLSX.utils.book_append_sheet(wb, ws, '糧單')

  const visibleItems = run.items.filter((i: any) => !i.confidential)
  const summary = [
    { '項目': '計糧期間', '值': periodMonth },
    { '項目': '診所', '值': clinicName },
    { '項目': '狀態', '值': run.status },
    { '項目': '員工數', '值': run.items.length },
    { '項目': '總基本薪資', '值': hasConf ? '含保密員工' : visibleItems.reduce((s: number, i: any) => s + (i.basePay ?? 0), 0).toFixed(2) },
    { '項目': '總加班費', '值': hasConf ? '含保密員工' : visibleItems.reduce((s: number, i: any) => s + (i.otPay ?? 0), 0).toFixed(2) },
    { '項目': '總拆帳', '值': hasConf ? '含保密員工' : visibleItems.reduce((s: number, i: any) => s + (i.splitPay ?? 0), 0).toFixed(2) },
    { '項目': '總店舖獎金', '值': hasConf ? '含保密員工' : visibleItems.reduce((s: number, i: any) => s + (i.storeBonus ?? 0), 0).toFixed(2) },
    { '項目': '總扣款', '值': hasConf ? '含保密員工' : visibleItems.reduce((s: number, i: any) => s + (i.deduction ?? 0), 0).toFixed(2) },
    { '項目': '應付總額', '值': hasConf ? '含保密員工，僅老闆可見' : visibleItems.reduce((s: number, i: any) => s + (i.totalPayable ?? 0), 0).toFixed(2) },
  ]
  const ws2 = XLSX.utils.json_to_sheet(summary)
  ws2['!cols'] = [{ wch: 15 }, { wch: 20 }]
  XLSX.utils.book_append_sheet(wb, ws2, '摘要')

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  const excelFilename = `payroll_${periodMonth}_${clinicName}.xlsx`
  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="payroll.xlsx"; filename*=UTF-8''${encodeURIComponent(excelFilename)}`,
    },
  })
}

function loadChineseFont(doc: jsPDF): boolean {
  const fontB64 = getFontB64()
  if (!fontB64) return false
  doc.addFileToVFS('NotoSansTC.ttf', fontB64)
  doc.addFont('NotoSansTC.ttf', 'NotoSansTC', 'normal')
  doc.setFont('NotoSansTC')
  return true
}

function exportToPDF(run: any, periodMonth: string, clinicName: string, isOwner: boolean): NextResponse {
  const doc = new jsPDF('p', 'mm', 'a4')
  const hasChineseFont = loadChineseFont(doc)

  const company = run.clinic?.company

  // ── Header with optional logo ──
  let y = 14
  if (company?.logoData) {
    try {
      doc.addImage(company.logoData, 'PNG', 14, 10, 24, 0)
      y = 26
    } catch {
      // logo render failed, ignore
    }
  }

  if (hasChineseFont) {
    doc.setFontSize(14)
    doc.text(`${company?.name || ''} — ${clinicName} 計糧表（${periodMonth}）`, 14, y)
    y += 6
  } else {
    doc.setFontSize(14)
    doc.text(`${company?.name || ''} - ${clinicName} Payroll (${periodMonth})`, 14, y)
    y += 6
  }

  doc.setFontSize(10)
  doc.text(`Period: ${periodMonth}  |  Clinic: ${clinicName}  |  Status: ${run.status}`, 14, y)
  y += 4

  const tableData = run.items.map((item: any) => {
    const clinics = item.employee.clinics.map((c: any) => c.clinic.name).join(', ')
    return [
      item.employee.user.name, clinics,
      item.workedHours.toFixed(1), item.otHours.toFixed(1),
      item.leaveDays.toFixed(1), item.absentDays.toFixed(1),
      `$${fmtConfInt(item.basePay)}`, `$${fmtConfInt(item.otPay)}`,
      item.splitPay != null ? `$${fmtConfInt(item.splitPay)}` : '-',
      `$${fmtConfInt(item.deduction)}`, `$${fmtConfInt(item.storeBonus)}`,
      `$${fmtConfInt(item.totalPayable)}`,
    ]
  })

  const headerLabels = hasChineseFont
    ? ['姓名', '診所', '工時', '加班', '請假', '缺勤', '基本', '加班費', '拆帳', '扣款', '店舖獎金', '應付']
    : ['Name', 'Clinic', 'Hours', 'OT', 'Leave', 'Absent', 'Base', 'OT Pay', 'Split', 'Deduct', 'Bonus', 'Total']

  autoTable(doc, {
    startY: y,
    head: [headerLabels],
    body: tableData,
    styles: {
      font: hasChineseFont ? 'NotoSansTC' : 'helvetica',
      fontSize: hasChineseFont ? 9 : 8,
    },
    headStyles: {
      fillColor: [41, 128, 185],
      font: hasChineseFont ? 'NotoSansTC' : 'helvetica',
      fontStyle: 'normal',
    },
  })

  const finalY = (doc as any).lastAutoTable.finalY + 10
  const hasConf = hasConfidentialItems(run.items, isOwner ? 'OWNER' : 'MANAGER')
  doc.setFontSize(10)

  if (hasConf && !isOwner) {
    const label = hasChineseFont ? '應付總額: 含保密員工，僅老闆可見' : 'Total: Includes confidential employees, owner only'
    doc.text(label, 14, finalY)
  } else {
    const totalPayable = run.items.reduce((s: number, i: any) => s + (i.totalPayable ?? 0), 0)
    const prefix = hasChineseFont ? '應付總額: HK$' : 'Total: HK$'
    doc.text(`${prefix}${totalPayable.toFixed(2)}`, 14, finalY)
  }

  const empLabel = hasChineseFont ? `員工數: ${run.items.length}` : `Employees: ${run.items.length}`
  doc.text(empLabel, 14, finalY + 6)

  const buf = Buffer.from(doc.output('arraybuffer') as ArrayBuffer)
  const pdfFilename = `計糧_${periodMonth}_${clinicName}.pdf`
  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="payroll.pdf"; filename*=UTF-8''${encodeURIComponent(pdfFilename)}`,
    },
  })
}
