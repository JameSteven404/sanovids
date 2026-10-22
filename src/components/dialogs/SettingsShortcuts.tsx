import { memo, useLayoutEffect, useState } from 'react'
import { create } from 'zustand'
import { actionById, changedBindingsCount, chordFromEvent, chordLabel, defaultsFor, formatChord, KEY_ACTIONS, refusalFor, warningsFor, type ActionId } from '../../core/keymap'
import { eventLike, IS_MAC, isImeKey } from '../../lib/keyEvents'
import { useKeymap } from '../../lib/keymapPrefs'
import { platformText } from '../../lib/platformText'
import { toast } from '../../store/ui'
import type { RowProps } from './settingsUi'

/**
 * The recorder of one row. `chords` = a conflicting choice waiting for Thay thế / Chọn phím khác / Huỷ; while it waits
 * (`paused`) keys are no longer recorded, so Tab / Enter / Space reach those buttons (only Esc still cancels).
 */
export type Capture = { id: ActionId; index: number; message: string; chords?: string[]; paused?: boolean }
const useCapture = create<{ capture: Capture | null }>(() => ({ capture: null }))
export { useCapture as useKeyCapture }
const stopCapture = () => useCapture.setState({ capture: null })
/** The Alt key as written in UI text ('⌥' on a Mac). */
const ALT = IS_MAC ? '⌥' : 'Alt'
/** The row element of a command (the recorder stays armed only while the user works inside it). */
const rowSelector = (id: ActionId) => `[data-key-row="${id}"]`

/** All edits use the same validated store as settings import; Undo includes displaced commands. `text` may read what `change` did. */
export function changeKeys(change: () => void, text: string | (() => string)): void {
  const state = useKeymap.getState()
  const before = { ...state.foreign, ...state.bindings }
  change()
  toast(typeof text === 'function' ? text() : text, { action: { label: 'Hoàn tác', run: () => { stopCapture(); useKeymap.getState().replace(before) } } })
}

/** Assign the recorded chords (`replace`: Thay thế, taking them from the commands that had them). */
export function assignKeys(capture: Capture, chords: string[], replace = false): void {
  const before = useKeymap.getState()
  const snapshot = { ...before.foreign, ...before.bindings }
  const result = before.assign(capture.id, chords, replace)
  if (result.issues.length) {
    const conflict = result.issues.every((i) => i.reason === 'conflict' && i.with !== capture.id)
    useCapture.setState({ capture: { ...capture, message: result.issues.map((i) => i.message).join(' '),
      chords: conflict ? chords : undefined, paused: conflict } })
    return
  }
  stopCapture()
  const after = useKeymap.getState().resolved
  const label = actionById(capture.id)!.label
  const added = chords[capture.index]
  // Commands that lost a chord to this one (Thay thế): say what is left of them.
  const displaced = KEY_ACTIONS.filter((a) => a.id !== capture.id && before.resolved.byAction[a.id].some((c) => !after.byAction[a.id].includes(c)))
    .map((a) => after.byAction[a.id].length ? ` “${a.label}” còn ${after.allLabels[a.id]}.` : ` “${a.label}” không còn phím tắt.`)
  toast(`${added ? `Đã gán ${chordLabel(added, IS_MAC)} cho “${label}”.` : `Đã đổi “${label}”: ${after.allLabels[capture.id] || 'Chưa gán'}.`}${displaced.join('')}`, {
    action: { label: 'Hoàn tác', run: () => { stopCapture(); useKeymap.getState().replace(snapshot) } },
  })
}

/** "Ctrl+Shift+…" / "⇧⌘…" while only modifiers are held (the recorder's preview, in key-cap names). */
export function heldModifiers(e: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }, mac = IS_MAC): string {
  return chordLabel(formatChord({ ctrl: !!(mac ? e.metaKey : e.ctrlKey), alt: !!e.altKey, shift: !!e.shiftKey, id: 'KeyX' }), mac).slice(0, -1)
}

