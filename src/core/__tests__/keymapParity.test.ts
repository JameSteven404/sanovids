// Parity of the proposed dispatcher with today's useShortcuts.ts (+ AssetDialog undo keys), with defaults.
import { expect, it } from 'vitest'
import { chordFromEvent, decideShortcut as decide, parseChord, type Ctx, type DialogKind, type KeyEventLike, type View } from '../keymap'

// Oracle: today's decision, transcribed from src/hooks/useShortcuts.ts (onKey) and sidebar/shared.ts:395-411 (no side
// effects). Since 0.6.0 there are no 1 / 2 / 3 keys (the canvas is the only view, core/shownViews), and Alt + ↑ / ↓
// are fixed scene-order keys handled before the dispatcher, outside the registry (FIXED_KEYS).
function legacy(e: KeyEventLike, ctx: Ctx, mac: boolean): string | null {
  if (e.isComposing) return null
  const mod = !!(e.ctrlKey || e.metaKey)
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const dialogOpen = ctx.dialog !== 'none'
  if (mod && key === 's') return 'project.save'
  if (mod && key === 'Enter') return dialogOpen ? null : 'scene.run'
  if (key === 'Escape') return 'escape'
  if (ctx.dialog === 'asset' && !ctx.typing && mod && !e.altKey) {
    if (key === 'z' && !e.shiftKey) return 'history.undo'
    if ((key === 'z' && e.shiftKey) || key === 'y') return 'history.redo'
  }
  if (ctx.typing || dialogOpen) return null
  if (mod) {
    if (key === 'z' && !e.shiftKey) return 'history.undo'
    if ((key === 'z' && e.shiftKey) || key === 'y') return 'history.redo'
    if (key === 'd') return 'selection.duplicate'
    if (key === 'a') return ctx.view === 'canvas' ? 'selection.selectAll' : null
    if (key === 'k') return 'library.search'
    return null
  }
  if (e.altKey) return null
  if (key === 'Delete') return e.repeat ? null : 'selection.delete'
  if (key === 'Backspace' && mac) return e.repeat ? null : 'mac-backspace'
  if (key === '?') return 'help.shortcuts'
  if (e.repeat) return null
  const single: Record<string, string> = {
    n: 'scene.next', c: 'selection.connect', f: 'canvas.fit', e: 'canvas.cycleEdges', h: 'canvas.hand', v: 'canvas.select', m: 'canvas.minimap',
  }
  return single[key] ?? null
}

// US layout physical keys → key values (unshifted / shifted)
const US: [code: string, plain: string, shifted: string][] = [
  ...Array.from({ length: 26 }, (_, i) => {
    const c = String.fromCharCode(97 + i)
    return [`Key${c.toUpperCase()}`, c, c.toUpperCase()] as [string, string, string]
  }),
  ['Digit1', '1', '!'], ['Digit2', '2', '@'], ['Digit3', '3', '#'], ['Digit4', '4', '$'], ['Digit0', '0', ')'],
  ['Slash', '/', '?'], ['Comma', ',', '<'], ['Minus', '-', '_'],
  ['Enter', 'Enter', 'Enter'], ['Delete', 'Delete', 'Delete'], ['Backspace', 'Backspace', 'Backspace'], ['Escape', 'Escape', 'Escape'],
  ['Space', ' ', ' '], ['ArrowLeft', 'ArrowLeft', 'ArrowLeft'], ['F2', 'F2', 'F2'], ['Tab', 'Tab', 'Tab'],
]

type Diff = { ev: KeyEventLike; ctx: Ctx; mac: boolean; legacy: string | null; next: string | null }

