// The scene code chip at the top of the scene inspector, with the scene-order controls (the Storyboard that used to
// reorder scenes is hidden): ▲▼ move the scene one place (also Alt + ↑ / ↓ on the canvas), a click on the code opens
// "Dời S05 tới vị trí [n] / N". Moves go through sceneOrderActions (one undo step and one toast per burst).
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { sceneCode } from '../../core/compile'
import { moveSceneBy, moveSceneTo } from '../../sceneOrderActions'

export function SceneOrderControl({ sceneId, order, idx, count }: { sceneId: string; order: number; idx: number; count: number }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const codeRef = useRef<HTMLButtonElement>(null)
  const code = sceneCode(order)
  const first = idx <= 0
  const last = idx < 0 || idx >= count - 1
  const single = count < 2

  // Click outside closes the box (without moving).
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open])
  // Another scene selected while the box is open: it would move the wrong one.
  useEffect(() => setOpen(false), [sceneId])

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) codeRef.current?.focus()
  }

  return (
    <div className="in-code-group" ref={rootRef}>
      <button
        ref={codeRef}
        type="button"
        className="in-code in-code-btn mono"
        aria-disabled={single || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => !single && setOpen((o) => !o)}
        title={single ? 'Dự án chỉ có một cảnh' : `${code} · bấm để dời tới vị trí khác`}
      >
        {code}
      </button>
      <div className="in-code-steps">
        <button
          type="button"
          className="icon-btn in-code-step"
          disabled={first}
          onClick={() => moveSceneBy(sceneId, -1)}
          aria-label="Dời lên trước"
          title={first ? 'Đây là cảnh đầu' : `Dời lên trước (Alt+↑): ${code} thành ${sceneCode(idx)}`}
        >
          <ChevronUp size={11} />
        </button>
        <button
          type="button"
          className="icon-btn in-code-step"
          disabled={last}
          onClick={() => moveSceneBy(sceneId, 1)}
          aria-label="Dời ra sau"
          title={last ? 'Đây là cảnh cuối' : `Dời ra sau (Alt+↓): ${code} thành ${sceneCode(idx + 2)}`}
        >
          <ChevronDown size={11} />
        </button>
      </div>
      {open && <MoveToBox key={sceneId} sceneId={sceneId} code={code} place={idx + 1} count={count} onClose={close} />}
    </div>
  )
}

function MoveToBox({ sceneId, code, place, count, onClose }: { sceneId: string; code: string; place: number; count: number; onClose: (refocus: boolean) => void }) {
  const [draft, setDraft] = useState(String(place))
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const submit = () => {
    const n = Number.parseInt(draft, 10)
    if (Number.isFinite(n)) moveSceneTo(sceneId, n)
    onClose(true)
  }
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Escape') return
    // Stopped: the global Escape would also clear the selection (and the inspector with it).
    e.stopPropagation()
    e.preventDefault()
    onClose(true)
  }
  // Enter in the number field = "Dời" (on the buttons Enter keeps activating the focused one).
  const onInputKeyDown = (e: ReactKeyboardEvent) => {
    // Plain Enter only: Ctrl+Enter keeps running the selected scenes, as everywhere.
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    submit()
  }
  return (
    <div className="in-moveto" role="dialog" aria-label={`Dời ${code} tới vị trí`} onKeyDown={onKeyDown}>
      <label className="in-moveto-row">
        <span>Dời {code} tới vị trí</span>
        <input
          ref={inputRef}
          className="input in-moveto-input"
          type="number"
          inputMode="numeric"
          min={1}
          max={count}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onInputKeyDown}
        />
        <span className="in-moveto-of">/ {count}</span>
      </label>
      <div className="in-moveto-actions">
        <button type="button" className="btn btn-sm" onClick={() => onClose(true)}>
          Huỷ
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={submit}>
          Dời
        </button>
      </div>
      <p className="in-moveto-hint">Các cảnh khác đánh số lại. Ctrl+Z để hoàn tác.</p>
    </div>
  )
}
