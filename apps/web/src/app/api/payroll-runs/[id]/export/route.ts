export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolvePayrollScope, getConfidentialScope } from '@/lib/scope-helpers'
import { toHKDateStr } from '@/lib/hk-date'
import { EXPORT_COLS, EXPORT_COLS_DEFAULT } from '@/lib/payroll-export-cols'
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
  const isOwner = session.role === 'OWNER' // ROLE-OK：保密員工隔離刻意用 role

  const body = await req.json().catch(() => ({})) // empty body = default xlsx
  const format = body.format || 'xlsx'

  const run = await prisma.payrollRun.findUnique({
    where: { id: params.id },
    include: {
      clinic: {
        select: {
          id: true,
          name: true,
          company: { select: { name: true, logoData: true, payrollExportCols: true } },
        },
      },
      items: {
        include: {
          employee: {
            select: {
              payConfidential: true,
              homeClinicId: true,
              user: { select: { name: true, phone: true, fullName: true } },
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

  // ★ Cross-clinic guard (2026-08-03): 被限制範圍嘅人唔可以匯出跨店計糧單
  const allowed = await resolvePayrollScope(session, auth.perms ?? [], {
    homeOnly: ['payroll_view', 'payroll_generate'],
  })
  if (allowed !== null) {
    if (!run.clinicId) {
      return NextResponse.json({ error: '你冇權限匯出跨店計糧單' }, { status: 403 })
    }
    if (!allowed.includes(run.clinicId)) {
      return NextResponse.json({ error: '你冇權限匯出呢間診所嘅計糧單' }, { status: 403 })
    }
  }

  // ★ Confidential filter — 用 getConfidentialScope 一次過算好範圍（2026-08-03）
  const perms = auth.perms ?? []
  const confidentialScope = await getConfidentialScope(session, perms)
  let items = run.items
  if (confidentialScope !== null) {
    items = items.filter((item: any) =>
      !item.employee?.payConfidential || (!!item.employee?.homeClinicId && confidentialScope.includes(item.employee.homeClinicId))
    )
  }

  const runData = { ...run, items }
  const periodMonth = toHKDateStr(run.periodMonth).slice(0, 7)
  const clinicName = run.clinic?.name || '全部診所'

  // ★ cwm-acct-20260917 A9：匯出係敏感操作 — 必留審計（visible items 數，保密已濾）
  await prisma.auditLog.create({
    data: {
      actorId: session.userId, action: 'PAYROLL_EXPORT', entity: 'PayrollRun', entityId: params.id,
      notes: `${format} · ${runData.items.length} 人 · ${runData.status}`,
      ipAddress: req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || null,
    },
  })

  if (format === 'xlsx') return exportToExcel(runData, periodMonth, clinicName)
  return exportToPDF(runData, periodMonth, clinicName)
}

function exportToExcel(run: any, periodMonth: string, clinicName: string): NextResponse {
  // ★ cwm-payrollcols-20260918 B3-4：欄位由公司設定決定（Company.payrollExportCols）；
  //   ⚠️ 只影響【欄】，唔影響【行】—— 行嘅過濾喺 POST 內 getConfidentialScope，唔准郁。
  let cols: string[] = [...EXPORT_COLS_DEFAULT]
  try {
    const saved: any = JSON.parse(run.clinic?.company?.payrollExportCols ?? '[]')
    if (Array.isArray(saved) && saved.length > 0) {
      const validKeys = new Set(EXPORT_COLS.map(c => c.key as string))
      const filtered = saved.filter((k: any) => typeof k === 'string' && validKeys.has(k))
      // 強制項補回（防舊設定／手改漏咗 required 欄）
      for (const c of EXPORT_COLS) if (c.required && !filtered.includes(c.key as string)) filtered.push(c.key as string)
      if (filtered.length > 0) cols = filtered
    }
  } catch { /* 設定解析失敗 → 用預設 */ }

  const labelOf = (k: string) => EXPORT_COLS.find(c => c.key === k)?.label ?? k
  // 數字欄一律 Number((x ?? 0).toFixed(2))（A9 口徑，保持可 SUM()）
  const pick = (item: any, detail: any, key: string): string | number => {
    switch (key) {
      case 'employee': return item.employee.user.name
      case 'clinic': return item.employee.clinics.map((c: any) => c.clinic.name).join(', ')
      case 'payType': return item.employee.payRules[0]?.payType || 'N/A'
      case 'workedHours': return Number((item.workedHours ?? 0).toFixed(2))
      case 'otHours': return Number((item.otHours ?? 0).toFixed(2))
      case 'leaveDays': return Number((item.leaveDays ?? 0).toFixed(2))
      case 'basePay': return Number((item.basePay ?? 0).toFixed(2))
      case 'splitPay': return Number((item.splitPay ?? 0).toFixed(2))
      case 'attendanceBonus': return Number((detail.attendanceBonus ?? 0).toFixed(2))
      case 'storeBonus': return Number((item.storeBonus ?? 0).toFixed(2))
      case 'deduction': return Number((item.deduction ?? 0).toFixed(2))
      case 'grossPay': return Number((detail.grossPay ?? 0).toFixed(2))
      case 'mpf': return Number((detail.mpf ?? 0).toFixed(2))
      case 'mpfEmployer': return Number((detail.mpfEmployer ?? 0).toFixed(2))
      case 'rsGrossAdd': return Number((detail.resignSettlement?.grossAdd ?? 0).toFixed(2))
      case 'excessRestDeduction': return Number((detail.resignSettlement?.excessRestDeduction ?? 0).toFixed(2))
      case 'tbDeduction': return Number((detail.resignSettlement?.tbDeduction ?? 0).toFixed(2))
      case 'tbCashout': return Number((detail.tbCashout ?? 0).toFixed(2))
      case 'miscAmount': return Number((item.miscAmount ?? 0).toFixed(2))
      case 'totalPayable': return Number((item.totalPayable ?? 0).toFixed(2))
      default: return ''
    }
  }

  const rows = run.items.map((item: any) => {
    // ★ Parse detailJson safely — old records may have invalid JSON
    let detail: any = {}
    try { detail = JSON.parse(item.detailJson ?? '{}') } catch { /* fallback to empty */ }
    return Object.fromEntries(cols.map(k => [labelOf(k), pick(item, detail, k)]))
  })

  const COL_WIDTH: Record<string, number> = {
    employee: 12, clinic: 20, payType: 10, workedHours: 10, otHours: 10, leaveDays: 10,
    basePay: 12, splitPay: 10, attendanceBonus: 10, storeBonus: 12, deduction: 10,
    grossPay: 12, mpf: 12, mpfEmployer: 12, rsGrossAdd: 12, excessRestDeduction: 14,
    tbDeduction: 14, tbCashout: 12, miscAmount: 10, totalPayable: 14,
  }

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.json_to_sheet(rows)
  // ★ cwm-payrollcols-20260918 B3-4：!cols 寬度跟住 cols 動態生成
  ws['!cols'] = cols.map(k => ({ wch: COL_WIDTH[k] ?? 12 }))
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
    { '項目': '總病假扣減', '值': visibleItems.reduce((s: number, i: any) => s + ((() => { try { return JSON.parse(i.detailJson ?? '{}').sickDeduction ?? 0 } catch { return 0 } })()), 0).toFixed(2) },
    { '項目': '總勤工獎', '值': visibleItems.reduce((s: number, i: any) => s + ((() => { try { return JSON.parse(i.detailJson ?? '{}').attendanceBonus ?? 0 } catch { return 0 } })()), 0).toFixed(2) },
    { '項目': '總津貼', '值': visibleItems.reduce((s: number, i: any) => s + ((() => { try { return JSON.parse(i.detailJson ?? '{}').totalAllowances ?? 0 } catch { return 0 } })()), 0).toFixed(2) },
    { '項目': '總產假/侍產假', '值': visibleItems.reduce((s: number, i: any) => s + (i.maternityPay ?? 0) + (i.paternityPay ?? 0), 0).toFixed(2) },
    { '項目': '總ADW調整', '值': visibleItems.reduce((s: number, i: any) => s + ((() => { try { return JSON.parse(i.detailJson ?? '{}').adwAdjustment ?? 0 } catch { return 0 } })()), 0).toFixed(2) },
    { '項目': '總MPF', '值': visibleItems.reduce((s: number, i: any) => s + ((() => { try { return JSON.parse(i.detailJson ?? '{}').mpf ?? 0 } catch { return 0 } })()), 0).toFixed(2) },
    { '項目': '總雜項', '值': visibleItems.reduce((s: number, i: any) => s + (i.miscAmount ?? 0), 0).toFixed(2) },
    { '項目': '應付總額（含雜項）', '值': visibleItems.reduce((s: number, i: any) => s + (i.totalPayable ?? 0), 0).toFixed(2) },
  ]
  const ws2 = XLSX.utils.json_to_sheet(summary)
  ws2['!cols'] = [{ wch: 15 }, { wch: 20 }]
  XLSX.utils.book_append_sheet(wb, ws2, '摘要')

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  const excelFilename = `${run.status === 'DRAFT' ? '草稿_' : ''}payroll_${periodMonth}_${clinicName}.xlsx`
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
    let detail: any = {}
    try { detail = JSON.parse(item.detailJson ?? '{}') } catch { /* fallback to empty */ }
    const gross = Number(detail.grossPay ?? 0), mpf = Number(detail.mpf ?? 0)
    const misc = Number(item.miscAmount ?? 0), net = Number(item.totalPayable ?? 0)
    const otherDeduct = Math.round((gross - mpf + misc - net) * 100) / 100   // 行恆等式：Gross − MPF − 其他 + 雜項 = 實發
    return [
      item.employee.user.name, clinics,
      item.workedHours.toFixed(1),
      `$${gross.toFixed(2)}`,
      `$${mpf.toFixed(2)}`,
      `$${otherDeduct.toFixed(2)}`,
      `$${misc.toFixed(2)}`,
      `$${net.toFixed(2)}`,
    ]
  })

  const headerLabels = hasChineseFont
    ? ['姓名', '診所', '工時', 'Gross', 'MPF', '其他扣減', '雜項', '實發']
    : ['Name', 'Clinic', 'Hours', 'Gross', 'MPF', 'Deduct', 'Misc', 'Net']

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
  const prefix = hasChineseFont ? '應付總額（含雜項）: HK$' : 'Total: HK$'
  doc.text(`${prefix}${totalPayable.toFixed(2)}`, 14, finalY)

  const empLabel = hasChineseFont ? `員工數: ${run.items.length}` : `Employees: ${run.items.length}`
  doc.text(empLabel, 14, finalY + 6)

  const buf = Buffer.from(doc.output('arraybuffer') as ArrayBuffer)
  const pdfFilename = `${run.status === 'DRAFT' ? '草稿_' : ''}計糧_${periodMonth}_${clinicName}.pdf`
  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="payroll.pdf"; filename*=UTF-8''${encodeURIComponent(pdfFilename)}`,
    },
  })
}
