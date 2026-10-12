/**
 * 2026-10-11：冇嵌入字型＋預設 CMap（UniCNS-UCS2-H）嘅中文 PDF — Modern Dental 月結單收件人格
 * 之前冇 cMapUrl → 抽文字成段冇咗、渲染亂碼。而家 pdfjsDocOptions() 帶 cMap → 讀到中文。
 */
import assert from 'node:assert'
import { test } from 'node:test'
import { loadPdfjs, pdfjsDocOptions } from './pdfjs'

function cmapPdf(text: string): Uint8Array {
  const hex = [...text].map((c) => c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join('')
  const content = `BT /F1 18 Tf 50 750 Td <${hex}> Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /MingLiU /Encoding /UniCNS-UCS2-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /MingLiU /CIDSystemInfo << /Registry (Adobe) /Ordering (CNS1) /Supplement 0 >> /FontDescriptor 7 0 R >>',
    '<< /Type /FontDescriptor /FontName /MingLiU /Flags 6 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>',
  ]
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const x = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return new Uint8Array(Buffer.from(out, 'latin1'))
}

test('預設 CMap 中文字型（冇嵌入）→ 有 cMapUrl 先讀到「Dr. Ma 滙樂牙科」', async () => {
  const opts = pdfjsDocOptions()
  assert.ok(String(opts.cMapUrl ?? '').endsWith('/cmaps/'), '搵到 pdfjs-dist/cmaps')
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({ data: cmapPdf('Dr. Ma 滙樂牙科'), useSystemFonts: true, ...opts }).promise
  const tc = await (await doc.getPage(1)).getTextContent()
  const text = tc.items.map((i: any) => i.str).join('').replace(/\s+/g, '')
  assert.ok(text.includes('滙樂牙科'), text)
  assert.ok(text.includes('Dr.Ma'), text)
})
