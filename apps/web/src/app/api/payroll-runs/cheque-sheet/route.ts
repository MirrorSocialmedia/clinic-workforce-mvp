export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolvePayrollScope, getConfidentialScope } from '@/lib/scope-helpers'
import { getMonthRange } from '@/lib/hk-date'
import { PAY_RULE_SELECT } from '@/lib/pay-rule-latest'
import { filterConfidentialItems } from '@/lib/payroll-confidential'
import * as XLSX from 'xlsx'
import { LEGACY_CONFIG, normalizeSheetConfig, type SheetConfig } from '@/lib/cheque-sheet/config'
import { buildChequeWorkbook, sheetRowFrom, type SheetRow, type PlaceRef } from '@/lib/cheque-sheet/build'

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
// ★ cwm-chequetpl-20261004：Excel 生成搬去 lib/cheque-sheet/build.ts；老闆可以揀模版（?template=）
//   ＋出糧診所設定（ChequeSheetPayer）。冇揀模版／唔係老闆 = LEGACY_CONFIG（同舊版逐格一樣）

const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth
  const perms = auth.perms ?? []

  const ym = new URL(req.url).searchParams.get('month')
  // ★ cwm-leaveasoffix-20260923 S8-1：舊 regex 收 2026-13 → new Date 出 Invalid Date → getMonthRange RangeError → 500
  if (!ym || !/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) {
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
          // ★ cwm-chequetpl-20261004：模版可揀嘅其他欄
          workedHours: true, otHours: true, leaveDays: true, absentDays: true, basePay: true, otPay: true,
          splitPay: true, deduction: true, storeBonus: true, maternityPay: true, paternityPay: true,
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

  // ★ cwm-chequetpl-20261004：自訂模版只限老闆；其他人（或者冇揀模版）= LEGACY_CONFIG，輸出同改之前一樣
  const isOwner = session.role === 'OWNER' // ROLE-OK: 老闆拍板「呢個功能只俾老闆用」
  const templateId = new URL(req.url).searchParams.get('template')
  let config: SheetConfig = LEGACY_CONFIG
  let templateName: string | null = null
  if (templateId && isOwner) {
    const tpl = await prisma.chequeSheetTemplate.findUnique({ where: { id: templateId } })
    if (!tpl) return NextResponse.json({ error: '搵唔到呢個模版' }, { status: 404 })
    try { config = normalizeSheetConfig(JSON.parse(tpl.configJson)) } catch { config = normalizeSheetConfig({}) }
    templateName = tpl.name
  }

  // 出糧診所設定（只有用模版先睇；舊格式 = 計糧單所屬診所）
  const payerByEmp = new Map<string, { payerClinicId: string | null; sortOrder: number | null }>()
  const clinicById = new Map<string, PlaceRef>()
  if (templateName !== null) {
    const [payers, clinics] = await Promise.all([
      prisma.chequeSheetPayer.findMany({ select: { employeeId: true, payerClinicId: true, sortOrder: true } }),
      prisma.clinic.findMany({ select: { id: true, name: true, company: { select: { id: true, name: true } } } }),
    ])
    payers.forEach(p => payerByEmp.set(p.employeeId, p))
    clinics.forEach(c => clinicById.set(c.id, { clinicId: c.id, clinicName: c.name, companyId: c.company?.id ?? null, companyName: c.company?.name ?? '全部診所' }))
  }

  const rows: SheetRow[] = []
  for (const run of runs) {
    // 公司／診所由 run 嘅 clinic 決定（佢喺邊間店出糧）
    const home: PlaceRef = {
      clinicId: run.clinic?.id ?? null, clinicName: run.clinic?.name ?? '',
      companyId: run.clinic?.company?.id ?? null, companyName: run.clinic?.company?.name ?? '全部診所',
    }
    const confItems = filterConfidentialItems(run.items as any[], confScope)
    // ★ cwm-chequeexcl-20261004：模版剔走嘅員工唔匯出（LEGACY 冇清單 = 全部照出）
    const excluded = new Set(config.excludedEmployeeIds)
    for (const item of confItems as any[]) {
      if (excluded.has(item.employee?.id)) continue
      const p = payerByEmp.get(item.employee?.id)
      const payer = (p?.payerClinicId && clinicById.get(p.payerClinicId)) || home
      rows.push(sheetRowFrom(item, { home, payer, groupBy: config.groupBy, sortOrder: p?.sortOrder ?? null }))
    }
  }

  const wb = buildChequeWorkbook(rows, config, { monthAbbr, anyDraft })
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })

  // ★ 敏感操作審計（同 PAYROLL_EXPORT 口徑：month + 人數 + DRAFT 狀態，零 PII）
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'PAYROLL_CHEQUE_SHEET',
      entity: 'PayrollRun',
      entityId: ym,
      notes: `${ym} · ${rows.length} 人${anyDraft ? ' · 含 DRAFT' : ''}${templateName ? ` · 模版「${templateName}」` : ''}`,
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
