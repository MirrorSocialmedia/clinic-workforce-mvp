'use client'
/**
 * ★ cwm-provroster S3：醫生當值表「當日詳情」面板
 *   取代舊嘅「單擊開 modal／雙擊預設 4 週／右鍵刪除」三套隱藏操作 —— 一撳就見晒：
 *   來源（固定表／例外／休假／唔返）、時段、備註、Apricot 實際，同埋全部動作掣。
 *   桌面 = 右邊抽屜；手機 = 底部 sheet。Esc／撳背景關閉。
 *   API 由 page 傳入（onSave* / onDelete*），呢個 component 唔直接 fetch。
 */
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { CellInfo } from '@/lib/provider-cell'
import { SLOT_TEXT } from '@/lib/provider-cell'
import type { SlotKey, SlotMap } from '@/lib/provider-pattern'
import { mismatchText, MISMATCH_COLOR, type GridDay } from '@/lib/provider-availability-view'
import { toHKDateStr } from '@/lib/hk-date'

const DOW = ['日', '一', '二', '三', '四', '五', '六']

export interface ExceptionInput { slot: SlotKey | 'OFF' | null; start: string; end: string; note: string }

export default function DayDetailPanel(props: {
  date: string
  dow: number
  providerName: string
  providerColor: string | null
  clinicName: string
  info: CellInfo
  apricot: GridDay | undefined
  slots: SlotMap
  canEdit: boolean
  busy: boolean
  onClose: () => void
  onSaveException: (input: ExceptionInput) => Promise<void>
  onRestorePattern: () => Promise<void>
  onEditLeave: () => void
  onDeleteLeave: () => Promise<void>
  onNewLeave: () => void
  onOpenBatch: () => void
}) {
  const { info, slots } = props
  const [mode, setMode] = useState<'view' | 'edit' | 'off'>('view')
  const [slot, setSlot] = useState<SlotKey | 'CUSTOM'>(info.slot ?? (info.kind === 'duty' ? 'CUSTOM' : 'FULL'))
  const [start, setStart] = useState(info.time?.split('–')[0] ?? slots.FULL.start)
  const [end, setEnd] = useState(info.time?.split('–')[1] ?? slots.FULL.end)
  const [note, setNote] = useState(info.note ?? '')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

  function pickSlot(v: SlotKey | 'CUSTOM') {
    setSlot(v)
    if (v !== 'CUSTOM') { setStart(slots[v].start); setEnd(slots[v].end) }
  }

  const sourceText =
    info.kind === 'leave' ? '休假（醫生休假記錄）'
    : info.kind === 'off' ? '當日唔返（例外）'
    : info.kind === 'duty' && info.isException ? '當日例外（已改過固定表）'
    : info.kind === 'duty' ? '每週固定表'
    : '冇排'

  const ap = props.apricot
  const apText = ap ? mismatchText(ap) : null

  return (
    <div className="fixed inset-0 z-50 bg-black/40" onClick={props.onClose}>
      <div
        role="dialog" aria-label="當日詳情"
        onClick={e => e.stopPropagation()}
        className="absolute bottom-0 left-0 right-0 max-h-[85vh] overflow-y-auto rounded-t-2xl bg-background p-4 shadow-xl
                   md:top-0 md:bottom-0 md:left-auto md:w-[380px] md:max-h-none md:rounded-none"
        style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}
      >
        <div className="flex items-start justify-between gap-2 mb-3">
          <div>
            <div className="text-base font-bold">
              <span style={{ color: props.providerColor || '#888' }}>●</span> {props.providerName}
            </div>
            <div className="text-sm text-muted-foreground">
              {props.date}（{DOW[props.dow]}）· {props.clinicName}
            </div>
          </div>
          <button onClick={props.onClose} aria-label="關閉" className="p-2 -m-2"><X className="w-5 h-5" /></button>
        </div>

        {/* 現況 */}
        <div className="rounded-lg border p-3 text-sm space-y-1 mb-3">
          <div><span className="text-muted-foreground">來源：</span>{sourceText}</div>
          {info.kind === 'duty' && <div><span className="text-muted-foreground">時段：</span>{info.slot ? `${SLOT_TEXT[info.slot]} ` : ''}{info.time}</div>}
          {info.kind === 'leave' && info.leave && (
            <div><span className="text-muted-foreground">休假：</span>{toHKDateStr(info.leave.startDate)}{toHKDateStr(info.leave.startDate) !== toHKDateStr(info.leave.endDate) ? ` ~ ${toHKDateStr(info.leave.endDate)}` : ''}</div>
          )}
          {info.note && <div><span className="text-muted-foreground">備註：</span>{info.note}</div>}
          {info.patternSlot && info.kind !== 'duty' && (
            <div className="text-xs text-muted-foreground">固定表當日本來係：{SLOT_TEXT[info.patternSlot]}</div>
          )}
          {info.isException && info.patternSlot == null && (
            <div className="text-xs text-muted-foreground">固定表當日本來冇排</div>
          )}
        </div>

        {/* Apricot 實際（S2） */}
        {ap && (
          <div className="rounded-lg p-3 text-sm mb-3" style={{ background: apText ? '#fef2f2' : '#f8fafc', color: apText ? MISMATCH_COLOR : undefined }}>
            <div className="font-medium">Apricot 實際</div>
            <div>{ap.apricotOpen ? '有開診' : '未見開診'} · {ap.bookCount} 個約</div>
            {apText && <div className="mt-1 font-semibold">⚠️ {apText}</div>}
          </div>
        )}

        {!props.canEdit ? (
          <div className="text-xs text-muted-foreground">（只讀）</div>
        ) : mode === 'view' ? (
          <div className="grid grid-cols-2 gap-2">
            {info.kind === 'leave' ? (
              <>
                <button disabled={props.busy} onClick={props.onEditLeave} className="h-11 rounded-lg border text-sm">修改休假</button>
                <button disabled={props.busy} onClick={props.onDeleteLeave} className="h-11 rounded-lg border text-sm text-destructive">刪除休假</button>
              </>
            ) : (
              <>
                <button disabled={props.busy} onClick={() => setMode('edit')} className="h-11 rounded-lg bg-primary text-primary-foreground text-sm">
                  {info.kind === 'duty' ? '改當日時段' : info.kind === 'off' ? '改返當值' : '加當日當值'}
                </button>
                <button disabled={props.busy} onClick={() => { setNote(info.kind === 'off' ? (info.note ?? '') : ''); setMode('off') }} className="h-11 rounded-lg border text-sm">
                  {info.kind === 'off' ? '改唔返原因' : '當日唔返'}
                </button>
                {info.isException && (
                  <button disabled={props.busy} onClick={props.onRestorePattern} className="h-11 rounded-lg border text-sm">
                    {info.patternSlot ? '還原固定表' : '刪除當日當值'}
                  </button>
                )}
                <button disabled={props.busy} onClick={props.onNewLeave} className="h-11 rounded-lg border text-sm">設為休假…</button>
              </>
            )}
            <button disabled={props.busy} onClick={props.onOpenBatch} className="h-11 rounded-lg border text-sm col-span-2">批量排（多日／多週）…</button>
          </div>
        ) : mode === 'edit' ? (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-1">
              {(['FULL', 'AM', 'PM', 'CUSTOM'] as const).map(v => (
                <button key={v} type="button" onClick={() => pickSlot(v)}
                  className={`h-10 rounded-lg border text-sm ${slot === v ? 'bg-primary text-primary-foreground' : ''}`}>
                  {v === 'CUSTOM' ? '自訂' : SLOT_TEXT[v]}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-muted-foreground">開始
                <input type="time" value={start} disabled={slot !== 'CUSTOM'} onChange={e => setStart(e.target.value)} className="mt-1 w-full h-10 border rounded px-2 text-sm" />
              </label>
              <label className="text-xs text-muted-foreground">結束
                <input type="time" value={end} disabled={slot !== 'CUSTOM'} onChange={e => setEnd(e.target.value)} className="mt-1 w-full h-10 border rounded px-2 text-sm" />
              </label>
            </div>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="備註（可選）" className="w-full h-10 border rounded px-2 text-sm" />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setMode('view')} className="h-10 px-4 rounded-lg border text-sm">返回</button>
              <button disabled={props.busy || !start || !end}
                onClick={() => props.onSaveException({ slot: slot === 'CUSTOM' ? null : slot, start, end, note })}
                className="h-10 px-4 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50">
                {props.busy ? '儲存中…' : '儲存'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-sm">當日唔返（唔係休假，例如調去其他店）</div>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="原因，例如：調去油麻地" className="w-full h-10 border rounded px-2 text-sm" />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setMode('view')} className="h-10 px-4 rounded-lg border text-sm">返回</button>
              <button disabled={props.busy}
                onClick={() => props.onSaveException({ slot: 'OFF', start: slots.FULL.start, end: slots.FULL.end, note })}
                className="h-10 px-4 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50">
                {props.busy ? '儲存中…' : '確定唔返'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
