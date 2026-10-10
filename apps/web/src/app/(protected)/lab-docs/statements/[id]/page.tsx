'use client'

/**
 * ★ cwm-labdoc §12.3：/lab-docs/statements/[id] — 月結單總覽（分段表、指派、取代舊版）
 */

import StatementDetail from '@/components/labdoc/StatementDetail'

export default function LabStatementPage({ params }: { params: { id: string } }) {
  return <StatementDetail id={params.id} />
}
