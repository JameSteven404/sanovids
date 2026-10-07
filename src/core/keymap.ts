// Pure shortcut engine, based on the Wave C prototype. Ctrl is the portable Mod token (Command on Mac).
export type DialogKind = string
/** ui.view. Only 'canvas' is ever shown (core/shownViews); the others remain for old stored prefs. */
export type View = 'canvas' | 'table' | 'storyboard'

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

export type ActionId =
  | 'project.save' | 'scene.run' | 'history.undo' | 'history.redo' | 'library.search' | 'help.shortcuts'
  | 'scene.next' | 'selection.duplicate' | 'selection.delete' | 'selection.selectAll' | 'selection.connect'
  | 'canvas.fit' | 'canvas.cycleEdges' | 'canvas.hand' | 'canvas.select' | 'canvas.minimap'
  | 'settings.search'

export interface KeyAction {
  id: ActionId
  label: string
  help: string
  group: 'keys' | 'keysScene' | 'keysCanvas'
  hint: string
  keywords: string
  defaults: string[]
  whileTyping?: boolean
  /** Also active while these dialogs are open ('all' = any dialog). */
  alsoInDialogs?: 'all' | DialogKind[]
  /** Only while this dialog is open (handled by the dialog itself). */
  onlyInDialog?: DialogKind
  repeat?: boolean
}

// The only default-chord table. A later preset change belongs here, not in dispatchers or components.
// No view.* commands (1 / 2 / 3): Bảng cảnh and Storyboard are hidden since 0.6.0; stored bindings of them are kept as
// foreign values (validateBindings) and do nothing. Scene order keys (Alt + ↑ / ↓) are FIXED_KEYS, not commands.
const ACTION_DEFAULTS: Omit<KeyAction, 'label' | 'help' | 'group' | 'hint' | 'keywords'>[] = [
  { id: 'project.save', defaults: ['Ctrl+KeyS'], whileTyping: true, alsoInDialogs: 'all' },
  { id: 'scene.run', defaults: ['Ctrl+Enter'], whileTyping: true },
  { id: 'history.undo', defaults: ['Ctrl+KeyZ'], repeat: true, alsoInDialogs: ['asset'] },
  { id: 'history.redo', defaults: ['Ctrl+Shift+KeyZ', 'Ctrl+KeyY'], repeat: true, alsoInDialogs: ['asset'] },
  { id: 'library.search', defaults: ['Ctrl+KeyK'] },
  { id: 'help.shortcuts', defaults: ['Shift+Slash'], repeat: true },
  { id: 'scene.next', defaults: ['KeyN'] },
  { id: 'selection.duplicate', defaults: ['Ctrl+KeyD'] },
  { id: 'selection.delete', defaults: ['Delete'] },
  { id: 'selection.selectAll', defaults: ['Ctrl+KeyA'] },
  { id: 'selection.connect', defaults: ['KeyC'] },
  { id: 'canvas.fit', defaults: ['KeyF'] },
  { id: 'canvas.cycleEdges', defaults: ['KeyE'] },
  { id: 'canvas.hand', defaults: ['KeyH'] },
  { id: 'canvas.select', defaults: ['KeyV'] },
  { id: 'canvas.minimap', defaults: ['KeyM'] },
  { id: 'settings.search', defaults: ['Ctrl+KeyF'], whileTyping: true, onlyInDialog: 'settings' },
]

