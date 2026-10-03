/**
 * ★ cwm-bulkpayslip-20261003：薪資明細 PDF 產生（瀏覽器端）—— 員工明細頁〔匯出 PDF〕同
 *   計糧管理〔一鍵匯出全部糧單〕共用同一個 function，版面一模一樣，唔准各寫一份。
 *   原邏輯由 payroll/[id]/employee/[empId]/page.tsx exportPdf 原封搬出。
 */
export async function buildPayslipPdf(el: HTMLElement) {
  const { default: html2canvas } = await import('html2canvas')
  const { jsPDF } = await import('jspdf')

  const canvas = await html2canvas(el, {
    scale: 2, backgroundColor: '#ffffff',
    onclone: (doc) => {
      doc.querySelectorAll('.no-print').forEach(n => ((n as HTMLElement).style.display = 'none'))
    },
  })

  // ★ 2026-08-25：留 12mm 邊距 — 原本 x=0 / 闊 210mm 貼死邊界，列印會切到
  const pdf = new jsPDF('p', 'mm', 'a4')
  const MARGIN = 12
  const pageW = 210, pageH = 297
  const contentW = pageW - MARGIN * 2      // 186
  const contentH = pageH - MARGIN * 2      // 273
  const imgH = (canvas.height * contentW) / canvas.width
  const imgData = canvas.toDataURL('image/jpeg', 0.92)   // ★ 提出迴圈外，唔好每頁重新編碼
  let offset = 0
  while (offset < imgH) {
    if (offset > 0) pdf.addPage()
    pdf.addImage(imgData, 'JPEG', MARGIN, MARGIN - offset, contentW, imgH)
    // ★ 2026-08-27 cwm-costarrival：jsPDF 唔會 clip —— 圖會畫入上下 margin，令每頁多顯示 24mm
    //   → 下一頁由 offset 開始就會重複嗰 24mm（分頁重疊）。
    //   用白矩形遮住上下 margin，令每頁真係只顯示 contentH。（左右唔使遮 — contentW 已限闊）
    pdf.setFillColor(255, 255, 255)
    pdf.rect(0, 0, pageW, MARGIN, 'F')
    pdf.rect(0, pageH - MARGIN, pageW, MARGIN, 'F')
    offset += contentH                     // ★ 用 contentH 唔係 pageH
  }
  return pdf
}

/** 一鍵匯出用：iframe 內嘅員工明細頁（?embed=1）喺 window 掛呢個 handle */
export type PayslipEmbedHandle =
  | { state: 'ready'; name: string; build: () => Promise<Blob> }
  | { state: 'forbidden' }
  | { state: 'error'; message: string }

export const PAYSLIP_EMBED_KEY = '__payslipExport'
