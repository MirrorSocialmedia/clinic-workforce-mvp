export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolvePayrollScope, getConfidentialScope } from '@/lib/scope-helpers'
import { getMonthRange } from '@/lib/hk-date'
import { PAY_RULE_SELECT } from '@/lib/pay-rule-latest'
import { filterConfidentialItems } from '@/lib/payroll-confidential'
import * as XLSX from 'xlsx'

// ★ cwm-payrollsheet-20260921 S4：月度出糧總表（全部診所一張，按公司排）
//   GET /api/payroll-runs/cheque-sheet?month=YYYY-MM
//   欄來源逐個對過引擎（S1 教訓，check-detail-keys.sh READERS 已收呢個 route）：
//     Net Pay  = detail.netPay（:3848 頂層）
//     MPF      = detail.mpf（:3921 頂層）
//     Salary   = detail.grossPay（:3843 頂層）
//     FARE     = item.miscAmount（PayrollItem 欄）
//     Total    = item.totalPayable（已含雜項）
//     Cheque No = item.chequeNo（S3，TEXT 前導零）
//   ★ 三條恆等式（每行）：Salary − MPF − 時間帳戶欠款 = Net Pay；Net Pay + FARE = Total
//     時間帳戶欠款 = detail.resignSettlement?.tbDeduction（NESTED — 禁讀 top-level，L3 guard）
//   ★ 保密過濾照抄 export（共用 filterConfidentialItems）；唔另開 query 攞 detail（B0）
//   ★ 公司由 run 嘅 clinic 決定（喺邊間店出糧），唔係員工 homeClinicId

