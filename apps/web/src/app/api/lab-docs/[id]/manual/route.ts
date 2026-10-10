// ★ cwm-labdoc §11：PUT /api/lab-docs/:id/manual — 人手輸入（EXTRACT_FAILED 單據）
// 同 PUT /header 同一個 handler（header 已接受 EXTRACT_FAILED；行冇 lineId = 新增）。
// 權限：lab_invoice（RBAC_MATRIX＋perm table 登記 'PUT /api/lab-docs/:id/manual'）
export const dynamic = 'force-dynamic'

export { PUT } from '../header/route'