it('defaults behave like today, except the intended differences', () => {
  const diffs: Diff[] = []
  let cases = 0
  const dialogs: DialogKind[] = ['none', 'settings', 'asset', 'import', 'take', 'shortcuts']
  // Only the canvas is ever shown (ui.setView refuses the hidden views, a stored one falls back to the canvas).
  const views: View[] = ['canvas']
  for (const mac of [false, true])
    for (const [code, plain, shifted] of US)
      for (let m = 0; m < 16; m++) {
        const ctrlKey = !!(m & 1), altKey = !!(m & 2), shiftKey = !!(m & 4), metaKey = !!(m & 8)
        for (const repeat of [false, true])
          for (const typing of [false, true])
            for (const dialog of dialogs)
              for (const view of views) {
                cases++
                const ev: KeyEventLike = { code, key: shiftKey ? shifted : plain, ctrlKey, altKey, shiftKey, metaKey, repeat }
                const ctx = { typing, dialog, view }
                const l = legacy(ev, ctx, mac)
                const n = decide(ev, ctx, mac).action
                if (l !== n) diffs.push({ ev, ctx, mac, legacy: l, next: n })
              }
      }
  // Classify every difference: each must be one of the intended changes.
  const unexplained = diffs.filter(({ ev, ctx, mac, next, legacy: l }) => {
    const winKey = !mac && ev.metaKey // Windows key: belongs to Windows now
    const macBoth = mac && ev.metaKey && ev.ctrlKey // ⌘+Ctrl together — today both are "mod"
    const macControl = mac && ev.ctrlKey // physical Control is never Mod on Mac
    const macForceQuit = mac && ev.metaKey && ev.altKey && !ev.ctrlKey && !ev.shiftKey && ev.key === 'Escape'
    const macCommandDelete = mac && ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && ev.key === 'Backspace' && !ev.repeat && !ctx.typing && ctx.dialog === 'none'
    if (macCommandDelete && next === 'selection.delete' && l === null) return false
    const extraShift = ev.shiftKey && l !== 'history.redo' && l !== 'help.shortcuts' // exact modifiers: Shift no longer ignored
    const extraAlt = ev.altKey && (ev.ctrlKey || ev.metaKey) // Ctrl+Alt (AltGr) no longer = Ctrl
    const ctrlShiftY = ev.shiftKey && l === 'history.redo' && ev.code === 'KeyY'
    return !(winKey || macBoth || macControl || macForceQuit || extraShift || extraAlt || ctrlShiftY) || next !== null
  })
  expect(cases).toBe(32256)
  expect(unexplained).toEqual([])
})

it('Vietnamese input and layouts', () => {
  const ctx: Ctx = { typing: false, dialog: 'none', view: 'canvas' }
  // Unikey / EVKey inject the rewritten letter as a VK_PACKET (assumed code ''): never a command
  expect(decide({ key: 'ê', code: '' }, ctx, false).action).toBe(null)
  // …and even if Chromium reported the letter key's code
  expect(decide({ key: 'ê', code: 'KeyE' }, ctx, false).action).toBe(null)
  // Microsoft Vietnamese Telex (TSF composition)
  expect(decide({ key: 'Process', code: 'KeyE', keyCode: 229 }, ctx, false).action).toBe(null)
  expect(decide({ key: 'e', code: 'KeyE', isComposing: true }, ctx, false).action).toBe(null)
  // Windows' built-in Vietnamese layout: the digit row types ă â ê… — read by its key code; no digit has a command
  // since the 1 / 2 / 3 view keys went away
  expect(chordFromEvent({ key: 'ă', code: 'Digit1' }, false)).toBe('Digit1')
  expect(decide({ key: 'ă', code: 'Digit1' }, ctx, false).action).toBe(null)
  // Caps Lock, numpad (NumLock on / off)
  expect(decide({ key: 'N', code: 'KeyN' }, ctx, false).action).toBe('scene.next')
  expect(chordFromEvent({ key: '2', code: 'Numpad2' }, false)).toBe('Digit2')
  expect(decide({ key: '2', code: 'Numpad2' }, ctx, false).action).toBe(null)
  expect(decide({ key: 'Delete', code: 'NumpadDecimal' }, ctx, false).action).toBe('selection.delete')
  expect(decide({ key: 'Enter', code: 'NumpadEnter', ctrlKey: true }, ctx, false).action).toBe('scene.run')
  // Alt + numpad digits type characters (Alt codes): never a chord with a digit
  expect(chordFromEvent({ key: '0', code: 'Numpad0', altKey: true }, false)).toBe(null)
  // '?' on another layout still opens the shortcuts
  expect(decide({ key: '?', code: 'KeyM', shiftKey: true }, ctx, false).action).toBe('help.shortcuts')
  // Backspace never deletes on Windows
  expect(decide({ key: 'Backspace', code: 'Backspace' }, ctx, false).action).toBe(null)
  // Ctrl chords work on non-Latin layouts too (key 'ы' on the S key)
  expect(decide({ key: 'ы', code: 'KeyS', ctrlKey: true }, ctx, false).action).toBe('project.save')
  // AltGr typing never fires Ctrl+Alt chords
  expect(chordFromEvent({ key: 'đ', code: 'Digit0', ctrlKey: true, altKey: true, altGraph: true }, false)).toBe(null)
})

it('chord strings', () => {
  expect(parseChord('Ctrl+Shift+KeyZ')).toBe('Ctrl+Shift+KeyZ')
  expect(parseChord('Shift+Ctrl+KeyZ')).toBe('Ctrl+Shift+KeyZ')
  expect(parseChord('Ctrl+Ctrl+KeyZ')).toBe(null)
  expect(parseChord('Ctrl+Plus')).toBe(null)
  expect(parseChord('Meta+KeyZ')).toBe(null)
  expect(parseChord(42)).toBe(null)
})
