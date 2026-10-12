/**
 * GET /api/payout-runs/export-zip?clinicId=&periodMonth= — 一鍵匯出（全店＋逐個醫生）（★ cwm-exportzip-20261012）
 *
 * 一個 ZIP：
 *   00-<店>-<月>-全店月報.xlsx      ＝「月度收入報表」同一份（lib/payout/clinic-report-build，同一把尺）
 *   <醫生全名>-<店>-<月>.xlsx × N   ＝ 每張【已鎖定】月結單嘅單張匯出（同 /api/payout-runs/[id]/export 同一個產生器）
 *   未鎖定醫生（草稿）唔出獨立檔（老闆 2026-10-12：避免 send 錯數俾醫生）→ 列喺「未有獨立檔.txt」
 *
 * 對數防線（P-4）：任何一位醫生 Excel 應付 ≠ 系統鎖定 → 成個 ZIP 唔出（409）＋ PAYOUT_EXPORT_MISMATCH。
 * 權限：同全店月報（OWNER ＋ provider_payout；店舖帳號只限自己店）。
 * Audit：PAYOUT_EXPORT_ZIP（含病人姓名，列明幾多份）。★★★ 純讀，唔寫任何金額。
 */
import { NextRequest } from 'next/server'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { getOwnHomeClinicId } from '@/lib/scope-helpers'
import { payoutClinicGuard } from '@/lib/payout/kiosk-scope'
import { buildClinicReport } from '@/lib/payout/clinic-report-build'
import { loadDoctorSheetData } from '@/lib/payout/report-data'
import { buildDoctorSheet } from '@/lib/payout/xlsx-report'
import { zipFileName } from '@/lib/payout/export-zip-names'

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

  // ─── scope guard（同全店月報）──────────
  let scopeClinics: string[] | null = null
  if (scope === 'my-clinics') scopeClinics = session.clinics ?? []
  else if (scope === 'self') {
    const home = await getOwnHomeClinicId(session.userId)
    scopeClinics = home ? [home] : []
  }
  if (scopeClinics && !scopeClinics.includes(clinicId)) {
    return jsonNoStore({ error: 'You do not have access to this clinic' }, { status: 403 })
  }
  { const denied = payoutClinicGuard(session, clinicId); if (denied) return denied }

  // ─── 1. 全店月報（同「月度收入報表」同一份；內含 P-4 對數防線）──
  const built = await buildClinicReport({ clinicId, periodMonth, actorId: session.userId })
  if (!built.ok) return jsonNoStore({ error: built.error }, { status: built.status })
  const { clinicShort } = built

  const zip = new JSZip()
  const used = new Set<string>()
  zip.file(zipFileName(`00-${clinicShort}-${periodMonth}-全店月報`, used), await built.wb.xlsx.writeBuffer())

  // ─── 2. 逐個【已鎖定】醫生獨立檔（同單張匯出同一個產生器）──
  const mismatches: string[] = []
  let doctorFiles = 0
  for (const run of built.runs) {
    const loaded = await loadDoctorSheetData(run.id)
    if (!loaded) continue
    const wb = new ExcelJS.Workbook()
    const { payable } = buildDoctorSheet(wb, loaded.data)
    const fullName = loaded.provider?.name || loaded.provider?.shortName || run.providerId
    if (Math.abs(payable - Number(run.totalAmount)) > 0.01) {
      console.error(`[payout-export-zip] ALERT Excel 應付 ${payable} ≠ 系統鎖定 ${run.totalAmount}（${fullName}，run ${run.id}）`)
      await prisma.auditLog.create({
        data: { actorId: session.userId, action: 'PAYOUT_EXPORT_MISMATCH', entity: 'PayoutRun', entityId: run.id, notes: `Excel ${payable} vs 系統 ${run.totalAmount}（${fullName}）` },
      })
      mismatches.push(`${fullName}（Excel ${payable} vs 系統 ${Number(run.totalAmount)}）`)
      continue
    }
    zip.file(zipFileName(`${fullName}-${clinicShort}-${periodMonth}`, used), await wb.xlsx.writeBuffer())
    doctorFiles++
  }
  if (mismatches.length > 0) {
    return jsonNoStore({ error: `以下醫生匯出金額同系統鎖定金額唔一致，已停止匯出，請通知管理員：${mismatches.join('、')}` }, { status: 409 })
  }

  // ─── 3. 未鎖定／計唔到嘅醫生 → 說明檔（全店月報照出黃色草稿頁）──
  const notes: string[] = []
  for (const d of built.drafts) notes.push(`${d.providerName}：未鎖定（草稿）—— 冇獨立檔；全店月報有黃色草稿頁`)
  for (const f of built.failures) notes.push(`${f.providerName}：未能計算 —— ${f.reason}`)
  if (notes.length > 0) {
    zip.file('未有獨立檔.txt', `${clinicShort} ${periodMonth}\r\n以下醫生冇獨立 Excel：\r\n\r\n${notes.join('\r\n')}\r\n`)
  }

  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'PAYOUT_EXPORT_ZIP',
      entity: 'Clinic',
      entityId: clinicId,
      clinicId,
      notes: `一鍵匯出醫生月結：${clinicShort} ${periodMonth}（全店月報 1 份＋${doctorFiles} 位已鎖定醫生獨立檔`
        + `${built.drafts.length ? `；${built.drafts.length} 位未鎖定冇獨立檔` : ''}，包含病人姓名）`,
    },
  })

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const name = `${clinicShort}-${periodMonth}-醫生月結.zip`
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="payout_${periodMonth}.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-Doctor-Files': String(doctorFiles),
      'X-Draft-Doctors': String(built.drafts.length),
      'Cache-Control': 'no-store',
    },
  })
}
