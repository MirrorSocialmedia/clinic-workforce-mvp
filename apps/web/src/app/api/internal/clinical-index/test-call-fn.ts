// ============================================================
// in-process callFn hook（cwi-followup-p1-20260915 — 同
// ../sync-availability/test-call-fn 同一 pattern）
//
// e2e/dev：__setTestCallFn(mockFn) 注入決定性 Apricot stub；
// 生產：永遠 null → 真 apricotCall。
// ============================================================

import type { ClinicalCallFn } from '@/lib/clinical-index/types'

let testCallFn: ClinicalCallFn | null = null

export function __setTestCallFn(fn: ClinicalCallFn | null): void {
  testCallFn = fn
}

export function getTestCallFn(): ClinicalCallFn | null {
  return testCallFn
}
