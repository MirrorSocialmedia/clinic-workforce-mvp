export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { toHKDateStr } from '@/lib/hk-date'
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
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  const isOwner = session.role === 'OWNER'

  const body = await req.json().catch(() => ({})) // empty body = default xlsx
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

  // ★ Non-OWNER: filter out confidential employee rows entirely (not just mask)
  let items = run.items
  if (!isOwner) {
    items = items.filter((item: any) => !item.employee?.payConfidential)
  }

  const runData = { ...run, items }
  const periodMonth = toHKDateStr(run.periodMonth).slice(0, 7)
  const clinicName = run.clinic?.name || '全部診所'

  if (format === 'xlsx') return exportToExcel(runData, periodMonth, clinicName)
  return exportToPDF(runData, periodMonth, clinicName)
}

function exportToExcel(run: any, periodMonth: string, clinicName: string): NextResponse {
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
      '基本薪資': (item.basePay ?? 0).toFixed(2),
      '加班費': (item.otPay ?? 0).toFixed(2),
      '拆帳': (item.splitPay ?? 0).toFixed(2),
      '扣款': (item.deduction ?? 0).toFixed(2),
      '雜項': (item.miscAmount ?? 0).toFixed(2),
      '店舖獎金': (item.storeBonus ?? 0).toFixed(2),
      '應付總額': (item.totalPayable ?? 0).toFixed(2),
    }
  })

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.json_to_sheet(rows)
  ws['!cols'] = [
    { wch: 12 }, { wch: 15 }, { wch: 20 }, { wch: 10 },
    { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
    { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 12 }, { wch: 12 },
  ]
  XLSX.utils.book_append_sheet(wb, ws, '糧單')

  // ★ Totals from visible items only
  const visibleItems = run.items
  const summary = [
    { '項目': '計糧期間', '值': periodMonth },
    { '項目': '診所', '值': clinicName },
    { '項目': '狀態', '值': run.status },
    { '項目': '員工數', '值': visibleItems.length },
    { '項目': '總基本薪資', '值': visibleItems.reduce((s: number, i: any) => s + (i.basePay ?? 0), 0).toFixed(2) },
    { '項目': '總加班費', '值': visibleItems.reduce((s: number, i: any) => s + (i.otPay ?? 0), 0).toFixed(2) },
    { '項目': '總拆帳', '值': visibleItems.reduce((s: number, i: any) => s + (i.splitPay ?? 0), 0).toFixed(2) },
    { '項目': '總店舖獎金', '值': visibleItems.reduce((s: number, i: any) => s + (i.storeBonus ?? 0), 0).toFixed(2) },
    { '項目': '總扣款', '值': visibleItems.reduce((s: number, i: any) => s + (i.deduction ?? 0), 0).toFixed(2) },
    { '項目': '總雜項', '值': visibleItems.reduce((s: number, i: any) => s + (i.miscAmount ?? 0), 0).toFixed(2) },
    { '項目': '應付總額', '值': visibleItems.reduce((s: number, i: any) => s + (i.totalPayable ?? 0), 0).toFixed(2) },
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

function exportToPDF(run: any, periodMonth: string, clinicName: string): NextResponse {
  const doc = new jsPDF('p', 'mm', 'a4')
  const hasChineseFont = loadChineseFont(doc)

  const company = run.clinic?.company

  // ── Header with optional logo (top-right) ──
  let y = 14
  if (company?.logoData) {
    try {
      const pageW = doc.internal.pageSize.getWidth()
      const logoW = 24
      doc.addImage(company.logoData, 'PNG', pageW - 14 - logoW, 10, logoW, 0)
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
      `$${(item.basePay ?? 0).toFixed(0)}`, `$${(item.otPay ?? 0).toFixed(0)}`,
      (item.splitPay != null ? `$${(item.splitPay ?? 0).toFixed(0)}` : '-'),
      `$${(item.deduction ?? 0).toFixed(0)}`, `+${(item.miscAmount ?? 0).toFixed(0)}`,
      `$${(item.storeBonus ?? 0).toFixed(0)}`,
      `$${(item.totalPayable ?? 0).toFixed(0)}`,
    ]
  })

  const headerLabels = hasChineseFont
    ? ['姓名', '診所', '工時', '加班', '請假', '缺勤', '基本', '加班費', '拆帳', '扣款', '雜項', '店舖獎金', '應付']
    : ['Name', 'Clinic', 'Hours', 'OT', 'Leave', 'Absent', 'Base', 'OT Pay', 'Split', 'Deduct', 'Misc', 'Bonus', 'Total']

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

  // ★ Totals from visible items only
  const finalY = (doc as any).lastAutoTable.finalY + 10
  doc.setFontSize(10)

  const totalPayable = run.items.reduce((s: number, i: any) => s + (i.totalPayable ?? 0), 0)
  const prefix = hasChineseFont ? '應付總額: HK$' : 'Total: HK$'
  doc.text(`${prefix}${totalPayable.toFixed(2)}`, 14, finalY)

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
