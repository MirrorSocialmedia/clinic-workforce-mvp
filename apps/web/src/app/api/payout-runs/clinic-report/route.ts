/**
 * GET /api/payout-runs/clinic-report?clinicId=&periodMonth= — 全店月報（cwm-payoutxlsx-20260908 C 章）
 *
 * 一個 workbook：封面 │ <醫生 shortName> × N │ Clinic 雜項
 *  - 醫生頁 = loadDoctorSheetData（同單張匯出同一個共同函數，MD 坑⑥）+ buildDoctorSheet 同一把尺
 *  - 冇 run（LOCKED/FINALIZED）嘅醫生唔出頁（唔出全零頁）
 *  - ★ cwm-draftreport-20261006：有收入但未鎖定嘅醫生 → 用 computePayout 即時計出「草稿頁」
 *    （同預覽同一個引擎，唔讀解鎖後殘留嘅 DRAFT run 舊快照），醫生頁＋封面行淺黃底；
 *    封面合計拆「已鎖定／草稿」；計唔到（gate 唔過）嘅列名＋原因。草稿唔寫任何嘢落 DB。
 *  - Clinic 雜項頁 = buildMiscSheet（A 步產生器）；費率口徑 = D2/D3 同一個 resolveMethodRule
 *    （逐行 resolve → 逐行費率＋手續費列出 → 合計／手續費合計／淨額，同 D3 頁底部三行天然一致）
 *  - 封面 = buildCoverSheet：逐醫生「店舖營收／應付醫生」兩欄（綠字跨 sheet 連結）＋合計
 *    ＋三層結算（店舖總收入 = 營收合計＋雜項淨額；診所淨收入 = 店舖總收入−應付合計，黃底）
 *    ＋Free SP／Credit 備註區（cwm-coverrevenue-20260914）
 *
 * 權限：OWNER ＋ provider_payout 權限覆蓋（RBAC_MATRIX + RBAC_PERM_OVERRIDES，MD 坑⑧）。
 * Audit：PAYOUT_CLINIC_REPORT_EXPORT（SENSITIVE_AUDIT_SPEC，MD 坑⑦）— notes 標明包含病人姓名。
 * ★★★ 生死格：本 route 純讀 PayoutRun／allocation／cost，唔寫任何金額。
 */
import { NextRequest } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { getOwnHomeClinicId } from '@/lib/scope-helpers'
import { payoutClinicGuard } from '@/lib/payout/kiosk-scope'
import { buildClinicReport } from '@/lib/payout/clinic-report-build'

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
  { const denied = payoutClinicGuard(session, clinicId); if (denied) return denied } // ★ cwm-kioskpayout-20261010：店舖帳號只限自己店

  // ★ cwm-exportzip-20261012：攞數＋砌 workbook 抽去 lib（一鍵匯出 ZIP 共用同一份），行為不變
  const built = await buildClinicReport({ clinicId, periodMonth, actorId: session.userId })
  if (!built.ok) return jsonNoStore({ error: built.error }, { status: built.status })
  const { clinicShort } = built

  // ─── 7. Audit（PAYOUT_CLINIC_REPORT_EXPORT — SENSITIVE_AUDIT_SPEC）──
  await prisma.auditLog.create({
    data: {
      actorId: auth.session!.userId,
      action: 'PAYOUT_CLINIC_REPORT_EXPORT',
      entity: 'Clinic',
      entityId: clinicId,
      clinicId,
      // ★ 醫生頁 B/C 區列病人姓名（2026-09-08 拍板）— 審計要查得返
      notes: `匯出全店月度收入報表：${clinicShort} ${periodMonth}（${built.runs.length} 份已鎖定月結單`
        + `${built.drafts.length ? `＋${built.drafts.length} 份草稿（未鎖定，即時計）` : ''}`
        + `${built.failures.length ? `＋${built.failures.length} 位未能計算` : ''}＋Clinic 雜項，包含病人姓名）`,
    },
  })

  // ─── 8. Response（檔名 ${clinicShort}_${periodMonth}_月度收入報表.xlsx）──
  const buf = await built.wb.xlsx.writeBuffer()
  const name = `${clinicShort}_${periodMonth}_月度收入報表.xlsx`
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="clinic_report_${periodMonth}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  })
}
