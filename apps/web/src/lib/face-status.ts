// ============================================================
// ★ cwm-facemissing-20261010：打卡人臉結果「顯示用」狀態（純函數，client／server 共用，零 prisma）
//
// 打卡分兩步：先寫 PunchRecord（faceStatus = null），手機再另外 POST /api/face/verify-punch 寫結果。
// 手機中途卡住／被關 → faceStatus 永遠 null，舊 UI 顯示「—」，覆核頁又唔列 → 靜靜漏咗。
// 呢度將 null 分清楚：人手補卡（唔使人臉）／驗證中（5 分鐘窗口內）／手機冇回報（要覆核）。
// ============================================================

/** 手機可以寫人臉結果嘅時限（同 api/face/verify-punch 一致） */
export const FACE_REPORT_WINDOW_MS = 5 * 60 * 1000

export type DisplayFaceStatus = string | 'NO_REPORT' | 'MANUAL' | 'REPORTING'

export function displayFaceStatus(
  p: { faceStatus: string | null | undefined; source?: string | null; createdAt: string | Date },
  now: Date = new Date(),
): DisplayFaceStatus {
  if (p.faceStatus) return p.faceStatus
  if (p.source === 'MANUAL_CORRECTION') return 'MANUAL'
  const age = now.getTime() - new Date(p.createdAt).getTime()
  return age > FACE_REPORT_WINDOW_MS ? 'NO_REPORT' : 'REPORTING'
}

export const FACE_STATUS_LABEL: Record<string, string> = {
  PASS: '✅ 通過',
  FAIL: '❌ 唔吻合',
  NOT_ENROLLED: '⚪ 未登記人臉',
  PENDING_ENROLL: '⏳ 人臉登記待批',
  SKIPPED: '⏭️ 略過（相機問題）',
  NO_FACE: '⚠️ 未拍到人臉',
  PENDING: '⏳ 待覆核',
  NO_REPORT: '⚠️ 手機冇回報人臉結果',
  MANUAL: '✍️ 人手補卡（唔使人臉）',
  REPORTING: '⏳ 驗證中',
}

export const faceStatusLabel = (s: DisplayFaceStatus): string => FACE_STATUS_LABEL[s] ?? s
