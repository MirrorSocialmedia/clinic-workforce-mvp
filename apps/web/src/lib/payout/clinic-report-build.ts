// ============================================================
// ★ cwm-exportzip-20261012：全店月報 workbook 產生（由 api/payout-runs/clinic-report 抽出，行為不變）
//   「月度收入報表」同「一鍵匯出（全店＋逐個醫生）」共用 —— 同一份 workbook，數字一定一樣。
//   權限／scope／審計留喺 route；呢度只負責攞數＋砌 workbook＋P-4 對數防線（唔符 → 寫 PAYOUT_EXPORT_MISMATCH，回 409）。
//   ★★★ 生死格：純讀 PayoutRun／allocation／cost，唔寫任何金額。
// ============================================================
import ExcelJS from 'exceljs'
import type { PayoutRun } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { toHKDateStr } from '@/lib/hk-date'
import { resolveMethodRule } from '@/lib/apricot/allocate'
import { loadDoctorSheetData, loadDoctorSheetDataForRun, METHOD_LABELS, round2, KEY_FREE_SP, KEY_CREDIT, methodOf, type DoctorSheetLoad } from '@/lib/payout/report-data'
import { computePayout, runGates, isBeforePayoutStart } from '@/lib/payout/engine'
import { incomeProviderIds } from '@/lib/payout/clinic-income-providers'
import { loadClinicMisc } from '@/lib/payout/clinic-misc'
import { buildCoverSheet, buildDoctorSheet, buildMiscSheet, incomeTotalOf } from '@/lib/payout/xlsx-report'

export type ClinicReportBuild =
  | { ok: false; status: number; error: string }
  | {
      ok: true
      wb: ExcelJS.Workbook
      clinicShort: string
      /** 已鎖定月結單（應付大→細） */
      runs: PayoutRun[]
      /** 有收入但未鎖定（即時計草稿頁）嘅醫生 */
      drafts: { providerId: string; providerName: string }[]
      /** 計唔到嘅醫生＋原因 */
      failures: { providerName: string; reason: string }[]
    }