/** Mounted by SettingsDialog before Modal's passive Escape listener. */
export function useKeyCaptureHost(): void {
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const capture = useCapture.getState().capture
      if (!capture) return
      if (capture.paused) {
        // A conflict waits for a choice: keys work as usual on its buttons; Esc cancels it (not the dialog).
        if (e.key === 'Escape' && !isImeKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); stopCapture() }
        return
      }
      if (e.key === 'Tab') { stopCapture(); return }
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape' && !isImeKey(e)) { stopCapture(); return }
      if (e.repeat) return
      const chord = chordFromEvent(eventLike(e), IS_MAC)
      if (!chord) {
        const modifier = /^(Control|Meta|Alt|Shift)$/.test(e.key)
        const held = modifier ? heldModifiers(e) : ''
        useCapture.setState({ capture: { ...capture, chords: undefined, message: !modifier
          ? `Bộ gõ đang bật hoặc phím không đọc được. Dùng tổ hợp có ${platformText.mod} / ${ALT} hoặc tắt bộ gõ rồi bấm lại.`
          : held ? `${held}… Bấm thêm một phím.` : `Phím ${IS_MAC ? 'Control' : 'Windows'} không dùng làm phím tắt — bấm tổ hợp khác.` } })
        return
      }
      const reason = refusalFor(chord, capture.id, IS_MAC)
      if (reason) { useCapture.setState({ capture: { ...capture, chords: undefined, message: reason } }); return }
      const chords = [...useKeymap.getState().resolved.byAction[capture.id]]
      chords[capture.index] = chord
      assignKeys(capture, chords)
    }
    // A click or focus anywhere else (the search box, another row…) ends the recording: a key meant for that place
    // must never be assigned silently.
    const outside = (e: Event) => {
      const capture = useCapture.getState().capture
      const target = e.target as { closest?: (s: string) => unknown } | null
      if (capture && !(typeof target?.closest === 'function' && target.closest(rowSelector(capture.id)))) stopCapture()
    }
    const blur = () => stopCapture()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('focusin', outside, true)
    window.addEventListener('blur', blur)
    return () => {
      stopCapture()
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('focusin', outside, true)
      window.removeEventListener('blur', blur)
    }
  }, [])
}

/** The toast of "Thêm phím phụ Alt + chữ": what was really added, and how many were left out. */
export function altKeysText(added: number, skipped: number, alt = ALT): string {
  const head = added ? `Đã thêm phím phụ ${alt} + chữ cho ${added} lệnh.` : `Không thêm được phím phụ ${alt} + chữ nào.`
  return skipped ? `${head} ${skipped} lệnh bỏ qua (trùng phím hoặc phím không dùng được).` : head
}

export function KeysIntro() {
  const bindings = useKeymap((s) => s.bindings)
  const [confirm, setConfirm] = useState<'premiere' | 'legacy05' | null>(null)
  const apply = (name: 'premiere' | 'legacy05') => {
    stopCapture()
    changeKeys(() => useKeymap.getState().preset(name), name === 'legacy05' ? 'Đã dùng bộ phím kiểu SanoVids 0.5.' : 'Đã khôi phục bộ phím Premiere.')
    setConfirm(null)
  }
  return <div className="dg-note">
    <p>Phím mặc định giống Adobe Premiere Pro; các phím quen của SanoVids vẫn có phím phụ.</p>
    <p>Bấm vào một phím để đổi. Mỗi lệnh có tối đa 2 tổ hợp phím. Lưu trên máy này — mang sang máy khác bằng “Xuất / nhập cài đặt”.</p>
    <p>Bộ gõ tiếng Việt ({platformText.inputTools}) có thể nuốt phím một chữ. Esc, Tab, Enter, Space, mũi tên và phím điều khiển video được giữ cố định.</p>
    <button className="btn" onClick={() => setConfirm('premiere')}>Premiere · Khôi phục mặc định ({changedBindingsCount(bindings, IS_MAC)} lệnh đã đổi)</button>{' '}
    <button className="btn" onClick={() => setConfirm('legacy05')} title="Dùng bộ phím kiểu SanoVids 0.5">Bản 0.5</button>{' '}
    <button className="btn" onClick={() => {
      stopCapture()
      let added = 0
      let skipped = 0
      changeKeys(() => {
        for (const a of KEY_ACTIONS) {
          const chords = useKeymap.getState().resolved.byAction[a.id]
          const plain = chords.find((c) => /^Key[A-Z]$/.test(c))
          if (!plain || chords.length >= 2) continue
          // refused (taken, or a Mac dead key: ⌥E / ⌥I / ⌥N / ⌥U) → counted, never claimed
          if (useKeymap.getState().assign(a.id, [...chords, `Alt+${plain}`]).issues.length) skipped++
          else added++
        }
      }, () => altKeysText(added, skipped))
    }}>Thêm phím phụ {ALT} + chữ</button>
    {confirm && <p role="status">
      {confirm === 'legacy05' ? 'Đổi các phím về kiểu bản 0.5? Phím bạn tự gán cho các lệnh đó sẽ bị thay. Lưu ý: C nay bấm lần nữa khi mọi cặp đã nối thì bỏ nối (bản 0.5 chỉ báo “đã nối sẵn”).' : 'Đưa mọi phím tắt về mặc định?'}{' '}
      <button className="btn" onClick={() => apply(confirm)}>{confirm === 'legacy05' ? 'Đổi' : 'Khôi phục'}</button>{' '}
      <button className="btn" onClick={() => setConfirm(null)}>Huỷ</button>
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
  return <div className="dg-field" role="group" aria-label={label} data-key-row={id}>
    <div className="label">{label} {premiere && <span className="badge" title={`Giống Premiere: ${action.premiere?.name}`}>Premiere</span>}</div>
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
        {/* The focus moves here, so the keyboard reaches the choice (the recorder is paused). */}
        <button className="btn" autoFocus onClick={() => assignKeys(capture, capture.chords!, true)}>Thay thế</button>{' '}
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
