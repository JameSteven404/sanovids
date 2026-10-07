import { memo, useLayoutEffect, useState } from 'react'
import { create } from 'zustand'
import { actionById, changedBindingsCount, chordFromEvent, chordLabel, defaultsFor, KEY_ACTIONS, refusalFor, warningsFor, type ActionId } from '../../core/keymap'
import { eventLike, IS_MAC, isImeKey } from '../../lib/keyEvents'
import { useKeymap } from '../../lib/keymapPrefs'
import { toast } from '../../store/ui'
import type { RowProps } from './settingsUi'

type Capture = { id: ActionId; index: number; message: string; chords?: string[] }
const useCapture = create<{ capture: Capture | null }>(() => ({ capture: null }))
export { useCapture as useKeyCapture }
const stopCapture = () => useCapture.setState({ capture: null })

/** All edits use the same validated store as settings import; Undo includes displaced commands. */
export function changeKeys(change: () => void, text: string): void {
  const state = useKeymap.getState()
  const before = { ...state.foreign, ...state.bindings }
  change()
  toast(text, { action: { label: 'Hoàn tác', run: () => { stopCapture(); useKeymap.getState().replace(before) } } })
}

function assign(capture: Capture, chords: string[], replace = false): void {
  const before = useKeymap.getState()
  const snapshot = { ...before.foreign, ...before.bindings }
  const result = before.assign(capture.id, chords, replace)
  if (result.issues.length) {
    useCapture.setState({ capture: { ...capture, message: result.issues.map((i) => i.message).join(' '),
      chords: result.issues.every((i) => i.reason === 'conflict' && i.with !== capture.id) ? chords : undefined } })
    return
  }
  stopCapture()
  toast(`Đã đổi: ${actionById(capture.id)!.label} = ${useKeymap.getState().resolved.allLabels[capture.id] || 'Chưa gán'}.`, {
    action: { label: 'Hoàn tác', run: () => { stopCapture(); useKeymap.getState().replace(snapshot) } },
  })
}

/** Mounted by SettingsDialog before Modal's passive Escape listener. */
export function useKeyCaptureHost(): void {
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const capture = useCapture.getState().capture
      if (!capture) return
      if (e.key === 'Tab') { stopCapture(); return }
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape' && !isImeKey(e)) { stopCapture(); return }
      if (e.repeat) return
      const chord = chordFromEvent(eventLike(e), IS_MAC)
      if (!chord) {
        const modifier = /^(Control|Meta|Alt|Shift)$/.test(e.key)
        useCapture.setState({ capture: { ...capture, chords: undefined, message: modifier
          ? `${e.key}… Bấm thêm một phím.`
          : 'Bộ gõ đang bật hoặc phím không đọc được. Dùng tổ hợp có Ctrl / Alt hoặc tắt bộ gõ rồi bấm lại.' } })
        return
      }
      const reason = refusalFor(chord, capture.id, IS_MAC)
      if (reason) { useCapture.setState({ capture: { ...capture, chords: undefined, message: reason } }); return }
      const chords = [...useKeymap.getState().resolved.byAction[capture.id]]
      chords[capture.index] = chord
      assign(capture, chords)
    }
    const blur = () => stopCapture()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', blur)
    return () => { stopCapture(); window.removeEventListener('keydown', onKey, true); window.removeEventListener('blur', blur) }
  }, [])
}

