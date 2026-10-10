/**
 * ★ cwm-facemissing-20261010：人臉結果顯示狀態 ＋ withTimeout
 *   跑法: TZ=UTC npx tsx --test src/lib/face-status.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { displayFaceStatus, faceStatusLabel, FACE_REPORT_WINDOW_MS } from './face-status'
import { withTimeout } from './with-timeout'

const NOW = new Date('2026-10-10T10:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)

test('有結果就照用', () => {
  assert.strictEqual(displayFaceStatus({ faceStatus: 'PASS', source: 'QR_DYNAMIC', createdAt: ago(1000) }, NOW), 'PASS')
})
test('冇結果：人手補卡 → MANUAL；5 分鐘內 → REPORTING；之後 → NO_REPORT', () => {
  assert.strictEqual(displayFaceStatus({ faceStatus: null, source: 'MANUAL_CORRECTION', createdAt: ago(86400000) }, NOW), 'MANUAL')
  assert.strictEqual(displayFaceStatus({ faceStatus: null, source: 'QR_DYNAMIC', createdAt: ago(60000) }, NOW), 'REPORTING')
  assert.strictEqual(displayFaceStatus({ faceStatus: null, source: 'QR_DYNAMIC', createdAt: ago(FACE_REPORT_WINDOW_MS + 1) }, NOW), 'NO_REPORT')
  assert.match(faceStatusLabel('NO_REPORT'), /手機冇回報/)
  assert.notStrictEqual(faceStatusLabel('NO_REPORT'), '—')
})
test('withTimeout：準時 resolve；逾時掟指定 name；遲到嘅值交俾 onLate（例如關相機）', async () => {
  assert.strictEqual(await withTimeout(Promise.resolve(7), 50, 'Timeout'), 7)
  let late: number | null = null
  const slow = new Promise<number>(r => setTimeout(() => r(9), 40))
  await assert.rejects(withTimeout(slow, 10, 'Timeout', v => { late = v }), (e: any) => e.name === 'Timeout')
  await new Promise(r => setTimeout(r, 60))
  assert.strictEqual(late, 9)
  await assert.rejects(withTimeout(Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })), 50, 'Timeout'), (e: any) => e.name === 'NotAllowedError')
})

test('cwm-facereviewcut-20261011：覆核「手機冇回報」由生效日開始（舊數唔追究），最多 30 日', async () => {
  const { noReportReviewWindow, FACE_NO_REPORT_SINCE, faceReviewBadge } = await import('./face-status')
  // 生效後兩日：下限 = 生效日（唔係 30 日前）
  const w1 = noReportReviewWindow(new Date('2026-10-13T12:00:00+08:00'))
  assert.strictEqual(w1.gte.getTime(), FACE_NO_REPORT_SINCE.getTime())
  assert.strictEqual(w1.lt.getTime(), new Date('2026-10-13T12:00:00+08:00').getTime() - FACE_REPORT_WINDOW_MS)
  assert.ok(new Date('2026-10-10T21:16:00+08:00') < w1.gte, '10/10 舊數唔入覆核')
  // 生效後 60 日：下限 = 30 日前
  const later = new Date('2026-12-20T00:00:00+08:00')
  assert.strictEqual(noReportReviewWindow(later).gte.getTime(), later.getTime() - 30 * 86400000)
  // 標籤唔再一律「未通過」
  assert.strictEqual(faceReviewBadge('NO_REPORT'), '手機冇回報')
  assert.strictEqual(faceReviewBadge('SKIPPED'), '相機略過')
  assert.strictEqual(faceReviewBadge('FAIL'), '未通過')
})
