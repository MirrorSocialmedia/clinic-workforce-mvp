'use client'

/**
 * ★ cwm-labdoc §12.4：/lab-docs/statements/[id]/sections/[sid] — 分段對數（月結 vs 系統、處理差異、確認）
 */

import StatementSection from '@/components/labdoc/StatementSection'

export default function LabStatementSectionPage({ params }: { params: { id: string; sid: string } }) {
  return <StatementSection id={params.id} sid={params.sid} />
}