const ACTION_TEXT: Record<ActionId, [label: string, help: string]> = {
  'project.save': ['Lưu ngay', 'Lưu dự án, kể cả khi đang gõ hoặc mở hộp thoại.'],
  'scene.run': ['Chạy các cảnh đang chọn', 'Tạo video cho các cảnh đang chọn.'],
  'history.undo': ['Hoàn tác', 'Hoàn tác thay đổi gần nhất.'],
  'history.redo': ['Làm lại', 'Làm lại thay đổi vừa hoàn tác.'],
  'library.search': ['Tìm trong thư viện', 'Mở thư viện và đưa con trỏ vào ô tìm kiếm.'],
  'help.shortcuts': ['Bảng phím tắt', 'Xem phím tắt và thao tác.'],
  'scene.next': ['Cảnh tiếp theo', 'Tạo cảnh bên dưới, giữ tham chiếu và cấu hình; tạo cảnh mới khi chưa chọn gì.'],
  'selection.duplicate': ['Nhân bản cảnh', 'Nhân bản các cảnh đang chọn.'],
  'selection.delete': ['Xoá lựa chọn', 'Xoá cảnh và video, ẩn thẻ hoặc cắt dây đang chọn.'],
  'selection.selectAll': ['Chọn tất cả cảnh', 'Chọn mọi cảnh trên canvas.'],
  'selection.connect': ['Nối lựa chọn', 'Nối nhân vật và video đang chọn vào các cảnh đang chọn.'],
  'canvas.fit': ['Vừa màn hình', 'Hiện vừa vùng chọn hoặc toàn bộ canvas.'],
  'canvas.cycleEdges': ['Đổi cách hiện dây', 'Ẩn → Đang chọn → Tất cả.'],
  'canvas.hand': ['Chế độ Tay', 'Kéo nền để di chuyển khung nhìn.'],
  'canvas.select': ['Chế độ Chọn', 'Kéo nền để chọn vùng.'],
  'canvas.minimap': ['Bản đồ nhỏ', 'Bật hoặc tắt bản đồ nhỏ.'],
  'settings.search': ['Tìm cài đặt', 'Tìm trong hộp Cài đặt đang mở.'],
}

export const KEY_ACTIONS: KeyAction[] = ACTION_DEFAULTS.map((a) => ({
  ...a, label: ACTION_TEXT[a.id][0], help: ACTION_TEXT[a.id][1],
  group: a.id.startsWith('canvas.') ? 'keysCanvas' : /^(scene|selection)\./.test(a.id) ? 'keysScene' : 'keys',
  hint: a.whileTyping ? 'Dùng được cả khi đang gõ.' : 'Không chạy khi đang gõ trong ô nhập.',
  keywords: `phím tắt bàn phím shortcut hotkey gán đổi phím tổ hợp ${a.id}`,
}))
export const actionById = (id: string): KeyAction | undefined => KEY_ACTIONS.find((a) => a.id === id)

export interface FixedKey { keys: string[]; label: string; macOnly?: boolean }
export const FIXED_KEYS: FixedKey[] = [
  { keys: ['Escape'], label: 'Bỏ chọn · đóng hộp thoại · thu gọn khung sửa' },
  { keys: ['Tab', 'Shift+Tab'], label: 'Chuyển tới điều khiển tiếp theo / trước' },
  { keys: ['Enter', 'Space'], label: 'Kích hoạt nút; Enter mở khung sửa cảnh hoặc xem take' },
  { keys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'], label: 'Di chuyển giữa các thẻ' },
  // Scene order (sceneOrderActions): fixed, because refusalFor keeps Alt + arrows away from every command.
  { keys: ['Alt+ArrowUp', 'Alt+ArrowDown'], label: 'Thứ tự cảnh: dời cảnh đang chọn lên trước / ra sau một chỗ' },
  { keys: ['Space', 'ArrowLeft', 'ArrowRight', 'Escape'], label: 'Phát liền: phát / tạm dừng · cảnh trước / sau · đóng' },
  { keys: ['ArrowUp', 'ArrowDown', 'Enter', 'Escape'], label: 'Popup @: chọn · chèn · đóng' },
  { keys: ['Space'], label: 'Giữ và kéo để di chuyển canvas' },
  { keys: ['Shift'], label: 'Giữ và kéo để chọn vùng' },
  { keys: ['Ctrl', 'Shift'], label: 'Giữ và bấm để chọn thêm' },
  { keys: ['Backspace', 'Ctrl+Backspace'], label: 'Xoá trên Mac; ⌫ chờ 90 ms và huỷ nếu có phím khác theo sau', macOnly: true },
]

const NAMED = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
])
const PUNCT = ['Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backquote', 'IntlBackslash']
const PRINTABLE = new Set([
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

export interface Ctx {
  typing: boolean
  dialog: DialogKind
  view: View
}

export function activeIn(a: KeyAction, ctx: Ctx): boolean {
  if (a.onlyInDialog) {
    if (ctx.dialog !== a.onlyInDialog) return false
  } else if (ctx.dialog !== 'none') {
    if (!(a.alsoInDialogs === 'all' || a.alsoInDialogs?.includes(ctx.dialog))) return false
  }
  if (ctx.typing && !a.whileTyping) return false
  return true
}

export type Bindings = Record<ActionId, string[]>
export const defaultBindings = (): Bindings => Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, [...a.defaults]])) as Bindings

