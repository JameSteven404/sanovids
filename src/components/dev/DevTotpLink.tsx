// Linking an authenticator app to THIS device (development-mode lock). Shown by DevUnlock / DevAccessRows after main
// opened the 5-minute link window (only right after a code unlock that allows it). The parent asks main for the secret
// (devAccessActions.beginTotpLink — once per window, from a click) and passes it here: it is shown as grouped text with
// a copy button (no QR library: no new dependency), never stored, logged or put in a toast. The 6-digit code from the
// phone confirms; main stores the secret (encrypted by Windows) and closes the window.
// useLinkWindowGuard(): the link window closes with the last UI that can show it (closing Cài đặt = "Để sau").
import { KeyRound, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cancelTotpLink, confirmTotpLink } from '../../devAccessActions'
import { useDevAccess } from '../../providers/devAccess'
import { toast } from '../../store/ui'
import {
  LINK_CLOSE_CONFIRM,
  LINK_EXPIRED,
  LINK_SECRET_COPIED,
  LINK_STEP_1,
  LINK_STEP_2,
  LINK_WARNING,
  linkDoneToast,
  linkManualText,
  mss,
  unlockErrorText,
} from './devUnlockModel'
import './devUnlock.css'

let linkUiMounted = 0

/**
 * Keeps the link window only while a UI that can use it is mounted: when the last one unmounts (Cài đặt closed), main
 * drops the pending secret. Deferred one tick, so React's StrictMode remount never cancels it.
 */
export function useLinkWindowGuard(): void {
  useEffect(() => {
    linkUiMounted++
    return () => {
      linkUiMounted--
      setTimeout(() => {
        if (linkUiMounted === 0 && useDevAccess.getState().state.linkUntil) void cancelTotpLink()
      }, 0)
    }
  }, [])
}

export interface TotpLinkData {
  uri: string
  secretGroups: string[]
  label: string
}

export function DevTotpLink({ data, onDone, onCancel }: { data: TotpLinkData; onDone: () => void; onCancel: () => void }) {
  const linkUntil = useDevAccess((s) => s.state.linkUntil)
  const device = useDevAccess((s) => s.state.deviceCode)
  const [now, setNow] = useState(() => Date.now())
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const expired = !linkUntil || linkUntil <= now

  useEffect(() => {
    if (expired) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [expired])
  useEffect(() => inputRef.current?.focus(), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.secretGroups.join(''))
      toast(LINK_SECRET_COPIED, { tone: 'success' })
    } catch {
      toast('Không chép được — hãy gõ khoá theo từng nhóm 4 ký tự.', { tone: 'warning' })
    }
  }

  const confirm = async () => {
    if (busy || expired) return
    setBusy(true)
    setError(null)
    try {
      const res = await confirmTotpLink(code)
      if (res.ok) {
        toast(linkDoneToast(data.label), { tone: 'success', ms: 8000 })
        onDone()
      } else setError(unlockErrorText(res, { device }))
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    if (!expired && !confirmClose) {
      setConfirmClose(true)
      return
    }
    void cancelTotpLink()
    onCancel()
  }

  if (expired) {
    return (
      <div className="dv-ul-link" role="group" aria-label="Liên kết app xác thực">
        <p className="dv-ul-error" role="alert">
          {LINK_EXPIRED}
        </p>
        <div className="dv-ul-actions">
          <button type="button" className="btn btn-sm" onClick={close}>
            Đóng
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="dv-ul-link" role="group" aria-label="Liên kết app xác thực">
      <div className="dv-ul-actions">
        <KeyRound size={14} aria-hidden />
        <b>Liên kết app xác thực</b>
        <span className="dv-ul-count">Còn {mss(linkUntil - now)}</span>
      </div>
      <p>{LINK_STEP_1}</p>
      <div className="dv-ul-secret">
        <span>{linkManualText(data.label)}</span>
        <code aria-label="Khoá thiết lập">
          {data.secretGroups.map((g, i) => (
            <span key={i}>{g}</span>
          ))}
        </code>
        <button type="button" className="btn btn-sm" onClick={() => void copy()}>
          Sao chép
        </button>
      </div>
      <p className="dv-ul-warn">{LINK_WARNING}</p>
      <form
        className="dv-ul-actions"
        onSubmit={(e) => {
          e.preventDefault()
          void confirm()
        }}
      >
        <label htmlFor="dv-ul-totp">{LINK_STEP_2}</label>
        <input
          id="dv-ul-totp"
          ref={inputRef}
          className="input dv-ul-totp"
          inputMode="numeric"
          autoComplete="one-time-code"
          spellCheck={false}
          maxLength={7}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || code.replace(/\s/g, '').length !== 6}>
          {busy ? <LoaderCircle size={13} className="dg-spin" /> : null} Xác nhận
        </button>
      </form>
      {error && (
        <p className="dv-ul-error" role="alert">
          {error}
        </p>
      )}
      {confirmClose ? (
        <div className="dg-callout warn dg-confirm" role="group" aria-label="Huỷ lời mời liên kết">
          <div>{LINK_CLOSE_CONFIRM}</div>
          <div className="dg-confirm-actions">
            <button type="button" className="btn btn-sm" onClick={() => setConfirmClose(false)}>
              Ở lại
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={close}>
              Đóng
            </button>
          </div>
        </div>
      ) : (
        <div className="dv-ul-actions">
          <span className="dv-ul-spacer" />
          <button type="button" className="btn btn-sm" onClick={close}>
            Đóng
          </button>
        </div>
      )}
    </div>
  )
}
