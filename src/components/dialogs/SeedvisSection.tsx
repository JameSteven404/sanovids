import { memo, useEffect, useId, useRef, useState } from 'react'
import { ClipboardPaste, ExternalLink, KeyRound, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import { SERVICES } from '../../core/services'
import type { SeedvisAccountInfo, SeedvisBridgeErrorCode, SeedvisKeyStatus } from '../../providers/seedvis/contract'
import { ProviderTag } from '../common/ProviderTag'
import {
  DEFAULT_SEEDVIS_GUARD, SEEDVIS_CLIPBOARD_NOTE, SEEDVIS_PRIVACY_NOTE, seedvisAccountRows, seedvisActionBlock,
  seedvisErrorText, seedvisGuardValue, seedvisKeyLabel, seedvisKeyWarning,
  type SeedvisKeyAction, type SeedvisPlatform, type SeedvisSectionAction, type SeedvisSpendingGuard,
} from './seedvisSectionModel'
import './seedvisSection.css'

export interface SeedvisSectionProps {
  keyStatus: SeedvisKeyStatus
  account: SeedvisAccountInfo | null
  platform: SeedvisPlatform
  // Caller supplies the deduplicated live + ledger count across all projects for this key.
  activeTakes: number
  busy?: SeedvisSectionAction | null
  error?: SeedvisBridgeErrorCode | null
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
  const warning = pending ? seedvisKeyWarning(pending, activeTakes, keyStatus.hint) : null
  const block = (action: SeedvisSectionAction) => seedvisActionBlock(action, keyStatus, platform, !!busy)
  const request = (action: SeedvisSectionAction, button: HTMLButtonElement) => {
    if (block(action)) return
    if ((action === 'paste' || action === 'enter' || action === 'clear') && seedvisKeyWarning(action, activeTakes, keyStatus.hint)) {
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
    { action: 'check', label: 'Kiểm tra', Icon: RefreshCw },
    { action: 'clear', label: 'Xoá key', Icon: Trash2 },
  ] as const

  return (
    <section className="dg-section dg-seedvis" aria-labelledby={`${id}-title`} aria-busy={!!busy}>
      <header><h3 id={`${id}-title`}>{SERVICES.seedvis.site} <ProviderTag service="seedvis" simulated={mode === 'seedvis-dev'} /></h3></header>
      <p role="status">{seedvisKeyLabel(keyStatus, platform)}</p>
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
      <p className="dg-seedvis-note">{clipboardCleared && 'Đã xoá key khỏi clipboard hiện tại. '}{platform === 'windows'
        ? SEEDVIS_CLIPBOARD_NOTE : 'Nếu dùng ứng dụng lưu hoặc đồng bộ clipboard, hãy xoá dòng chứa key ở đó sau khi dán.'}</p>
      <dl className="dg-seedvis-account">
        {seedvisAccountRows(account, linkRetention).map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
      </dl>
      <fieldset className="dg-seedvis-guard">
        <legend>Hỏi thêm trước khi chạy nhiều cảnh seedvis</legend>
        <label>Hơn số cảnh<input className="input" type="number" min={1} step={1} value={guard.takes}
          onChange={event => { const value = seedvisGuardValue(event.target.value); if (value !== null) onGuardChange({ ...guard, takes: value }) }} /></label>
        <label>Hơn thời lượng (giây)<input className="input" type="number" min={1} step={1} value={guard.seconds}
          onChange={event => { const value = seedvisGuardValue(event.target.value); if (value !== null) onGuardChange({ ...guard, seconds: value }) }} /></label>
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
