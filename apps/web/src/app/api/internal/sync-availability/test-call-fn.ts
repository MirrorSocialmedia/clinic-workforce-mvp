/**
 * p3-acceptance.ts 嘅測試注入點（離線 mock Apricot callFn）。
 *
 * ★ 點解獨立檔案：Next.js 14 唔允許 route.ts export 非 HTTP symbol ——
 *   `__setTestCallFn` 直接喺 route.ts export 會令 `next build` fail
 *   （"does not match the required types of a Next.js Route"，cw-pa P4 發現）。
 *   module-level state 移咗入呢度；route.ts 只 import getTestCallFn，行為零改變。
 * 生產永遠冇人 call __setTestCallFn → null → runAvailabilitySync 用預設（真 Apricot API）。
 */
import type { ApricotCallFn } from '@/lib/apricot/sync-availability'

let testCallFn: ApricotCallFn | null = null

export function __setTestCallFn(fn: ApricotCallFn | null): void {
  testCallFn = fn
}

export function getTestCallFn(): ApricotCallFn | null {
  return testCallFn
}