const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  const perms = auth.perms ?? []

  const ym = new URL(req.url).searchParams.get('month')
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) {
    return NextResponse.json({ error: 'month 格式 YYYY-MM' }, { status: 400 })
  }
  const { start, end } = getMonthRange(new Date(`${ym}-01T00:00:00+08:00`))

  // ★ 診所範圍：同計糧列表一樣（resolvePayrollScope）—— 會計只見所屬公司
  const allowed = await resolvePayrollScope(session, perms, {
    homeOnly: ['payroll_view', 'payroll_generate'],
  })
  const runWhere: any = { periodMonth: { gte: start, lte: end } }
  if (allowed !== null) runWhere.clinicId = { in: allowed }

  const runs = await prisma.payrollRun.findMany({
    where: runWhere,
    select: {
      id: true,
      status: true,
      clinic: { select: { id: true, name: true, company: { select: { id: true, name: true } } } },
      items: {
        select: {
          id: true, detailJson: true, miscAmount: true, totalPayable: true, chequeNo: true,
          employee: {
            select: {
              id: true, payConfidential: true, homeClinicId: true,
              user: { select: { name: true, fullName: true } },
              payRules: PAY_RULE_SELECT,
            },
          },
        },
      },
    },
  })

  if (runs.length === 0) {
    return NextResponse.json({ error: `冇 ${ym} 嘅計糧單` }, { status: 404 })
  }

  // ★★★ 保密員工過濾 —— 同 export 一模一樣（共用 helper）
  const confScope = await getConfidentialScope(session, perms)
  const anyDraft = runs.some(r => r.status === 'DRAFT')
  const monthAbbr = MONTH_ABBR[Number(ym.slice(5, 7)) - 1] ?? ym

  // 展開成平鋪 rows（公司標籤由 run.clinic 決定 — 佢喺邊間店出糧）
  type Row = {
    companyKey: string
    companyName: string
    nickname: string
    fullName: string
    basic: number | string | null   // 月薪 = 數字；時薪 = "100 /HR"
    net: number
    mpf: number
    salary: number
    fare: number
    total: number
    cheque: string
    note: string
  }
  const rows: Row[] = []
  for (const run of runs) {
    const companyName = run.clinic?.company?.name ?? '全部診所'
    const confItems = filterConfidentialItems(run.items as any[], confScope)
    for (const item of confItems as any[]) {
      // ⚠️ guard 對 `detail.` 讀取逐個核引擎寫入層 — 變數名必須係 detail
      const detail = item.detailJson ? JSON.parse(item.detailJson) : {}
      const salary = Number(detail.grossPay) || 0
      const mpf = Number(detail.mpf) || 0
      const net = Number(detail.netPay) || 0
      const fare = Number(item.miscAmount) || 0
      const total = Number(item.totalPayable) || 0
      // 時間帳戶欠款（離職扣減）— nested 讀法（L3 guard 禁 top-level）
      const tbDed = Number(detail.resignSettlement?.tbDeduction) || 0

      // Basic Salary：月薪 = configJson.monthly_salary；時薪 = "100 /HR"
      let basic: number | string | null = null
      try {
        const cfg = item.employee?.payRules?.[0]?.configJson
          ? (JSON.parse(item.employee.payRules[0].configJson) as any)
          : null
        if (cfg?.base_type === 'hourly' && typeof cfg.hourly_rate === 'number') {
          basic = `${cfg.hourly_rate} /HR`
        } else if (typeof cfg?.monthly_salary === 'number') {
          basic = cfg.monthly_salary
        }
      } catch { /* configJson 損壞 → Basic 留空（其餘欄照出實數） */ }

      // 恆等式檢查 + 備註（tbDed > 0 嘅行加「含離職扣減 $X」— 手寫表冇呢欄，防人以為計錯）
      const notes: string[] = []
      if (tbDed > 0) notes.push(`含離職扣減 $${tbDed.toFixed(2)}`)
      if (Math.abs(salary - mpf - tbDed - net) > 0.005) notes.push('⚠ Net Pay 截零（負數）')
      if (Math.abs(net + fare - total) > 0.005) notes.push('⚠ Net+FARE≠Total')

      rows.push({
        companyKey: run.clinic?.company?.id ?? '__all__',
        companyName,
        nickname: item.employee?.user?.name ?? '',
        fullName: item.employee?.user?.fullName ?? item.employee?.user?.name ?? '',
        basic, net, mpf, salary, fare, total,
        cheque: item.chequeNo ?? '',
        note: notes.join('；'),
      })
    }
  }

  // ★ 拍板④：按公司 → 公司內按暱稱
  rows.sort((a, b) =>
    (a.companyName ?? '').localeCompare(b.companyName ?? '', 'zh-HK') ||
    (a.nickname ?? '').localeCompare(b.nickname ?? '', 'en'))

  // ── 建 sheet ──
  // 欄：0 暱稱 1 Full Name 2 B.Basic Salary 3 Net Pay 4 MPF 5 Salary 6 FARE 7 Total 8 Cheque No. 9 備註
  const HEADERS = ['暱稱', 'Full Name', 'B.Basic Salary', 'Net Pay', 'MPF', 'Salary', 'FARE', 'Total', 'Cheque No.', '備註']
  const aoa: (string | number | null)[][] = []
  // 第 1 行：月份縮寫（Basic Salary 欄上面）
  const row1: (string | number | null)[] = HEADERS.map(() => null)
  row1[2] = monthAbbr
  aoa.push(row1)
  // 第 2 行：表頭
  aoa.push(HEADERS)
  // 第 3 行（可選）：DRAFT 警告（紅字係 xlsx Pro 功能，CE 出唔到 → 純文字行，見 progress D-2）
  let dataStart = 2 // 0-based row index of first data row
  if (anyDraft) {
    aoa.push(['⚠️ 包含未確認計糧單（DRAFT）—— 數字未必最終', null, null, null, null, null, null, null, null, null])
    dataStart = 3
  }
  let lastCompanyKey: string | null = null
  for (const r of rows) {
    if (r.companyKey !== lastCompanyKey) {
      lastCompanyKey = r.companyKey
      aoa.push([`── ${r.companyName} `, null, null, null, null, null, null, null, null, null])
    }
    aoa.push([
      r.nickname, r.fullName,
      r.basic === null ? null : r.basic,
      r.net, r.mpf, r.salary, r.fare, r.total,
      r.cheque, r.note || null,
    ])
  }
  // 合計行（SUM 公式 — 唔好 a+b，cwm-costui-xlsxfix 踩過 #VALUE!；另帶 cached value 防未重算顯示 0）
  const sumRow: (string | number | null)[] = HEADERS.map(() => null)
  sumRow[0] = '合計'
  aoa.push(sumRow)
  const sumRowIndex = aoa.length - 1 // 0-based

  const ws = XLSX.utils.aoa_to_sheet(aoa)

  // ★ 範圍 = 首個 data row → 最後個 data row（公司分隔行係文字，SUM 自動忽略）
  const firstDataR = dataStart // 0-based
  // 實際最後 data row = 合計行前一塊嘅數字行 — 用 SUM 範圍包含分隔行都安全（文字忽略）
  const sumLastR = sumRowIndex - 1
  const moneyCols = [2, 3, 4, 5, 6, 7] // Basic Salary（數字部分）、Net、MPF、Salary、FARE、Total
  const sums = rows.reduce(
    (acc, r) => {
      if (typeof r.basic === 'number') acc[2] += r.basic
      acc[3] += r.net; acc[4] += r.mpf; acc[5] += r.salary; acc[6] += r.fare; acc[7] += r.total
      return acc
    },
    { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 } as Record<number, number>,
  )
  for (const c of moneyCols) {
    const addr = XLSX.utils.encode_cell({ r: sumRowIndex, c })
    ws[addr] = { t: 'n', f: `SUM(${XLSX.utils.encode_col(c)}${firstDataR + 1}:${XLSX.utils.encode_col(c)}${sumLastR + 1})`, v: Math.round(sums[c] * 100) / 100, z: '#,##0.00' }
  }
  // 金額欄 #,##0.00（data rows + sum row；/HR 文字 cell 唔動）
  for (let ri = firstDataR; ri <= sumLastR; ri++) {
    for (const c of moneyCols) {
      const addr = XLSX.utils.encode_cell({ r: ri, c })
      const cell = ws[addr]
      if (cell && cell.t === 'n') cell.z = '#,##0.00'
    }
  }
  // Cheque No. 強制文字 cell（防 Excel 食前導零 — aoa 已係 string，再強制 t:'s' 雙保險）
  for (let ri = firstDataR; ri <= sumLastR; ri++) {
    const addr = XLSX.utils.encode_cell({ r: ri, c: 8 })
    const cell = ws[addr]
    if (cell && cell.v !== null && cell.v !== undefined) { cell.t = 's' }
  }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '出糧總表')
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })

  // ★ 敏感操作審計（同 PAYROLL_EXPORT 口徑：month + 人數 + DRAFT 狀態，零 PII）
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'PAYROLL_CHEQUE_SHEET',
      entity: 'PayrollRun',
      entityId: ym,
      notes: `${ym} · ${rows.length} 人${anyDraft ? ' · 含 DRAFT' : ''}`,
      ipAddress: req.headers.get('x-forwarded-for') || null,
      userAgent: req.headers.get('user-agent') || null,
    },
  })

  const filename = `${anyDraft ? '草稿_' : ''}出糧總表_${ym}.xlsx`
  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="cheque-sheet-${ym}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store, must-revalidate',
    },
  })
}
