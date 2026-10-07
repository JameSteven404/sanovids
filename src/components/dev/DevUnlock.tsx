// The hidden unlock box of development mode: Cài đặt → Giới thiệu, five taps on the version line within 3 s (only while
// locked; no visible hint). It shows this device's code (the owner's tool makes codes for it), takes a 6-digit code from
// the authenticator app or a long "SV1-…" code, and asks main (devAccessActions.unlockDevAccess) — main decides. After a
// code unlock that allows it, it offers to link an authenticator for 5 minutes (DevTotpLink). Texts: devUnlockModel.
import { Copy, LoaderCircle, LockKeyhole } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { beginTotpLink, cancelTotpLink, unlockDevAccess } from '../../devAccessActions'
import { activeProviderId, PROVIDER_LABEL } from '../../providers'
import { simDevAccess } from '../../providers/dev/devAccess'
import { devAccessBridge, useDevAccess } from '../../providers/devAccess'
import { toast } from '../../store/ui'
import { DevTotpLink, useLinkWindowGuard, type TotpLinkData } from './DevTotpLink'
import {
  DEV_DEVICE_COPIED,
  DEV_DEVICE_LABEL,
  DEV_SESSION_ONLY,
  DEV_SIM_HINT,
  DEV_UNLOCK_INTRO,
  DEV_UNLOCK_LABEL,
  DEV_UNLOCK_TITLE,
  DEV_UNLOCK_WEB_ONLY,
  linkInvite,
  mmss,
  SIM_UNLOCK_BUTTON,
  unlockErrorText,
  unlockedToast,
  waitLeft,
} from './devUnlockModel'
import './devUnlock.css'

export function DevUnlock({ onClose }: { onClose: () => void }) {
  useLinkWindowGuard()
  const state = useDevAccess((s) => s.state)
  const bridge = devAccessBridge()
  const sim = bridge === simDevAccess
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<TotpLinkData | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const inputRef = useRef<HTMLInputElement>(null)
  const ticking = !!(state.waitUntil && state.waitUntil > now) || !!(state.linkUntil && state.linkUntil > now)

  useEffect(() => {
    if (!ticking) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [ticking])
  useEffect(() => inputRef.current?.focus(), [])
  // Unlocked without a link offer (or by the build): nothing more to do here.
  useEffect(() => {
    if (state.access !== 'locked' && !state.linkUntil && !link) onClose()
  }, [state.access, state.linkUntil, link, onClose])

  const close = () => {
    if (useDevAccess.getState().state.linkUntil) void cancelTotpLink()
    onClose()
  }

  if (!bridge) {
    return (
      <div className="dv-ul" role="group" aria-label={DEV_UNLOCK_TITLE}>
        <p className="dv-ul-note">{DEV_UNLOCK_WEB_ONLY}</p>
        <div className="dv-ul-actions">
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Đóng
          </button>
        </div>
      </div>
    )
  }

  const copyDevice = async () => {
    try {
      await navigator.clipboard.writeText(state.deviceCode)
      toast(DEV_DEVICE_COPIED, { tone: 'success' })
    } catch {
      toast('Không chép được — hãy ghi lại mã máy.', { tone: 'warning' })
    }
  }

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await unlockDevAccess(code)
      if (res.ok) {
        setCode('')
        toast(unlockedToast(res.state, PROVIDER_LABEL[activeProviderId()]), { tone: 'success', ms: 9000 })
      } else setError(unlockErrorText(res, { device: state.deviceCode }))
    } finally {
      setBusy(false)
    }
  }

  const startLink = async () => {
    const res = await beginTotpLink()
    if (res.ok) setLink({ uri: res.uri, secretGroups: res.secretGroups, label: res.label })
    else setError(unlockErrorText(res, { device: state.deviceCode }))
  }

  // ---- unlocked by a code: the link offer (5 min) ----
  if (state.access !== 'locked') {
    const invite = linkInvite(state, now)
    return (
      <div className="dv-ul" role="group" aria-label={DEV_UNLOCK_TITLE}>
        {link ? (
          <DevTotpLink data={link} onDone={onClose} onCancel={onClose} />
        ) : invite ? (
          <div className="dv-ul-invite">
            <span>{invite}</span>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void startLink()} disabled={state.linkStarted}>
              Liên kết
            </button>
            <button type="button" className="btn btn-sm" onClick={close}>
              Để sau
            </button>
          </div>
        ) : null}
        {!state.persist && <p className="dv-ul-note">{DEV_SESSION_ONLY}</p>}
        {error && (
          <p className="dv-ul-error" role="alert">
            {error}
          </p>
        )}
      </div>
    )
  }

  // ---- locked: the box ----
  const wait = waitLeft(state.waitUntil, now)
  return (
    <div className="dv-ul" role="group" aria-label={DEV_UNLOCK_TITLE}>
      <div className="dv-ul-head">
        <LockKeyhole size={15} aria-hidden />
        <span className="dv-ul-title">
          <b>{DEV_UNLOCK_TITLE}</b>
          <small>{DEV_UNLOCK_INTRO}</small>
        </span>
      </div>
      <div className="dv-ul-device">
        <span>{DEV_DEVICE_LABEL}</span>
        <span className="mono">{state.deviceCode || '—'}</span>
        {state.deviceCode && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void copyDevice()} title="Sao chép mã máy">
            <Copy size={12} /> Sao chép
          </button>
        )}
      </div>
      {sim && <p className="dv-ul-note">{DEV_SIM_HINT}</p>}
      <form
        className="dv-ul-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label htmlFor="dv-ul-code">{DEV_UNLOCK_LABEL}</label>
        <input
          id="dv-ul-code"
          ref={inputRef}
          className="input dv-ul-input"
          inputMode="text"
          autoComplete="one-time-code"
          spellCheck={false}
          maxLength={300}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        {error && (
          <p className="dv-ul-error" role="alert">
            {error}
          </p>
        )}
        {wait > 0 && <p className="dv-ul-wait">Nhập sai nhiều lần — thử lại sau {mmss(wait)}.</p>}
        <div className="dv-ul-actions">
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !code.trim() || (wait > 0 && /^\s*\d[\d\s]*$/.test(code))}>
            {busy ? <LoaderCircle size={13} className="dg-spin" /> : null} Mở khoá
          </button>
          {sim && (
            <button type="button" className="btn btn-sm" onClick={() => simDevAccess.setSimLocked(false)}>
              {SIM_UNLOCK_BUTTON}
            </button>
          )}
          <span className="dv-ul-spacer" />
          <button type="button" className="btn btn-sm" onClick={close}>
            Đóng
          </button>
        </div>
      </form>
    </div>
  )
}
