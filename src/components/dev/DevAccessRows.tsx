// The top of Cài đặt → "Chế độ Phát triển" (SettingsAdvanced DevBlock, shown only while development mode is open):
// how it is open (by the build / unlocked until …), "Giữ mở khoá" (1 / 7 / 30 days / until locked, bounded by a code's
// own limit), the authenticator link (link inside the 5-minute window after a code unlock, unlink), "Khoá lại ngay"
// (running DEV takes finish), and in a browser on this computer the simulation's "Xem như bản phát hành (đã khoá)".
// Main checks every request; texts: devUnlockModel.
import { KeyRound, Lock, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { beginTotpLink, lockDevAccess, removeTotpLink, setDevKeep } from '../../devAccessActions'
import { providerOf } from '../../providers'
import { simDevAccess } from '../../providers/dev/devAccess'
import { devAccessBridge, useDevAccess, type DevKeepDays } from '../../providers/devAccess'
import { useRuns } from '../../store/runs'
import { toast } from '../../store/ui'
import { Segmented } from '../dialogs/Segmented'
import { Toggle } from '../dialogs/settingsUi'
import { DevTotpLink, useLinkWindowGuard, type TotpLinkData } from './DevTotpLink'
import {
  accessStatusLine,
  capNote,
  DEV_SESSION_ONLY,
  KEEP_LABEL,
  KEEP_ORDER,
  keepDisabled,
  LINK_BUILD,
  lockConfirm,
  mss,
  SIM_LOCK_HINT,
  SIM_LOCK_LABEL,
  SIM_UNLOCK_BUTTON,
  TOTP_LINK_HINT,
  totpStatusLine,
  unlinkConfirm,
  unlockErrorText,
} from './devUnlockModel'
import './devUnlock.css'

export function DevAccessRows() {
  useLinkWindowGuard()
  const state = useDevAccess((s) => s.state)
  const runningDev = useRuns((s) => s.takes.reduce((n, t) => (providerOf(t) === 'dev' && (t.status === 'queued' || t.status === 'processing') ? n + 1 : n), 0))
  const sim = devAccessBridge() === simDevAccess
  const [confirm, setConfirm] = useState<'lock' | 'unlink' | null>(null)
  const [link, setLink] = useState<TotpLinkData | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const linkOpen = !!state.linkUntil && state.linkUntil > now

  useEffect(() => {
    if (!state.linkUntil) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [state.linkUntil])

  const keep = async (days: DevKeepDays) => {
    const res = await setDevKeep(days)
    if (!res.ok) toast(unlockErrorText(res, { device: state.deviceCode }), { tone: 'warning' })
  }
  const startLink = async () => {
    const res = await beginTotpLink()
    if (res.ok) setLink({ uri: res.uri, secretGroups: res.secretGroups, label: res.label })
    else toast(unlockErrorText(res, { device: state.deviceCode }), { tone: 'warning' })
  }
  const unlink = async () => {
    setConfirm(null)
    const res = await removeTotpLink()
    if (res.ok) toast('Đã bỏ liên kết app xác thực trên máy này.', { tone: 'success' })
    else toast(unlockErrorText(res, { device: state.deviceCode }), { tone: 'warning' })
  }

  const unlocked = state.access === 'unlocked'
  return (
    <div className="dv-ul-rows">
      <div className="dv-ul-status">
        <ShieldCheck size={14} aria-hidden />
        <span>{accessStatusLine(state)}</span>
      </div>
      {unlocked && !state.persist && <div className="dg-field-hint">{DEV_SESSION_ONLY}</div>}

      {unlocked && (
        <div className="dg-field">
          <span className="label">Giữ mở khoá</span>
          <Segmented<DevKeepDays>
            label="Giữ mở khoá"
            value={state.keepDays}
            onChange={(d) => void keep(d)}
            options={KEEP_ORDER.map((d) => ({ id: d, label: KEEP_LABEL[d], disabled: keepDisabled(d, state.capUntil, now) }))}
          />
          {state.capUntil !== null && <div className="dg-field-hint">{capNote(state.capUntil)}</div>}
        </div>
      )}

      <div className="dv-ul-row">
        <span>
          <KeyRound size={12} aria-hidden /> App xác thực: <b>{totpStatusLine(state)}</b>
          {state.deviceCode ? <span className="faint"> · mã máy {state.deviceCode}</span> : null}
        </span>
        {state.access === 'build' ? (
          <span className="faint">{LINK_BUILD}</span>
        ) : linkOpen && !link ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void startLink()} disabled={state.linkStarted}>
            Liên kết · còn {mss((state.linkUntil ?? now) - now)}
          </button>
        ) : state.totp.linked && unlocked ? (
          <button type="button" className="btn btn-sm" onClick={() => setConfirm('unlink')}>
            Bỏ liên kết
          </button>
        ) : (
          <span className="faint">{TOTP_LINK_HINT}</span>
        )}
      </div>
      {link && <DevTotpLink data={link} onDone={() => setLink(null)} onCancel={() => setLink(null)} />}
      {confirm === 'unlink' && (
        <div className="dg-callout warn dg-confirm" role="group" aria-label="Xác nhận bỏ liên kết">
          <div>{unlinkConfirm(state.totp.label ?? 'SanoVids')}</div>
          <div className="dg-confirm-actions">
            <button type="button" className="btn btn-sm" onClick={() => setConfirm(null)}>
              Huỷ
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void unlink()}>
              Bỏ liên kết
            </button>
          </div>
        </div>
      )}

      {unlocked &&
        (confirm === 'lock' ? (
          <div className="dg-callout warn dg-confirm" role="group" aria-label="Xác nhận khoá chế độ Phát triển">
            <div>{lockConfirm(runningDev)}</div>
            <div className="dg-confirm-actions">
              <button type="button" className="btn btn-sm" onClick={() => setConfirm(null)}>
                Huỷ
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => {
                  setConfirm(null)
                  void lockDevAccess()
                }}
              >
                Khoá lại
              </button>
            </div>
          </div>
        ) : (
          <div className="dv-ul-actions">
            <button type="button" className="btn btn-sm" onClick={() => setConfirm('lock')}>
              <Lock size={13} /> Khoá lại ngay
            </button>
            {sim && (
              <button type="button" className="btn btn-sm" onClick={() => simDevAccess.setSimLocked(false)}>
                {SIM_UNLOCK_BUTTON}
              </button>
            )}
          </div>
        ))}

      {sim && state.access === 'build' && <Toggle checked={false} onChange={(on) => on && simDevAccess.setSimLocked(true)} label={SIM_LOCK_LABEL} hint={SIM_LOCK_HINT} />}
    </div>
  )
}
