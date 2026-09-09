/**
 * GET /api/payout-runs/clinic-report?clinicId=&periodMonth= — 全店月報（cwm-payoutxlsx-20260908 C 章）
 *
 * 一個 workbook：封面 │ <醫生 shortName> × N │ Clinic 雜項
 *  - 醫生頁 = loadDoctorSheetData（同單張匯出同一個共同函數，MD 坑⑥）+ buildDoctorSheet 同一把尺
 *  - 冇 run（LOCKED/FINALIZED）嘅醫生唔出頁（唔出全零頁）
 *  - Clinic 雜項頁 = buildMiscSheet（A 步產生器）；費率口徑 = D2/D3 同一個 resolveMethodRule
 *    （逐行 resolve → 逐行 round2 加總 → 匯總有效費率，同 D3 頁底部三行天然一致）
 *  - 封面 = buildCoverSheet：逐醫生應付總額行（綠字跨 sheet 連結）＋合計＋雜項淨額＋診所總收入（黃底）
 *
 * 權限：OWNER ＋ provider_payout 權限覆蓋（RBAC_MATRIX + RBAC_PERM_OVERRIDES，MD 坑⑧）。
 * Audit：PAYOUT_CLINIC_REPORT_EXPORT（SENSITIVE_AUDIT_SPEC，MD 坑⑦）— notes 標明包含病人姓名。
 * ★★★ 生死格：本 route 純讀 PayoutRun／allocation／cost，唔寫任何金額。
 */
import { NextRequest } from 'next/server'
import ExcelJS from 'exceljs'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { toHKDateStr } from '@/lib/hk-date'
import { getOwnHomeClinicId } from '@/lib/scope-helpers'
import { resolveMethodRule } from '@/lib/apricot/allocate'
import { loadDoctorSheetData, METHOD_LABELS, round2 } from '@/lib/payout/report-data'
import { buildCoverSheet, buildDoctorSheet, buildMiscSheet } from '@/lib/payout/xlsx-report'

