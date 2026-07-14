export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { toHKDateStr } from '@/lib/hk-date'
import { maskIfConfidential, hasConfidentialItems } from '@/lib/payroll-engine'
import * as XLSX from 'xlsx'
import { jsPDF } from 'jspdf'
import 'jspdf-autotable'

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
      clinic: { select: { id: true, name: true } },
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
      '應付總額': fmtConf(item.totalPayable),
    }
  })

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.json_to_sheet(rows)
  ws['!cols'] = [
    { wch: 12 }, { wch: 15 }, { wch: 20 }, { wch: 10 },
    { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
    { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 12 },
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
    { '項目': '總扣款', '值': hasConf ? '含保密員工' : visibleItems.reduce((s: number, i: any) => s + (i.deduction ?? 0), 0).toFixed(2) },
    { '項目': '應付總額', '值': hasConf ? '含保密員工，僅老闆可見' : visibleItems.reduce((s: number, i: any) => s + (i.totalPayable ?? 0), 0).toFixed(2) },
  ]
  const ws2 = XLSX.utils.json_to_sheet(summary)
  ws2['!cols'] = [{ wch: 15 }, { wch: 20 }]
  XLSX.utils.book_append_sheet(wb, ws2, '摘要')

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="payroll_${periodMonth}_${clinicName}.xlsx"`,
    },
  })
}

function exportToPDF(run: any, periodMonth: string, clinicName: string, isOwner: boolean): NextResponse {
  const doc = new jsPDF('p', 'mm', 'a4')
  doc.setFontSize(16)
  doc.text('診所員工糧單', 14, 20)
  doc.setFontSize(10)
  doc.text(`期間: ${periodMonth}  |  診所: ${clinicName}  |  狀態: ${run.status}`, 14, 28)

  const tableData = run.items.map((item: any) => {
    const clinics = item.employee.clinics.map((c: any) => c.clinic.name).join(', ')
    return [
      item.employee.user.name, clinics,
      item.workedHours.toFixed(1), item.otHours.toFixed(1),
      item.leaveDays.toFixed(1), item.absentDays.toFixed(1),
      `$${fmtConfInt(item.basePay)}`, `$${fmtConfInt(item.otPay)}`,
      item.splitPay != null ? `$${fmtConfInt(item.splitPay)}` : '-',
      `$${fmtConfInt(item.deduction)}`, `$${fmtConfInt(item.totalPayable)}`,
    ]
  })

  // @ts-ignore — jspdf-autotable extends jsPDF
  doc.autoTable({
    startY: 34,
    head: [['姓名', '診所', '工時', '加班', '請假', '缺勤', '基本', '加班費', '拆帳', '扣款', '應付']],
    body: tableData,
    styles: { fontSize: 8 },
    headStyles: { fillColor: [41, 128, 185] },
  })

  const finalY = (doc as any).lastAutoTable.finalY + 10
  const hasConf = hasConfidentialItems(run.items, isOwner ? 'OWNER' : 'MANAGER')
  doc.setFontSize(10)
  if (hasConf && !isOwner) {
    doc.text('應付總額: 含保密員工，僅老闆可見', 14, finalY)
  } else {
    const totalPayable = run.items.reduce((s: number, i: any) => s + (i.totalPayable ?? 0), 0)
    doc.text(`應付總額: HK$${totalPayable.toFixed(2)}`, 14, finalY)
  }
  doc.text(`員工數: ${run.items.length}`, 14, finalY + 6)

  const buf = Buffer.from(doc.output('arraybuffer') as ArrayBuffer)
  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="payroll_${periodMonth}_${clinicName}.pdf"`,
    },
  })
}
