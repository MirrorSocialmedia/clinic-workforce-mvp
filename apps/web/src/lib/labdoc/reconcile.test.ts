/**
 * cwm-labdoc P2 CHUNK 3 — §7.3/§7.4/§7.5/§7.6/§3.4 純函數測試
 * 跑法: npx tsx --test src/lib/labdoc/reconcile.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  rankCandidateIds,
  defaultGroupSelection,
  computeLinkedSum,
  priceDecision,
  prefillNewCase,
  recomputeInvoiceDocStatus,
  type CandidateCost,
} from './reconcile'

const D = (s: string): Date => new Date(`${s}T00:00:00Z`)

// ── §7.3 排序 ──────────────────────────────────────────────

const base: Omit<CandidateCost, 'id'> = {
  baseCost: 100,
  receivedAt: null,
  orderedAt: D('2026-09-01'),
  hasMainLink: false,
}

test('§7.3：金額 = 分組合計排第一（F-06）', () => {
  const cs: CandidateCost[] = [
    { ...base, id: 'b-nomatch', baseCost: 999 },
    { ...base, id: 'a-exact', baseCost: 500 }, // groupSum = 500
  ]
  assert.deepEqual(rankCandidateIds(cs, 500), ['a-exact', 'b-nomatch'])
})

test('§7.3：金額都唔等 → 已到貨排先（receivedAt IS NULL ASC）', () => {
  const cs: CandidateCost[] = [
    { ...base, id: 'unreceived', baseCost: 100, receivedAt: null },
    { ...base, id: 'received', baseCost: 200, receivedAt: D('2026-09-10') },
  ]
  assert.deepEqual(rankCandidateIds(cs, 500), ['received', 'unreceived'])
})

test('§7.3：前兩者同 → orderedAt 新到舊', () => {
  const cs: CandidateCost[] = [
    { ...base, id: 'old', baseCost: 100, orderedAt: D('2026-08-01') },
    { ...base, id: 'new', baseCost: 200, orderedAt: D('2026-09-15') },
  ]
  assert.deepEqual(rankCandidateIds(cs, 500), ['new', 'old'])
})

test('§7.3：全同分 → id 字典序（穩定、決定性）', () => {
  const cs: CandidateCost[] = [
    { ...base, id: 'ccc' },
    { ...base, id: 'aaa' },
    { ...base, id: 'bbb' },
  ]
  assert.deepEqual(rankCandidateIds(cs, 500), ['aaa', 'bbb', 'ccc'])
})

test('§7.3：baseCost 差 $0.01 以內算「金額一樣」（±0.01  MONEY_EPS）', () => {
  const cs: CandidateCost[] = [
    { ...base, id: 'almost', baseCost: 499.99 },
    { ...base, id: 'other', baseCost: 100 },
  ]
  assert.deepEqual(rankCandidateIds(cs, 500), ['almost', 'other'])
})

// ── §7.4 預設 ──────────────────────────────────────────────

const L = (lineId: string, amount: number, isZero = false) => ({ lineId, amount, isZero })

test('§7.4：候選 0 → 全部剔 + 顯示新增成本／搵其他病人', () => {
  const r = defaultGroupSelection([L('l1', 100)], [], 100)
  assert.deepEqual(r.lineActions, [{ lineId: 'l1', action: 'UNMATCH', costCaseId: null, linkType: null }])
  assert.equal(r.selectedCostCaseId, null)
  assert.equal(r.showNewCase, true)
  assert.equal(r.showPatientSearch, true)
})

test('§7.4：候選 1 筆未有 MAIN → 全部行預設對佢（MAIN）；$0 行跟同組（D11）', () => {
  const r = defaultGroupSelection([L('l1', 600), L('l0', 0, true)], [{ id: 'c1', baseCost: 600, hasMainLink: false }], 600)
  assert.equal(r.selectedCostCaseId, 'c1')
  assert.deepEqual(r.lineActions, [
    { lineId: 'l1', action: 'MATCH', costCaseId: 'c1', linkType: 'MAIN' },
    { lineId: 'l0', action: 'MATCH', costCaseId: 'c1', linkType: 'MAIN' },
  ])
  assert.equal(r.showNewCase, false)
  assert.equal(r.showPatientSearch, false)
})

test('§7.4：候選 1 筆但已有 MAIN 連結 → 冇預設（揀佢要揀補收費／重做 — B7）', () => {
  const r = defaultGroupSelection([L('l1', 600)], [{ id: 'c1', baseCost: 600, hasMainLink: true }], 600)
  assert.equal(r.selectedCostCaseId, null)
  assert.equal(r.lineActions[0].action, 'UNMATCH')
  assert.equal(r.showNewCase, false) // 有候選 — 唔顯示「新增成本」
})

test('§7.4：候選 >1 → 預設「金額 = 分組合計」嗰筆（剛好一筆）', () => {
  const r = defaultGroupSelection(
    [L('l1', 800)],
    [
      { id: 'exact', baseCost: 800, hasMainLink: false },
      { id: 'other', baseCost: 500, hasMainLink: false },
    ],
    800,
  )
  assert.equal(r.selectedCostCaseId, 'exact')
})

test('§7.4：候選 >1 但兩筆都 = 分組合計 → 冇預設（唔係「剛好一筆」）', () => {
  const r = defaultGroupSelection(
    [L('l1', 800)],
    [
      { id: 'a', baseCost: 800, hasMainLink: false },
      { id: 'b', baseCost: 800, hasMainLink: false },
    ],
    800,
  )
  assert.equal(r.selectedCostCaseId, null)
})

test('§7.4：候選 >1 無金額吻合 → 冇預設', () => {
  const r = defaultGroupSelection(
    [L('l1', 800)],
    [
      { id: 'a', baseCost: 500, hasMainLink: false },
      { id: 'b', baseCost: 300, hasMainLink: false },
    ],
    800,
  )
  assert.equal(r.selectedCostCaseId, null)
  assert.equal(r.showNewCase, false)
})

// ── §7.5 核對同動作 ────────────────────────────────────────

test('§7.5：linkedSum = 所有 MATCHED 行（其他單）＋今次要連嘅行', () => {
  assert.equal(computeLinkedSum([460, 80], [100]), 640) // 主單 460 + 補收費 80 + 今次 100
  assert.equal(computeLinkedSum([], [0.1, 0.2]), 0.3) // 浮點安全
  assert.equal(computeLinkedSum([100], []), 100)
})

test('§7.5：lockedByRunId ≠ null → LOCKED；linkedSum ≠ baseCost → diff（下期調整）', () => {
  const d = priceDecision({ lockedByRunId: 'run1', baseCost: 500, linkedSum: 580, anotherCandidateExactMatch: false })
  assert.deepEqual(d, { kind: 'LOCKED', linkedSum: 580, diff: 80 })
  const d2 = priceDecision({ lockedByRunId: 'run1', baseCost: 500, linkedSum: 500, anotherCandidateExactMatch: false })
  assert.deepEqual(d2, { kind: 'LOCKED', linkedSum: 500, diff: 0 })
  const d3 = priceDecision({ lockedByRunId: 'run1', baseCost: null, linkedSum: 580, anotherCandidateExactMatch: false })
  assert.deepEqual(d3, { kind: 'LOCKED', linkedSum: 580, diff: null }) // 未有價 → 無 diff
})

test('§7.5：baseCost = linkedSum → EQUAL；baseCost = null → NO_PRICE（填入 $Y）', () => {
  assert.deepEqual(priceDecision({ lockedByRunId: null, baseCost: 580, linkedSum: 580, anotherCandidateExactMatch: false }), {
    kind: 'EQUAL',
    linkedSum: 580,
  })
  assert.deepEqual(priceDecision({ lockedByRunId: null, baseCost: null, linkedSum: 440, anotherCandidateExactMatch: false }), {
    kind: 'NO_PRICE',
    linkedSum: 440,
  })
})

test('§7.5：金額唔同 → DIFF；另一筆候選 = 分組合計 → otherExactMatch（紅字警示）', () => {
  const d = priceDecision({ lockedByRunId: null, baseCost: 550, linkedSum: 440, anotherCandidateExactMatch: true })
  assert.deepEqual(d, { kind: 'DIFF', linkedSum: 440, baseCost: 550, otherExactMatch: true })
  const d2 = priceDecision({ lockedByRunId: null, baseCost: 550, linkedSum: 440, anotherCandidateExactMatch: false })
  assert.equal(d2.kind, 'DIFF')
  assert.equal(d2.kind === 'DIFF' && d2.otherExactMatch, false)
})

// ── §7.6 新增成本預填 ──────────────────────────────────────

test('§7.6：預填規則（category 鎖 LAB、baseCost=分組合計、orderedAt 回退、source MANUAL、labInvoiceLinked）', () => {
  const p = prefillNewCase({
    clinicId: 'c1',
    providerId: 'p1',
    labId: 'lab1',
    patientCode: '7159',
    patientCodeNorm: 'TW007159',
    systemPatientName: '陳大文',
    labCaseRef: 'CASE-9',
    groupSum: 600,
    orderReceivedDate: D('2026-08-01'),
    docDate: D('2026-08-05'),
    itemType: 'Crown',
  })
  assert.equal(p.category, 'LAB')
  assert.equal(p.baseCost, 600)
  assert.equal(p.finalCost, 600)
  assert.equal(p.status, 'PRICED')
  assert.equal(p.source, 'MANUAL')
  assert.equal(p.labInvoiceLinked, true)
  assert.equal(p.patientName, '陳大文')
  assert.equal(p.labOrderNo, 'CASE-9')
  assert.equal(p.orderedAt.toISOString(), '2026-08-01T00:00:00.000Z')
})

test('§7.6：orderReceivedDate null → 回退 docDate；兩個都 null → throw', () => {
  const p = prefillNewCase({
    clinicId: 'c1', providerId: 'p1', labId: null, patientCode: '1', patientCodeNorm: 'TW000001',
    systemPatientName: null, labCaseRef: null, groupSum: 100,
    orderReceivedDate: null, docDate: D('2026-08-05'), itemType: 'Crown',
  })
  assert.equal(p.orderedAt.toISOString(), '2026-08-05T00:00:00.000Z')
  assert.equal(p.patientName, null) // 冇系統姓名 → null（唔用 invoice 拼音）
  assert.throws(() =>
    prefillNewCase({
      clinicId: 'c1', providerId: 'p1', labId: null, patientCode: '1', patientCodeNorm: 'TW000001',
      systemPatientName: null, labCaseRef: null, groupSum: 100,
      orderReceivedDate: null, docDate: null, itemType: 'Crown',
    }),
  )
})

test('§7.6：groupSum 浮點 → 補整（0.1+0.2 唔出 0.30000000000000004）', () => {
  const p = prefillNewCase({
    clinicId: 'c1', providerId: 'p1', labId: null, patientCode: '1', patientCodeNorm: 'TW000001',
    systemPatientName: null, labCaseRef: null, groupSum: 0.1 + 0.2,
    orderReceivedDate: D('2026-08-05'), docDate: null, itemType: 'Crown',
  })
  assert.equal(p.baseCost, 0.3)
})

// ── §3.4 文件狀態重算 ──────────────────────────────────────

test('§3.4：全部 MATCHED/IGNORED → RECONCILED；有但未齊 → PARTIAL；冇 → CONFIRMED', () => {
  assert.equal(recomputeInvoiceDocStatus(['MATCHED', 'IGNORED', 'MATCHED']), 'RECONCILED')
  assert.equal(recomputeInvoiceDocStatus(['MATCHED', 'UNMATCHED']), 'PARTIAL')
  assert.equal(recomputeInvoiceDocStatus(['IGNORED', 'UNMATCHED', 'UNMATCHED']), 'PARTIAL')
  assert.equal(recomputeInvoiceDocStatus(['UNMATCHED', 'UNMATCHED']), 'CONFIRMED')
  assert.equal(recomputeInvoiceDocStatus([]), 'CONFIRMED') // 無行（邊界）
})