const PERIOD_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const sp = new URL(req.url).searchParams
  const clinicId = sp.get('clinicId')
  const periodMonth = sp.get('periodMonth')
  if (!clinicId) return jsonNoStore({ error: '缺少 clinicId' }, { status: 400 })
  if (!periodMonth || !PERIOD_MONTH_RE.test(periodMonth)) {
    return jsonNoStore({ error: '缺少 periodMonth（YYYY-MM）' }, { status: 400 })
  }

  // ─── scope guard（D2 misc-income fail-closed 同 pattern）──────────
  let scopeClinics: string[] | null = null
  if (scope === 'my-clinics') scopeClinics = session.clinics ?? []
  else if (scope === 'self') {
    const home = await getOwnHomeClinicId(session.userId)
    scopeClinics = home ? [home] : []
  }
  if (scopeClinics && !scopeClinics.includes(clinicId)) {
    return jsonNoStore({ error: 'You do not have access to this clinic' }, { status: 403 })
  }

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, name: true, shortName: true },
  })
  if (!clinic) return jsonNoStore({ error: '診所不存在' }, { status: 404 })
  const clinicShort = clinic.shortName || clinic.name

  // ─── 1. 該店該月 FINALIZED（LOCKED）月結單，按應付總額大→細 ──────
  const runs = await prisma.payoutRun.findMany({
    where: { clinicId, periodMonth, status: 'LOCKED' },
    orderBy: { totalAmount: 'desc' },
  })

  // ─── 2. Clinic 雜項（非 void 入合計；void 行照列灰線，A 步產生器處理）──
  const miscRows = await prisma.miscIncome.findMany({
    where: { clinicId, periodMonth },
    orderBy: [{ incomeAt: 'asc' }, { id: 'asc' }],
  })

  if (runs.length === 0 && miscRows.length === 0) {
    return jsonNoStore({ error: `該診所 ${periodMonth} 冇月結單／雜項收入` }, { status: 404 })
  }

  // ─── 3. 逐 run 砌醫生頁（共同攞數函數，MD 坑⑥）───────────────────
  const wb = new ExcelJS.Workbook()
  const doctorEntries: { sheetName: string; sheetLabel: string; status: string; totalAmount: number }[] = []
  for (const run of runs) {
    const loaded = await loadDoctorSheetData(run.id)
    if (!loaded) continue // 理論上唔會發生（run 剛先查過）— 防呆 skip
    const sheetLabel = loaded.provider?.shortName || loaded.provider?.name || '未知'
    loaded.data.sheetNameBase = sheetLabel // sheet 名 = shortName || name（MD C 章）
    const ws = buildDoctorSheet(wb, loaded.data)
    doctorEntries.push({
      sheetName: ws.name,
      sheetLabel,
      status: loaded.data.status,
      totalAmount: Number(loaded.run.totalAmount),
    })
  }

  // ─── 4. Clinic 雜項頁（費率口徑 = D2/D3 同一個 resolveMethodRule）──
  const allRules = await prisma.paymentMethodRule.findMany()
  // 逐行 resolve（needsReview = 規則已刪 → 0，同 D3 頁「按 0 計」口徑）
  const feeOf = (r: { methodNorm: string; incomeAt: Date; amount: number | unknown }): number => {
    const rule = resolveMethodRule(r.methodNorm, r.incomeAt, allRules)
    if (rule.needsReview) return 0
    return round2(Number(r.amount) * rule.feePercent / 100)
  }
  const activeMisc = miscRows.filter(r => !r.isVoid)
  const miscTotal = round2(activeMisc.reduce((s, r) => s + Number(r.amount), 0))
  const miscFee = round2(activeMisc.reduce((s, r) => s + feeOf(r), 0))
  const miscNet = round2(miscTotal - miscFee)
  // 匯總有效費率 → 產生器 淨額 = 合計×(1−費率) 同 D3 頁 淨額 = 合計−Σ逐行費 完全一致
  const miscRate = miscTotal > 0 ? miscFee / miscTotal : 0

  const miscWs = buildMiscSheet(wb, {
    clinicName: clinicShort,
    periodMonth,
    feePercent: miscRate,
    rows: miscRows.map(r => ({
      incomeAt: toHKDateStr(r.incomeAt),
      category: r.category,
      itemName: r.itemName,
      methodLabel: METHOD_LABELS[r.methodNorm] || r.methodNorm,
      note: r.note ?? undefined,
      amount: Number(r.amount),
      isVoid: r.isVoid,
    })),
  })

  // ─── 5. 封面總表（綠字跨 sheet 連結醫生頁／雜項頁；黃底診所總收入）──
  const coverWs = buildCoverSheet(wb, {
    clinicName: clinicShort,
    periodMonth,
    doctors: doctorEntries.map(d => ({
      providerName: d.sheetLabel,
      sheetName: d.sheetName,
      status: d.status,
      totalAmount: d.totalAmount,
    })),
    miscSheetName: miscWs.name,
    miscNet,
  })

  // ─── 6. 頁序：封面 │ 醫生 × N │ Clinic 雜項（ExcelJS 按 orderNo 排序；types 冇暴露，cast）──
  const order: ExcelJS.Worksheet[] = [coverWs, ...doctorEntries.map(d => wb.getWorksheet(d.sheetName)!), miscWs]
  order.forEach((ws, i) => { (ws as unknown as { orderNo: number }).orderNo = i + 1 })

  // ─── 7. Audit（PAYOUT_CLINIC_REPORT_EXPORT — SENSITIVE_AUDIT_SPEC）──
  await prisma.auditLog.create({
    data: {
      actorId: auth.session!.userId,
      action: 'PAYOUT_CLINIC_REPORT_EXPORT',
      entity: 'Clinic',
      entityId: clinicId,
      clinicId,
      // ★ 醫生頁 B/C 區列病人姓名（2026-09-08 拍板）— 審計要查得返
      notes: `匯出全店月度收入報表：${clinicShort} ${periodMonth}（${runs.length} 份月結單＋Clinic 雜項，包含病人姓名）`,
    },
  })

  // ─── 8. Response（檔名 ${clinicShort}_${periodMonth}_月度收入報表.xlsx）──
  const buf = await wb.xlsx.writeBuffer()
  const name = `${clinicShort}_${periodMonth}_月度收入報表.xlsx`
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="clinic_report_${periodMonth}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  })
}
