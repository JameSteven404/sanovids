import { memo, useEffect, useId, useRef, useState } from 'react'
import { ClipboardPaste, ExternalLink, KeyRound, RefreshCw, Save, Trash2, TriangleAlert } from 'lucide-react'
import { SERVICES } from '../../core/services'
import type { SeedvisAccountInfo, SeedvisKeyStatus } from '../../providers/seedvis/contract'
import { ProviderTag } from '../common/ProviderTag'
import {
  DEFAULT_SEEDVIS_GUARD, SEEDVIS_PRIVACY_NOTE, seedvisAccountRows, seedvisActionBlock, seedvisCanSaveUnverified,
  seedvisClipboardNote, seedvisErrorText, seedvisGuardCommit, seedvisKeyLabel, seedvisKeyWarning, seedvisRestoreNote,
  type SeedvisKeyAction, type SeedvisPlatform, type SeedvisSectionAction, type SeedvisSectionError,
  type SeedvisSectionErrorCode, type SeedvisSpendingGuard,
} from './seedvisSectionModel'
import './seedvisSection.css'

export interface SeedvisSectionProps {
  keyStatus: SeedvisKeyStatus
  account: SeedvisAccountInfo | null
  platform: SeedvisPlatform
  // Caller supplies the deduplicated live + ledger count across all projects for this key.
  activeTakes: number
  busy?: SeedvisSectionAction | null
  /** A code, or main's failure (code + fixed message) and the action that failed. */
  error?: SeedvisSectionErrorCode | SeedvisSectionError | null
  clipboardCleared?: boolean
  linkRetention?: string
  showPrivacyNote?: boolean
  guard?: Readonly<SeedvisSpendingGuard>
  onGuardChange: (guard: SeedvisSpendingGuard) => void
  onAction: (action: SeedvisSectionAction) => void
  devOpen?: boolean
  mode?: 'seedvis' | 'seedvis-dev'
  onModeChange?: (mode: 'seedvis' | 'seedvis-dev') => void
  // Optional host-owned entry flow: this component never accepts or returns a key string.
  canEnterKey?: boolean
}

const isKeyAction = (action: SeedvisSectionAction): action is SeedvisKeyAction =>
  action === 'paste' || action === 'enter' || action === 'save-unverified' || action === 'clear'

/** A spending-guard number: keystrokes edit a local draft, blur / Enter commit it (or bring the last value back). */
const GuardField = memo(function GuardField({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const next = seedvisGuardCommit(draft, value)
    setDraft(next.draft)
    if (next.value !== value) onCommit(next.value)
  }
  return (
    <label>{label}<input className="input" type="number" inputMode="numeric" min={1} step={1} value={draft}
      onChange={event => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit() } }} /></label>
  )
})

