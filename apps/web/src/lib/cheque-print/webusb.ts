// ============================================================
// ★ cwm-chequeprint-20261005：Chrome WebUSB 直送打印機（只喺瀏覽器用）
//   南天／GWI PR2 Plus：USB 206d:0201。冇 driver、冇 agent。
//   Ubuntu 要先做一次：裝 Google Chrome（唔好用 snap Chromium）、udev 權限、blacklist usblp（見設定頁指引）。
// ============================================================
import { bitmapToBand, encodeEscp, encodeText, type RasterBand } from './encode'
import { hasNonAscii } from './content'
import type { PrintItem, PrinterMode } from './layout'

export const PRINTER_VENDOR_ID = 0x206d

type AnyUsb = any

export const webUsbSupported = () => typeof navigator !== 'undefined' && !!(navigator as AnyUsb).usb

/** 之前授權過嘅打印機（唔使再揀） */
export async function findAuthorizedPrinter(): Promise<AnyUsb | null> {
  if (!webUsbSupported()) return null
  const list: AnyUsb[] = await (navigator as AnyUsb).usb.getDevices()
  return list.find(d => d.vendorId === PRINTER_VENDOR_ID) ?? list.find(isPrinterClass) ?? null
}

/** 第一次：彈 Chrome 視窗揀打印機（一定要由撳掣觸發） */
export async function choosePrinter(): Promise<AnyUsb> {
  return (navigator as AnyUsb).usb.requestDevice({ filters: [{ vendorId: PRINTER_VENDOR_ID }, { classCode: 7 }] })
}

function isPrinterClass(d: AnyUsb): boolean {
  return !!d.configuration?.interfaces?.some((i: AnyUsb) => i.alternates?.some((a: AnyUsb) => a.interfaceClass === 7))
}

export function describeDevice(d: AnyUsb): string {
  const id = `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`
  return [d.manufacturerName, d.productName].filter(Boolean).join(' ') + ` (${id})`
}

async function openOut(d: AnyUsb): Promise<{ iface: number; ep: number }> {
  if (!d.opened) await d.open()
  if (!d.configuration) await d.selectConfiguration(1)
  const ifaces: AnyUsb[] = d.configuration.interfaces
  const pick = (want7: boolean) => {
    for (const i of ifaces) {
      for (const a of i.alternates) {
        if (want7 && a.interfaceClass !== 7) continue
        const ep = a.endpoints.find((e: AnyUsb) => e.direction === 'out' && e.type === 'bulk')
        if (ep) return { iface: i.interfaceNumber, alt: a.alternateSetting, ep: ep.endpointNumber, claimed: i.claimed }
      }
    }
    return null
  }
  const p = pick(true) ?? pick(false)
  if (!p) throw new Error('搵唔到打印機嘅輸出端（bulk OUT）')
  if (!p.claimed) {
    try {
      await d.claimInterface(p.iface)
    } catch {
      throw new Error('Chrome 攞唔到部打印機：Ubuntu 嘅 usblp driver 可能霸咗佢。跟「打印機設定」頁嘅指引做一次（blacklist usblp），再拔插 USB。')
    }
  }
  if (p.alt !== 0) await d.selectAlternateInterface(p.iface, p.alt)
  return { iface: p.iface, ep: p.ep }
}

export async function sendBytes(d: AnyUsb, bytes: Uint8Array): Promise<void> {
  const { ep } = await openOut(d)
  const CHUNK = 4096
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const r = await d.transferOut(ep, bytes.slice(i, i + CHUNK))
    if (r.status !== 'ok') throw new Error(`USB 傳送失敗（${r.status}）`)
  }
}

// ---------- 中文抬頭：canvas 畫 24 點高（180 dpi）點陣 ----------

const RASTER_FONT = 'bold 20px "Noto Sans HK", "Noto Sans CJK TC", "Microsoft JhengHei", sans-serif'

/** 量度一段字用點陣印出嚟有幾闊（mm） */
export function rasterWidthMm(text: string): number {
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.font = RASTER_FONT
  return (Math.ceil(ctx.measureText(text).width) / 180) * 25.4
}

export function rasterize(text: string): RasterBand {
  const c = document.createElement('canvas')
  const ctx0 = c.getContext('2d')!
  ctx0.font = RASTER_FONT
  const w = Math.max(1, Math.ceil(ctx0.measureText(text).width))
  c.width = w
  c.height = 24
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, 24)
  ctx.font = RASTER_FONT
  ctx.fillStyle = '#000'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 0, 12)
  const px = ctx.getImageData(0, 0, w, 24).data
  return bitmapToBand(w, 24, (x, y) => px[(y * w + x) * 4] < 128)
}

/** 打印項目 → 打印機 bytes（中文自動轉點陣，只限 ESC/P） */
export function encodeForPrinter(items: PrintItem[], mode: PrinterMode): Uint8Array {
  if (mode === 'TEXT') {
    if (items.some(i => hasNonAscii(i.text))) throw new Error('TEXT 模式印唔到中文')
    return encodeText(items)
  }
  const rasters: Record<string, RasterBand> = {}
  for (const it of items) if (hasNonAscii(it.text)) rasters[it.key] = rasterize(it.text)
  return encodeEscp(items, rasters)
}