export function KeysIntro() {
  const bindings = useKeymap((s) => s.bindings)
  const [reset, setReset] = useState(false)
  return <div className="dg-note">
    <p>Phím mặc định giống Adobe Premiere Pro; các phím quen của SanoVids vẫn có phím phụ.</p>
    <p>Bấm vào một phím để đổi. Mỗi lệnh có tối đa 2 tổ hợp phím. Lưu trên máy này — mang sang máy khác bằng “Xuất / nhập cài đặt”.</p>
    <p>Unikey / EVKey có thể nuốt phím một chữ. Esc, Tab, Enter, Space, mũi tên và phím điều khiển video được giữ cố định.</p>
    <button className="btn" onClick={() => setReset(true)}>Premiere · Khôi phục mặc định ({changedBindingsCount(bindings, IS_MAC)} lệnh đã đổi)</button>{' '}
    <button className="btn" onClick={() => { stopCapture(); changeKeys(() => useKeymap.getState().preset('legacy05'), 'Đã dùng bộ phím Bản 0.5.'); setReset(false) }}>Bản 0.5</button>{' '}
    <button className="btn" onClick={() => {
      stopCapture()
      changeKeys(() => {
        for (const a of KEY_ACTIONS) {
          const chords = useKeymap.getState().resolved.byAction[a.id]
          const plain = chords.find((c) => /^Key[A-Z]$/.test(c))
          if (plain && chords.length < 2) useKeymap.getState().assign(a.id, [...chords, `Alt+${plain}`])
        }
      }, 'Đã thêm phím phụ Alt + chữ cho các lệnh còn chỗ và không trùng phím.')
    }}>Thêm phím phụ Alt + chữ</button>
    {reset && <p>Đưa mọi phím tắt về mặc định?{' '}
      <button className="btn" onClick={() => { stopCapture(); changeKeys(() => useKeymap.getState().preset('premiere'), 'Đã khôi phục bộ phím Premiere.'); setReset(false) }}>Khôi phục</button>{' '}
      <button className="btn" onClick={() => setReset(false)}>Huỷ</button>
    </p>}
  </div>
}

function KeyBindingRow({ id, label, hint }: RowProps & { id: ActionId }) {
  const chords = useKeymap((s) => s.resolved.byAction[id])
  const capture = useCapture((s) => s.capture?.id === id ? s.capture : null)
  const action = actionById(id)!
  const begin = (index: number) => useCapture.setState({ capture: { id, index, message: 'Bấm tổ hợp mới · Esc để huỷ · Tab để chuyển.' } })
  const premiere = action.premiere && chords.includes(IS_MAC && action.macDefaults ? defaultsFor(action, true)[0] : action.premiere.chord ?? '')
  // Cancel a recorder whose row was removed by search or a tab switch.
  useLayoutEffect(() => () => { if (useCapture.getState().capture?.id === id) stopCapture() }, [id])
  return <div className="dg-field" role="group" aria-label={label}>
    <div className="label">{label} {premiere && <span className="badge" title={action.premiere?.name}>Premiere</span>}</div>
    <p className="dg-note">{hint}</p>
    <div>
      {!chords.length && <span>Chưa gán · </span>}
      {chords.map((c, index) => <span key={c}>
        <button className="btn" aria-label={`Đổi phím ${chordLabel(c, IS_MAC)} của “${label}”`} onClick={() => begin(index)}>{chordLabel(c, IS_MAC)}</button>
        <button className="btn" aria-label={`Bỏ phím ${chordLabel(c, IS_MAC)} khỏi “${label}”`} onClick={() => { stopCapture(); changeKeys(() => useKeymap.getState().removeChord(id, c), `Đã bỏ phím của “${label}”.`) }}>×</button>{' '}
      </span>)}
      {chords.length < 2 && <button className="btn" onClick={() => begin(chords.length)}>{chords.length ? '+ Phím phụ' : 'Gán phím'}</button>}{' '}
      <button className="btn" onClick={() => { stopCapture(); changeKeys(() => useKeymap.getState().resetAction(id), `Đã đặt lại “${label}”.`) }}>Mặc định</button>
    </div>
    {capture && <div role="status">
      <p>{capture.message}</p>
      {capture.chords && <>
        <button className="btn" onClick={() => assign(capture, capture.chords!, true)}>Thay thế</button>{' '}
        <button className="btn" onClick={() => begin(capture.index)}>Chọn phím khác</button>{' '}
      </>}
      <button className="btn" onClick={stopCapture}>Huỷ</button>
    </div>}
    {chords.flatMap((c) => warningsFor(c, IS_MAC, !window.bdpDesktop)).map((warning, i) => <p className="dg-note" key={i}>{warning}</p>)}
  </div>
}

// Stable component identities: changing a key must not remount every row.
export const SHORTCUT_ROWS = KEY_ACTIONS.map((a) => ({ id: a.id, label: a.label, hint: `${a.help} ${a.hint}`, keywords: `${a.keywords} ${a.premiere?.name ?? ''}`,
  C: memo(function ShortcutRow(props: RowProps) { return <KeyBindingRow {...props} id={a.id} /> }),
}))
