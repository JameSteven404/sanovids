// Key event -> chord string ("Ctrl+Shift+KeyS"). Its own module so core/keymap and core/transportKeys both use it
// without importing each other.
export interface KeyEventLike {
  key: string
  code: string
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
  isComposing?: boolean
  keyCode?: number
  repeat?: boolean
  altGraph?: boolean
  defaultPrevented?: boolean
}

const NAMED = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
])
const PUNCT = ['Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backquote', 'IntlBackslash']
export const PRINTABLE = new Set([
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  ...PUNCT,
])
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'OS', 'Hyper', 'Super', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock'])

export const isKeyId = (id: string) => NAMED.has(id) || PRINTABLE.has(id)

export function formatChord(c: { ctrl: boolean; alt: boolean; shift: boolean; id: string }): string {
  return `${c.ctrl ? 'Ctrl+' : ''}${c.alt ? 'Alt+' : ''}${c.shift ? 'Shift+' : ''}${c.id}`
}

export function parseChord(s: unknown): string | null {
  if (typeof s !== 'string' || s.length > 40) return null
  const parts = s.split('+')
  const id = parts.pop()!
  if (!isKeyId(id)) return null
  const mods = new Set<string>()
  for (const p of parts) {
    if (!['Ctrl', 'Alt', 'Shift'].includes(p) || mods.has(p)) return null
    mods.add(p)
  }
  return formatChord({ ctrl: mods.has('Ctrl'), alt: mods.has('Alt'), shift: mods.has('Shift'), id })
}

/** The chord of a key event, or null when it must never run a command. */
export function chordFromEvent(e: KeyEventLike, mac: boolean): string | null {
  if (e.isComposing || e.keyCode === 229) return null
  const k = e.key
  if (!k || k === 'Process' || k === 'Unidentified' || k === 'Dead' || MODIFIERS.has(k)) return null
  if (mac ? e.ctrlKey : e.metaKey) return null
  const ctrl = mac ? !!e.metaKey : !!e.ctrlKey
  const alt = !!e.altKey
  const shift = !!e.shiftKey
  if (e.altGraph && PRINTABLE.has(e.code)) return null
  // '?' opens the shortcuts on any layout, like today (it is Shift+/ only on US-style keyboards)
  if (k === '?' && !ctrl && !alt) return formatChord({ ctrl, alt, shift: true, id: 'Slash' })
  const named = k === ' ' ? 'Space' : k === 'Esc' ? 'Escape' : k === 'Del' ? 'Delete' : k
  let id: string
  if (NAMED.has(named)) id = named
  else if (/^Numpad[0-9]$/.test(e.code) && /^[0-9]$/.test(k) && !alt) id = `Digit${k}`
  else if (PRINTABLE.has(e.code)) {
    // A letter key that produced a non-Latin character without Ctrl/Alt: an input tool rewrote it.
    if (/^Key[A-Z]$/.test(e.code) && !ctrl && !alt && !/^[a-z]$/i.test(k)) return null
    id = e.code
  } else return null
  return formatChord({ ctrl, alt, shift, id })
}