export const SeedvisSection = memo(function SeedvisSection({
  keyStatus, account, platform, activeTakes, busy = null, error, clipboardCleared = false, linkRetention,
  showPrivacyNote = true, guard = DEFAULT_SEEDVIS_GUARD, onGuardChange, onAction,
  devOpen = false, mode = 'seedvis', onModeChange, canEnterKey = false,
}: SeedvisSectionProps) {
  const id = useId()
  const [pending, setPending] = useState<SeedvisKeyAction | null>(null)
  const keepKey = useRef<HTMLButtonElement>(null)
  const actionButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (pending) keepKey.current?.focus()
    else actionButton.current?.focus()
  }, [pending])
  const warning = pending ? seedvisKeyWarning(pending, activeTakes, keyStatus) : null
  const restoreNote = seedvisRestoreNote(keyStatus, activeTakes, platform)
  const block = (action: SeedvisSectionAction) => seedvisActionBlock(action, keyStatus, platform, !!busy)
  const request = (action: SeedvisSectionAction, button: HTMLButtonElement) => {
    if (block(action)) return
    if (isKeyAction(action) && seedvisKeyWarning(action, activeTakes, keyStatus)) {
      actionButton.current = button
      setPending(action)
      return
    }
    onAction(action)
  }
  const confirm = () => {
    if (!pending || block(pending)) return
    const action = pending
    setPending(null)
    onAction(action)
  }
  const actions = [
    { action: 'paste', label: 'Dán key', Icon: ClipboardPaste },
    ...(canEnterKey ? [{ action: 'enter' as const, label: 'Nhập key', Icon: KeyRound }] : []),
    ...(seedvisCanSaveUnverified(error) ? [{ action: 'save-unverified' as const, label: 'Lưu mà chưa kiểm tra', Icon: Save }] : []),
    { action: 'check', label: 'Kiểm tra', Icon: RefreshCw },
    { action: 'clear', label: 'Xoá key', Icon: Trash2 },
  ] as const

  return (
    <section className="dg-section dg-seedvis" aria-labelledby={`${id}-title`} aria-busy={!!busy}>
      <header><h3 id={`${id}-title`}>{SERVICES.seedvis.site} <ProviderTag service="seedvis" simulated={mode === 'seedvis-dev'} /></h3></header>
      <p role="status">{seedvisKeyLabel(keyStatus, platform)}</p>
      {restoreNote && <p className="dg-seedvis-note">{restoreNote}</p>}
      {error && <p className="dg-seedvis-warning" role="alert"><TriangleAlert size={16} aria-hidden="true" />{seedvisErrorText(error)}</p>}
      <div className="dg-seedvis-actions">
        {actions.map(({ action, label, Icon }) => <button key={action} type="button" className="btn"
          disabled={!!block(action) || !!pending} title={block(action) ?? undefined} onClick={event => request(action, event.currentTarget)}>
          <Icon size={14} aria-hidden="true" />{busy === action ? 'Đang xử lý…' : label}
        </button>)}
      </div>
      {pending && <div className="dg-seedvis-confirm" role="group" aria-labelledby={`${id}-confirm`}>
        <p id={`${id}-confirm`} role="alert">{warning ?? 'Tiếp tục thao tác với khoá seedvis?'}</p>
        <div className="dg-seedvis-actions">
          <button ref={keepKey} type="button" className="btn" onClick={() => setPending(null)}>Giữ khoá hiện tại</button>
          <button type="button" className="btn" disabled={!!block(pending)} onClick={confirm}>
            {pending === 'clear' ? 'Vẫn xoá khoá' : 'Tiếp tục thay khoá'}
          </button>
        </div>
      </div>}
      <p className="dg-seedvis-note">{seedvisClipboardNote(platform, clipboardCleared)}</p>
      <dl className="dg-seedvis-account">
        {seedvisAccountRows(account, linkRetention).map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
      </dl>
      <fieldset className="dg-seedvis-guard">
        <legend>Hỏi thêm trước khi chạy nhiều cảnh seedvis</legend>
        <GuardField label="Hơn số cảnh" value={guard.takes} onCommit={takes => onGuardChange({ ...guard, takes })} />
        <GuardField label="Hơn thời lượng (giây)" value={guard.seconds} onCommit={seconds => onGuardChange({ ...guard, seconds })} />
        <p className="dg-seedvis-note">Cũng hỏi thêm khi ước tính vượt số dư hoặc số dư bằng 0. Đây là lời xác nhận thêm; seedvis quyết định có đủ credit để chạy.</p>
      </fieldset>
      {showPrivacyNote && <p className="dg-seedvis-note">{SEEDVIS_PRIVACY_NOTE}</p>}
      <button type="button" className="btn" disabled={!!block('billing')} title={block('billing') ?? undefined} onClick={event => request('billing', event.currentTarget)}>
        <ExternalLink size={14} aria-hidden="true" />Nạp credit trên {SERVICES.seedvis.site}
      </button>
      {devOpen && onModeChange && <label className="dg-seedvis-mode">Chế độ seedvis
        <select className="select" value={mode} disabled={!!busy} onChange={event => onModeChange(event.target.value === 'seedvis-dev' ? 'seedvis-dev' : 'seedvis')}>
          <option value="seedvis-dev">Giả lập</option><option value="seedvis" disabled={platform === 'web'}>Thật</option>
        </select>
      </label>}
    </section>
  )
})