const KEY_NAMES: Record<string, string> = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', IntlBackslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc',
  PageUp: 'PgUp', PageDown: 'PgDn',
}
const MAC_NAMES: Record<string, string> = { Ctrl: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↩', Escape: 'esc', Backspace: '⌫', Delete: '⌦', Tab: '⇥' }

/** Parts are for rendering key caps; never split a formatted Mac label on '+'. Control is display-only. */
export function chordParts(chord: string, mac = false): string[] {
  if (chord === 'Shift+Slash') return ['?']
  const parts = chord.split('+')
  const id = parts.pop()!
  const mods = mac ? ['Control', 'Alt', 'Shift', 'Ctrl'].filter((m) => parts.includes(m)) : parts
  return [...mods, id].map((p) => (mac && MAC_NAMES[p]) || KEY_NAMES[p] || p.replace(/^(Key|Digit)/, ''))
}
export const chordLabel = (chord: string, mac = false): string => chordParts(chord, mac).join(mac ? '' : '+')
export function chordAria(chord: string, mac = false): string {
  return chord.split('+').map((p) => p === 'Ctrl' ? (mac ? 'Meta' : 'Control') : KEY_NAMES[p] && !p.startsWith('Arrow') && !['Escape', 'PageUp', 'PageDown'].includes(p) ? KEY_NAMES[p] : p.replace(/^(Key|Digit)/, '')).join('+')
}

const MAC_SYSTEM: Record<string, string> = {
  'Ctrl+KeyQ': 'Thoát SanoVids', 'Ctrl+KeyW': 'Đóng cửa sổ', 'Ctrl+KeyH': 'Ẩn SanoVids',
  'Ctrl+Alt+KeyH': 'Ẩn các ứng dụng khác', 'Ctrl+KeyM': 'Thu nhỏ cửa sổ', 'Ctrl+Alt+KeyM': 'Thu nhỏ mọi cửa sổ',
  'Ctrl+Backquote': 'Chuyển cửa sổ', 'Ctrl+Shift+Backquote': 'Chuyển cửa sổ',
  'Ctrl+Tab': 'Chuyển ứng dụng', 'Ctrl+Shift+Tab': 'Chuyển ứng dụng', 'Ctrl+Space': 'Tìm kiếm Spotlight',
  'Ctrl+Alt+Space': 'Tìm kiếm Finder', 'Ctrl+Alt+KeyD': 'Ẩn hoặc hiện Dock',
  'Ctrl+Alt+KeyI': 'Thông tin mục', 'Ctrl+Alt+Escape': 'Buộc thoát ứng dụng',
  'Ctrl+Shift+Digit3': 'Chụp màn hình', 'Ctrl+Shift+Digit4': 'Chụp vùng màn hình', 'Ctrl+Shift+Digit5': 'Công cụ chụp màn hình',
}
const navigation = /^(Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/

export function refusalFor(chord: string, action: KeyAction | ActionId, mac = false): string | null {
  const c = parseChord(chord)
  if (!c) return 'Phím này không được hỗ trợ (phím Windows / Control trên Mac không dùng làm phím tắt).'
  const a = typeof action === 'string' ? actionById(action) : action
  if (!a) return 'Lệnh không được hỗ trợ.'
  const id = c.split('+').at(-1)!
  const ctrl = c.includes('Ctrl+'), alt = c.includes('Alt+')
  if (mac && MAC_SYSTEM[c]) return `${chordLabel(c, true)} là phím của macOS (${MAC_SYSTEM[c]}) — chọn phím khác.`
  if (id === 'Backspace') return mac ? '⌫ và ⌘⌫ là phím xoá cố định trên Mac — không thể gán lại.' : 'Bộ gõ tiếng Việt (Unikey, EVKey…) tự gửi Backspace khi bỏ dấu, nên Backspace không dùng làm phím tắt được.'
  if (['Escape', 'Tab'].includes(id)) return 'Esc và Tab dành cho đóng và chuyển điều khiển — chọn phím khác.'
  if ((!ctrl && !alt && (['Enter', 'Space'].includes(id) || navigation.test(id))) || (alt && !ctrl && id.startsWith('Arrow'))) return 'Phím này dành cho điều khiển và di chuyển — chọn phím khác.'
  if (['Alt+F4', 'Alt+Space'].includes(c)) return 'Phím này dành cho hệ điều hành — chọn phím khác.'
  if (id === 'F12' || c === 'Ctrl+Shift+KeyI') return 'Phím này dành cho công cụ phát triển — chọn phím khác.'
  if (ctrl && !alt && /^Key[CVX]$/.test(id)) return 'Phím này dành cho sao chép, dán và cắt — chọn phím khác.'
  if (mac && alt && !ctrl && /^(Key[EINU]|Backquote)$/.test(id)) return `${chordLabel(c, true)} là phím dấu trên bàn phím Mac (gõ ´ ˜ ˆ ¨ \`) nên không đọc được — chọn chữ khác.`
  if (a.whileTyping) {
    if (!ctrl && !alt && !/^F([1-9]|10|11)$/.test(id)) return 'Lệnh dùng khi đang gõ cần Ctrl hoặc Alt, hoặc F1–F11.'
    if (ctrl && !alt && (/^Key[AZY]$/.test(id) || ['Backspace', 'Delete', 'Insert'].includes(id) || navigation.test(id))) return 'Phím này dành cho sửa văn bản trong ô nhập — chọn phím khác.'
    if (alt && /^Digit/.test(id)) return 'Alt + số dành cho nhập ký tự — chọn phím khác.'
    if (mac && alt && !ctrl && PRINTABLE.has(id)) return '⌥ + phím gõ ra ký tự đặc biệt trong ô nhập — dùng ⌘ + phím.'
  }
  return null
}

export function warningsFor(chord: string, mac = false, web = false): string[] {
  const c = parseChord(chord)
  if (!c) return []
  const warnings: string[] = []
  const id = c.split('+').at(-1)!
  if (/^Key[A-Z]$/.test(c)) warnings.push(mac ? 'EVKey / OpenKey có thể nuốt phím này khi bấm ngay sau một chữ khác.' : 'Bộ gõ tiếng Việt có thể nuốt phím này khi bấm ngay sau một chữ khác (E rồi F thành “è”).')
  if (c.startsWith('Ctrl+Alt+') && PRINTABLE.has(id) && !mac) warnings.push('Ctrl+Alt có thể là AltGr để gõ ký tự trên bàn phím này.')
  if (c === 'Alt+KeyZ' || c === 'Ctrl+Space') warnings.push('Phím này có thể bật / tắt bộ gõ tiếng Việt.')
  if (mac && /^F([1-9]|1[0-2])$/.test(id)) warnings.push('Trên bàn phím Mac, F1–F12 mặc định là phím độ sáng / âm lượng: phải giữ fn.')
  if (web && (/^Ctrl\+(Shift\+)?(Key[DLNPRSTW]|Digit[0-9]|Equal|Minus)$/.test(c) || ['F1', 'F3', 'F5', 'F6', 'F11', 'Alt+ArrowLeft', 'Alt+ArrowRight'].includes(c))) warnings.push('Trình duyệt cũng dùng phím này và có thể xử lý trước SanoVids.')
  return warnings
}

export function contextsOverlap(a: KeyAction, b: KeyAction): boolean {
  if ((!a.onlyInDialog && a.alsoInDialogs === 'all') || (!b.onlyInDialog && b.alsoInDialogs === 'all')) return true
  const contexts = (x: KeyAction) => x.onlyInDialog ? [x.onlyInDialog] : ['app', ...(x.alsoInDialogs ?? [])]
  return contexts(a).some((c) => contexts(b).includes(c))
}

export type BindingOverrides = Partial<Record<ActionId, readonly string[]>>
export const RENAMED_ACTIONS: Readonly<Record<string, ActionId>> = {}
export const MAX_KEYMAP_BYTES = 32768
export interface BindingIssue { path: string; reason: 'invalid' | 'refused' | 'mac-system' | 'limit' | 'conflict'; message: string; chord?: string; with?: ActionId }
export interface DroppedBinding { action: ActionId; chord: string; by: ActionId }
export interface ValidatedBindings {
  bindings: BindingOverrides
  foreign: Record<string, unknown>
  rejected: string[]
  issues: BindingIssue[]
}

/** Counts changed known commands; foreign values are preserved but cannot affect this version. */
export function changedBindingsCount(overrides: unknown, mac = false): number {
  const { bindings } = validateBindings(overrides, mac)
  return KEY_ACTIONS.filter((a) => bindings[a.id] !== undefined && JSON.stringify(bindings[a.id]) !== JSON.stringify(a.defaults)).length
}

/** The same bounded trust boundary is used by capture, local prefs and settings import.
 * Invalid chords fall back to defaults if none survive; [] explicitly unassigns a command.
 * Conflicting overrides use registry order, independent of JSON property order.
 */
export function validateBindings(input: unknown, mac = false): ValidatedBindings {
  const bindings: BindingOverrides = {}, foreign: Record<string, unknown> = {}, issues: BindingIssue[] = []
  const issue = (path: string, reason: BindingIssue['reason'], message: string, chord?: string, withId?: ActionId) => issues.push({ path, reason, message, ...(chord ? { chord } : {}), ...(withId ? { with: withId } : {}) })
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('shape')
    if (new TextEncoder().encode(JSON.stringify(input)).length > MAX_KEYMAP_BYTES) throw new Error('size')
    const source: Record<string, unknown> = {}
    for (const [id, value] of Object.entries(input)) {
      if (['__proto__', 'constructor', 'prototype'].includes(id) || id.length > 100) { issue(`keys.${id}`, 'invalid', 'Mã lệnh không hợp lệ.'); continue }
      const renamed = Object.hasOwn(RENAMED_ACTIONS, id) ? RENAMED_ACTIONS[id] : id
      if (actionById(renamed)) {
        if (!(renamed in source) || id === renamed) source[renamed] = value
      } else foreign[id] = value
    }
    for (const a of KEY_ACTIONS) {
      if (!Object.hasOwn(source, a.id)) continue
      const raw = source[a.id], path = `keys.${a.id}`
      if (!Array.isArray(raw) || raw.length > 2) { issue(path, 'limit', 'Mỗi lệnh có tối đa 2 tổ hợp phím.'); continue }
      const valid: string[] = []
      for (const value of raw) {
        const c = parseChord(value)
        if (!c) { issue(path, 'invalid', 'Tổ hợp phím không hợp lệ.'); continue }
        const refusal = refusalFor(c, a, mac)
        if (refusal) {
          const system = mac && MAC_SYSTEM[c]
          issue(path, system ? 'mac-system' : 'refused', system ? `${chordLabel(c, true)} trùng phím của macOS (${system}) nên không dùng trên Mac — lệnh “${a.label}” về phím mặc định.` : refusal, c)
          continue
        }
        if (valid.includes(c)) { issue(path, 'conflict', 'Tổ hợp này đã có trong lệnh.', c, a.id); continue }
        valid.push(c)
      }
      if (raw.length && !valid.length) continue
      bindings[a.id] = valid.filter((c) => {
        const previous = KEY_ACTIONS.find((other) => other.id !== a.id && bindings[other.id]?.includes(c) && contextsOverlap(a, other))
        if (!previous) return true
        issue(path, 'conflict', `${chordLabel(c, mac)} đang dùng cho “${previous.label}”.`, c, previous.id)
        return false
      })
    }
  } catch {
    issue('keys', 'invalid', 'Dữ liệu phím tắt không hợp lệ hoặc quá lớn.')
    return { bindings: {}, foreign: {}, rejected: ['keys'], issues }
  }
  return { bindings, foreign, rejected: [...new Set(issues.map((i) => i.path))], issues }
}

export interface ResolvedKeymap {
  byAction: Bindings
  lookup: Record<string, ActionId[]>
  labels: Record<ActionId, string>
  allLabels: Record<ActionId, string>
  aria: Record<ActionId, string>
  dropped: DroppedBinding[]
}

export function resolveKeymap(overrides: unknown = {}, mac = false): ResolvedKeymap {
  const { bindings } = validateBindings(overrides, mac)
  const byAction = defaultBindings(), dropped: DroppedBinding[] = []
  for (const a of KEY_ACTIONS) {
    const own = bindings[a.id]
    if (own !== undefined) { byAction[a.id] = [...own]; continue }
    byAction[a.id] = a.defaults.filter((c) => {
      const winner = KEY_ACTIONS.find((other) => bindings[other.id]?.includes(c) && contextsOverlap(a, other))
      if (!winner) return true
      dropped.push({ action: a.id, chord: c, by: winner.id })
      return false
    })
  }
  const lookup: Record<string, ActionId[]> = {}
  for (const a of KEY_ACTIONS) for (const c of byAction[a.id]) (lookup[c] ??= []).push(a.id)
  const mapped = (f: (chords: string[]) => string) => Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, f(byAction[a.id])])) as Record<ActionId, string>
  return {
    byAction, lookup, dropped,
    labels: mapped((cs) => cs[0] ? chordLabel(cs[0], mac) : ''),
    allLabels: mapped((cs) => cs.map((c) => chordLabel(c, mac)).join(' / ')),
    aria: mapped((cs) => cs.map((c) => chordAria(c, mac)).join(' ')),
  }
}

