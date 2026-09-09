/**
 * GET /api/payout-runs/[id]/export — Excel 匯出（單頁月報，六區 layout）
 * ★ 2026-09-10 cwm-payoutxlsx-20260908 B 章：改用 exceljs 產生器（lib/payout/xlsx-report.ts）。
 *   六區：A 逐日 / B Lab（含 Invisalign）/ C Implant / D SP+REF / E 調整 / F 結算。
 * ★ AA3 已廢（2026-09-08 老細拍板）：B 區（Lab）同 C 區（Implant）列病人姓名
 *   （來源 CostCase.patientName）；PAYOUT_EXPORT audit notes 標明「包含病人姓名」。
 * ★ 數字零改變（B 章唯一驗收）：攞數段照舊，舊 A/B/C/D/E 區金額由新六區重現
 *   （舊 G 付款逐筆 / H 工廠總覽（跨醫生）剷走 — 屬舊系統附加，MD 樣板六區冇）。
 * ★ MD-AC2 ②：付款方式欄由資料 derive（ORDER 固定次序，未知方式排最後）
 * ★ 費率（F 區手續費率行）= 由 allocation 快照反解（net = raw×(1−fee)）—
 *   allocation 落庫時費率已係 PaymentMethodRule resolve 快照（feePercentUsed），
 *   反解保證同舊 A 區 Weighted / engine gross 一分不差；D2 章 export resolveMethodRule 後可換即時費率。
 * ★ 2026-09-10 C 步：攞數段抽出做共同函數 loadDoctorSheetData（lib/payout/report-data.ts）—
 *   同全店月報（api/payout-runs/clinic-report）共用（MD 坑⑥：兩個入口唔准各寫一次）。
 */
import { NextRequest } from 'next/server'
import ExcelJS from 'exceljs'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { loadDoctorSheetData } from '@/lib/payout/report-data'
import { buildDoctorSheet } from '@/lib/payout/xlsx-report'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const id = (await params).id

  // ★ 共同攞數函數（MD 坑⑥）：同 clinic-report route 同一把尺
  const loaded = await loadDoctorSheetData(id)
  if (!loaded) return jsonNoStore({ error: '月結單不存在' }, { status: 404 })
  const { run, data } = loaded
  const providerShort = loaded.provider?.shortName || loaded.provider?.name || '未知'
  const clinicShort = loaded.clinic?.shortName || loaded.clinic?.name || '診所'

  // ─── Build workbook（單 sheet，sheet 名 = 醫生名） ─────────────
  const wb = new ExcelJS.Workbook()
  buildDoctorSheet(wb, data)

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: auth.session!.userId,
      action: 'PAYOUT_EXPORT',
      entity: 'PayoutRun',
      entityId: run.id,
      // ★ 規則⑤：匯出包含病人姓名（B/C 區）— 審計要查得返
      notes: `匯出月度收入報表：${run.periodMonth}（包含病人姓名）`,
    },
  })

  // Generate buffer
  const buf = await wb.xlsx.writeBuffer()

  // ★ MD-AC2：檔名 ${providerShort}_${clinicShort}_${periodMonth}_月結單.xlsx
  //   中文檔名一定要 filename*=UTF-8''（部分瀏覽器純 filename="中文" 會亂碼）
  const name = `${providerShort}_${clinicShort}_${run.periodMonth}_月結單.xlsx`
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="payout_${run.periodMonth}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  })
}