export async function buildClinicReport(input: { clinicId: string; periodMonth: string; actorId: string }): Promise<ClinicReportBuild> {
  const { clinicId, periodMonth, actorId } = input
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, name: true, shortName: true, apricotClinicId: true, apricotPayoutFrom: true },
  })
  if (!clinic) return { ok: false, status: 404, error: '診所不存在' }
  const clinicShort = clinic.shortName || clinic.name

  // ─── 1. 該店該月 FINALIZED（LOCKED）月結單，按應付總額大→細 ──────
  const runs = await prisma.payoutRun.findMany({
    where: { clinicId, periodMonth, status: 'LOCKED' },
    orderBy: { totalAmount: 'desc' },
  })

  // ─── 2. Clinic 雜項 = Apricot CLINIC 帳號 ＋ 人手錄入（lib/payout/clinic-misc.ts 唯一來源）──
  //   ★ cwm-clinicmisc-wire-20260913：之前只讀 MiscIncome（人手表一直係空）→ 雜項頁永遠冇記錄。
  //     診所雜費其實一直喺 Apricot 收（CLINIC 帳號），MiscIncome 只係退路。
  const miscRows = await loadClinicMisc(clinicId, clinic.apricotClinicId, periodMonth)

  // ─── 2b. ★ cwm-draftreport-20261006：有收入但未鎖定嘅醫生 → 即時計草稿 ──────
  //   名單 = clinics route 同一個 incomeProviderIds（付款＋轉介）；已有 LOCKED run 嘅剔走。
  //   未開始用系統計月結嘅店（apricotPayoutFrom 之前）→ 唔計草稿（之前月份人手處理，計咗會誤導）。
  const lockedProviderIds = new Set(runs.map(r => r.providerId))
  const drafts: { providerId: string; totalAmount: number; loaded: DoctorSheetLoad }[] = []
  const failures: { providerName: string; reason: string }[] = []
  if (!isBeforePayoutStart(periodMonth, clinic.apricotPayoutFrom)) {
    const { allocIds, refIds } = await incomeProviderIds(prisma, clinic, periodMonth)
    const draftIds = [...new Set([...allocIds, ...refIds])].filter(id => !lockedProviderIds.has(id))
    const draftProviders = draftIds.length > 0
      ? await prisma.provider.findMany({ where: { id: { in: draftIds } }, select: { id: true, name: true, shortName: true } })
      : []
    for (const p of draftProviders) {
      const label = p.shortName || p.name
      try {
        const { errors } = await runGates(p.id, periodMonth, clinicId)
        if (errors.length > 0) {
          failures.push({ providerName: label, reason: errors.join('；') })
          continue
        }
        const payout = await computePayout(p.id, periodMonth, clinicId)
        const loaded = await loadDoctorSheetDataForRun({
          id: `draft:${p.id}`,
          providerId: p.id,
          clinicId,
          periodMonth,
          status: 'DRAFT',
          lockedAt: null,
          breakdownJson: { allocations: payout.breakdown } as never,
          percentUsed: payout.percentUsed as never,
          totalAmount: payout.totalAmount as never,
        }, prisma, { liveDraft: true })
        drafts.push({ providerId: p.id, totalAmount: payout.totalAmount, loaded })
      } catch (e) {
        failures.push({ providerName: label, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    drafts.sort((a, b) => b.totalAmount - a.totalAmount)
  }

  if (runs.length === 0 && drafts.length === 0 && failures.length === 0 && miscRows.length === 0) {
    return { ok: false, status: 404, error: `該診所 ${periodMonth} 冇月結單／雜項收入` }
  }

  // ─── 3. 逐 run 砌醫生頁（共同攞數函數，MD 坑⑥）───────────────────
  const wb = new ExcelJS.Workbook()
  // ★ cwm-payout P-4（MD §2.3）：對數防線 — 任何一個醫生 Excel 應付 ≠ 系統鎖定 → 成份唔出
  const exportMismatches: { run: { id: string }; name: string; payable: number; totalAmount: number }[] = []
  const doctorEntries: {
    sheetName: string; sheetLabel: string; status: string; draft: boolean
    totalAmount: number; revenue: number; freeSp: number; credit: number; methodCount: number
    nonStore: { method: string; label: string; forDoctor: boolean; amount: number }[]
  }[] = []
  // 已鎖定（totalAmount 大→細）先，草稿（同樣大→細）排後
  const sheetLoads: { loaded: DoctorSheetLoad | null; draft: boolean }[] = []
  for (const run of runs) sheetLoads.push({ loaded: await loadDoctorSheetData(run.id), draft: false })
  for (const d of drafts) sheetLoads.push({ loaded: d.loaded, draft: true })
  for (const { loaded, draft } of sheetLoads) {
    if (!loaded) continue // 理論上唔會發生（run 剛先查過）— 防呆 skip
    const sheetLabel = loaded.provider?.shortName || loaded.provider?.name || '未知'
    loaded.data.sheetNameBase = sheetLabel // sheet 名 = shortName || name（MD C 章）
    // ★ cwm-payout P-1：buildDoctorSheet 返 { ws, payable }（payable 喺 P-4 對數防線用）
    const { ws, payable: docPayable } = buildDoctorSheet(wb, loaded.data)
    // ★ cwm-payout P-4：逐醫生對數（LOCKED run 對鎖定金額；★ 草稿對 computePayout 即時總額 —
    //   兩者都係同一把尺，唔一致 = 報表產生器同引擎分歧，一樣成份唔出）
    if (Math.abs(docPayable - Number(loaded.run.totalAmount)) > 0.01) {
      exportMismatches.push({
        run: { id: loaded.run.id },
        name: draft ? `${sheetLabel}（草稿）` : sheetLabel,
        payable: docPayable,
        totalAmount: Number(loaded.run.totalAmount),
      })
    }
    // ★ cwm-coverrevenue-20260914：用返醫生頁同一個 incomeTotalOf，唔重新計（坑②）
    const revenue = round2(loaded.data.days.reduce(
      (s, day) => s + incomeTotalOf(loaded.data.methods, day.byMethod), 0))
    // ★ cwm-payout P-1：byMethod key 而家係 colKey（方法|s|d）
    // ★ cwm-doctorflag-20261011：封面備註逐 colKey 計（只取 s=0 欄），唔再用淨方法名合計（sumMethodOf）
    const nonStore = loaded.data.methods
      .filter(m => !m.countAsIncome)
      .map(m => ({
        method: methodOf(m.key),
        label: METHOD_LABELS[methodOf(m.key)] || methodOf(m.key),
        forDoctor: m.countForDoctor,
        amount: round2(loaded.data.days.reduce((x, day) => x + Number(day.byMethod[m.key] ?? 0), 0)),
      }))
    doctorEntries.push({
      sheetName: ws.name,
      sheetLabel,
      status: draft ? '草稿（未鎖定）' : loaded.data.status,
      draft,
      totalAmount: Number(loaded.run.totalAmount),
      revenue,
      // ★ cwm-doctorflag-20261011：封面備註只計【唔計店舖營收】嗰啲欄（s=0）；計唔計醫生跟該欄旗
      freeSp: nonStore.filter(n => n.method === KEY_FREE_SP).reduce((x, n) => x + n.amount, 0),
      credit: nonStore.filter(n => n.method === KEY_CREDIT).reduce((x, n) => x + n.amount, 0),
      methodCount: loaded.data.methods.length,
      nonStore,
    })
  }

  // ★ cwm-payout P-4：有醫生對數唔符 → audit + 409（成份唔出；錯誤訊息列明邊個醫生）
  if (exportMismatches.length > 0) {
    for (const mm of exportMismatches) {
      console.error(`[payout-clinic-report] ALERT Excel 應付 ${mm.payable} ≠ 系統鎖定 ${mm.totalAmount}（${mm.name}，run ${mm.run.id}）`)
      await prisma.auditLog.create({
        data: {
          actorId,
          action: 'PAYOUT_EXPORT_MISMATCH',
          entity: 'PayoutRun',
          entityId: mm.run.id,
          notes: `Excel ${mm.payable} vs 系統 ${mm.totalAmount}（${mm.name}）`,
        },
      })
    }
    return {
      ok: false, status: 409,
      error: `以下醫生匯出金額同系統鎖定金額唔一致，已停止匯出，請通知管理員：${exportMismatches.map(m => `${m.name}（Excel ${m.payable} vs 系統 ${m.totalAmount}）`).join('、')}`,
    }
  }

  // ─── 4. Clinic 雜項頁（費率口徑 = D2/D3 同一個 resolveMethodRule）──
  const allRules = await prisma.paymentMethodRule.findMany()
  // 逐行 resolve（needsReview = 規則已刪 → 0，同 D3 頁「按 0 計」口徑）
  // ★ cwm-feefmt-20261006：逐行費率＋手續費（唔再用加權平均「費率」—— Octopus 2% + FPS 0% 會顯示成 0.2%）
  const rateOf = (r: { methodNorm: string; incomeAt: Date }): number => {
    const rule = resolveMethodRule(r.methodNorm, r.incomeAt, allRules)
    return rule.needsReview ? 0 : Number(rule.feePercent) / 100
  }
  const feeOf = (r: { methodNorm: string; incomeAt: Date; amount: number | unknown }): number =>
    round2(Number(r.amount) * rateOf(r))
  const activeMisc = miscRows.filter(r => !r.isVoid)
  const miscTotal = round2(activeMisc.reduce((s, r) => s + Number(r.amount), 0))
  const miscFee = round2(activeMisc.reduce((s, r) => s + feeOf(r), 0))
  const miscNet = round2(miscTotal - miscFee)

  const miscWs = buildMiscSheet(wb, {
    clinicName: clinicShort,
    periodMonth,
    rows: miscRows.map(r => ({
      incomeAt: toHKDateStr(r.incomeAt),
      category: r.category,
      itemName: r.itemName,
      methodLabel: METHOD_LABELS[r.methodNorm] || r.methodNorm,
      note: r.note ?? undefined,
      amount: Number(r.amount),
      isVoid: r.isVoid,
      source: r.source,
      feePercent: rateOf(r),
      fee: feeOf(r),
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
      draft: d.draft,
      totalAmount: d.totalAmount,
      revenue: d.revenue,
      freeSp: d.freeSp,
      credit: d.credit,
      nonStore: d.nonStore,
      methodCount: d.methodCount,
    })),
    miscSheetName: miscWs.name,
    miscNet,
    failures,
  })

  // ─── 6. 頁序：封面 │ 醫生 × N │ Clinic 雜項（ExcelJS 按 orderNo 排序；types 冇暴露，cast）──
  const order: ExcelJS.Worksheet[] = [coverWs, ...doctorEntries.map(d => wb.getWorksheet(d.sheetName)!), miscWs]
  order.forEach((ws, i) => { (ws as unknown as { orderNo: number }).orderNo = i + 1 })


  return {
    ok: true, wb, clinicShort, runs,
    drafts: drafts.map(d => ({ providerId: d.providerId, providerName: d.loaded.provider?.name || d.providerId })),
    failures,
  }
}