const WIN_DEFAULTS = resolveKeymap()
const MAC_DEFAULTS = resolveKeymap({}, true)

/** Global dispatcher decision (useShortcuts). settings.search is the dialog's own handler: left out. */
export function decideShortcut(e: KeyEventLike, ctx: Ctx, mac: boolean, resolved: ResolvedKeymap = mac ? MAC_DEFAULTS : WIN_DEFAULTS): { action: ActionId | 'escape' | 'mac-backspace' | null; handled: boolean } {
  const b = resolved.byAction
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.key === 'Process') return { action: null, handled: false }
  const chord = chordFromEvent(e, mac)
  // In particular, Option+Command+Escape belongs to Force Quit, not our fixed Escape handler.
  if (mac && chord && MAC_SYSTEM[chord]) return { action: null, handled: false }
  if (e.key === 'Escape') return { action: 'escape', handled: true }
  if (!chord) return { action: null, handled: false }
  for (const a of KEY_ACTIONS) {
    if (a.onlyInDialog || !activeIn(a, ctx)) continue
    if (!b[a.id].includes(chord)) continue
    // selectAll: the global handler acts on the canvas only (the hidden views had their own handlers)
    if (a.id === 'selection.selectAll' && ctx.view !== 'canvas') return { action: null, handled: false }
    // Key repeat: like today, chords with Ctrl / Alt repeat (undo held = many steps), single keys do not;
    // the delete command never repeats.
    if (e.repeat && (a.id === 'selection.delete' || (!/^(Ctrl|Alt)\+/.test(chord) && !a.repeat))) return { action: null, handled: a.id === 'selection.delete' }
    return { action: a.id, handled: true }
  }
  if (mac && (chord === 'Backspace' || chord === 'Ctrl+Backspace') && !ctx.typing && ctx.dialog === 'none' && b['selection.delete'].length) {
    return { action: e.repeat ? null : chord === 'Backspace' ? 'mac-backspace' : 'selection.delete', handled: true }
  }
  return { action: null, handled: false }
}
