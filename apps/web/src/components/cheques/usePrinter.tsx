'use client'

// ★ cwm-chequeprint-20261005：打印機連線狀態（WebUSB）
import { useCallback, useEffect, useState } from 'react'
import { choosePrinter, describeDevice, findAuthorizedPrinter, sendBytes, webUsbSupported } from '@/lib/cheque-print/webusb'

export type PrinterState = { kind: 'unsupported' } | { kind: 'none' } | { kind: 'ready'; name: string }

export function usePrinter() {
  const [device, setDevice] = useState<any>(null)
  const [state, setState] = useState<PrinterState>({ kind: 'none' })

  const refresh = useCallback(async () => {
    if (!webUsbSupported()) { setState({ kind: 'unsupported' }); return }
    const d = await findAuthorizedPrinter().catch(() => null)
    setDevice(d)
    setState(d ? { kind: 'ready', name: describeDevice(d) } : { kind: 'none' })
  }, [])

  useEffect(() => {
    refresh()
    const usb = (navigator as any).usb
    if (!usb) return
    const on = () => { refresh() }
    usb.addEventListener('connect', on)
    usb.addEventListener('disconnect', on)
    return () => { usb.removeEventListener('connect', on); usb.removeEventListener('disconnect', on) }
  }, [refresh])

  const connect = useCallback(async () => {
    const d = await choosePrinter()
    setDevice(d)
    setState({ kind: 'ready', name: describeDevice(d) })
    return d
  }, [])

  const send = useCallback(async (bytes: Uint8Array) => {
    const d = device ?? await findAuthorizedPrinter()
    if (!d) throw new Error('未連接打印機')
    await sendBytes(d, bytes)
  }, [device])

  return { state, connect, send, refresh }
}

export function PrinterBadge({ state, onConnect }: { state: PrinterState; onConnect: () => void }) {
  if (state.kind === 'unsupported') {
    return <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 text-amber-800 border border-amber-300 text-sm">呢個瀏覽器唔支援 USB 打印 — 請喺 Ubuntu 機用 Google Chrome</span>
  }
  if (state.kind === 'none') {
    return (
      <button type="button" onClick={onConnect} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-slate-300 text-sm hover:bg-slate-50">
        <span className="w-2 h-2 rounded-full bg-slate-400" aria-hidden />未連接打印機 · 撳呢度揀
      </button>
    )
  }
  return (
    <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-50 text-green-800 border border-green-300 text-sm">
      <span className="w-2 h-2 rounded-full bg-green-600" aria-hidden />{state.name}
    </span>
  )
}
