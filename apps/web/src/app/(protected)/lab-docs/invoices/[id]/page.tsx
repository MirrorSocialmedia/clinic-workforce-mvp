'use client'

/**
 * ★ cwm-labdoc §12.2：/lab-docs/invoices/[id] — 確認頭部＋對成本
 */

import InvoiceDetail from '@/components/labdoc/InvoiceDetail'

export default function LabInvoicePage({ params }: { params: { id: string } }) {
  return <InvoiceDetail id={params.id} />
}
