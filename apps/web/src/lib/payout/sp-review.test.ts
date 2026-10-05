// ★ cwm-sppreview-20261006：月結預覽 2人SP 提示（純函數）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spReviewNeeded, scanAuditEntityId } from './sp-review'

test('spReviewNeeded：有未確認或者未掃描就要剔', () => {
  assert.equal(spReviewNeeded({ pending: [], scanned: true }), false)
  assert.equal(spReviewNeeded({ pending: [], scanned: false }), true)
  assert.equal(spReviewNeeded({ pending: [{ id: 'a', billCode: null, billTime: null, amount: 40, needsReview: false, hasMarker: true }], scanned: true }), true)
})

test('scanAuditEntityId：全部診所 = 月份；指定診所 = 月份:clinicId', () => {
  assert.equal(scanAuditEntityId('2026-10'), '2026-10')
  assert.equal(scanAuditEntityId('2026-10', null), '2026-10')
  assert.equal(scanAuditEntityId('2026-10', 'c1'), '2026-10:c1')
})
