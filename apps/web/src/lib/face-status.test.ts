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
