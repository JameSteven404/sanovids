// Draws the one open right-click menu (useContextMenu) in a portal on <body>: role="menu", roving focus, type-ahead,
// one submenu level, every other key swallowed while it is open, closes on Esc / Tab / a click or wheel outside / the
// window losing focus / a dialog opening / undo-redo. Mounted once at the App root (outside the region boundaries) and
// used by the canvas and the library alike.
import {
  ArrowRight,
  Check,
  ChevronRight,
  Clapperboard,
  Copy,
  Download,
  Eye,
  EyeOff,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  ImagePlus,
  KeyRound,
  Link2,
  Maximize,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Star,
  Trash2,
  Unlink,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { isTypingChord, useKeymap } from '../../lib/keymapPrefs'
import { onHistoryJump } from '../../store/project'
import { useUI } from '../../store/ui'
import { Keys } from '../common/Keys'
import { closeContextMenu, useContextMenu, type OpenMenu } from './contextMenuStore'
import {
  edgeIndex,
  firstIndex,
  HOVER_INTENT_MS,
  isItem,
  menuKeyAction,
  nextIndex,
  placeAtAnchor,
  placeMenu,
  placeSubmenu,
  TYPEAHEAD_MS,
  typeAhead,
  type MenuEntry,
  type MenuIcon,
  type MenuItem,
  type Placement,
} from './menuModel'
import './contextmenu.css'

const ICONS: Record<MenuIcon, LucideIcon> = {
  play: Play,
  edit: Pencil,
  plus: Plus,
  copy: Copy,
  film: Film,
  unlink: Unlink,
  link: Link2,
  trash: Trash2,
  eye: Eye,
  eyeOff: EyeOff,
  star: Star,
  download: Download,
  folder: Folder,
  folderPlus: FolderPlus,
  folderOpen: FolderOpen,
  folderSearch: FolderSearch,
  key: KeyRound,
  rerun: RotateCcw,
  x: X,
  image: ImagePlus,
  fit: Maximize,
  goto: ArrowRight,
  scene: Clapperboard,
}

/** A touch's own click lands right after the long press that opened the menu: ignored for this long. */
const TOUCH_CLICK_GUARD_MS = 400

/** Chords of a keymap action, read once (Codex may rename actions: an unknown id simply draws nothing). */
function chordsOf(item: MenuItem): readonly string[] {
  if (item.fixedKey) return [item.fixedKey]
  if (!item.action) return []
  const byAction = useKeymap.getState().resolved.byAction as Record<string, readonly string[] | undefined>
  return (byAction[item.action] ?? []).slice(0, 1)
}
function ariaKeysOf(item: MenuItem): string | undefined {
  if (!item.action) return undefined
  const aria = useKeymap.getState().resolved.aria as Record<string, string | undefined>
  return aria[item.action] || undefined
}

export function ContextMenuHost() {
  const open = useContextMenu((s) => s.open)
  useEffect(() => {
    if (!open) return
    const outside = (t: EventTarget | null) => !(t instanceof Element && t.closest('.cm-menu'))
    const onDown = (e: PointerEvent) => {
      if (outside(e.target)) closeContextMenu(false)
    }
    const onWheel = (e: WheelEvent) => {
      if (outside(e.target)) closeContextMenu(false)
    }
    const onGone = () => closeContextMenu(false)
    const onHidden = () => {
      if (document.hidden) closeContextMenu(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })
    window.addEventListener('blur', onGone)
    window.addEventListener('resize', onGone)
    document.addEventListener('visibilitychange', onHidden)
    // A dialog opening (or the view changing) takes the keys: the menu goes.
    const offUI = useUI.subscribe((s, prev) => {
      if ((s.dialog !== prev.dialog && s.dialog.kind !== 'none') || s.view !== prev.view) closeContextMenu(false)
    })
    const offHistory = onHistoryJump(onGone)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('wheel', onWheel, { capture: true })
      window.removeEventListener('blur', onGone)
      window.removeEventListener('resize', onGone)
      document.removeEventListener('visibilitychange', onHidden)
      offUI()
      offHistory()
    }
  }, [open])
  if (!open || typeof document === 'undefined') return null
  return createPortal(<MenuRoot key={open.seq} menu={open} />, document.body)
}

interface SubState {
  /** Index of the row (in the root menu) whose submenu is open. */
  index: number
  /** Active row inside the submenu (-1: none yet, focus still on the parent row). */
  active: number
}

function MenuRoot({ menu }: { menu: OpenMenu }) {
  const entries = menu.spec.entries
  const [active, setActive] = useState(() => firstIndex(entries))
  const [sub, setSub] = useState<SubState | null>(null)
  const [pos, setPos] = useState<Placement | null>(null)
  const [subPos, setSubPos] = useState<Placement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: '', at: 0 })
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const subItem = sub ? entries[sub.index] : undefined
  const subEntries: MenuEntry[] = isItem(subItem) && subItem.submenu ? subItem.submenu : []
  const inSub = !!sub && sub.active >= 0

  const clearHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
  }
  useEffect(() => clearHover, [])

  // Placement: measured before paint (rendered hidden at 0,0 first).
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const size = { w: el.offsetWidth, h: el.offsetHeight }
    const viewport = { w: window.innerWidth, h: window.innerHeight }
    const headerH = (el.querySelector('.cm-title') as HTMLElement | null)?.offsetHeight ?? 0
    setPos(menu.anchor ? placeAtAnchor(menu.anchor, size, viewport) : placeMenu(menu.at ?? { x: viewport.w / 2, y: viewport.h / 3 }, size, viewport, headerH))
  }, [menu])
  useLayoutEffect(() => {
    setSubPos(null)
  }, [sub?.index])
  useLayoutEffect(() => {
    if (!sub || subPos) return
    const el = subRef.current
    const row = rootRef.current?.querySelector<HTMLElement>(`[data-idx="${sub.index}"]`)
    if (!el || !row) return
    const r = row.getBoundingClientRect()
    setSubPos(placeSubmenu({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight }))
  }, [sub, subPos])

  // Roving focus: the active row has DOM focus (screen readers follow it).
  useEffect(() => {
    if (!pos) return
    const host = inSub ? subRef.current : rootRef.current
    const idx = inSub ? sub!.active : active
    const el = host?.querySelector<HTMLElement>(`[data-idx="${idx}"]`)
    if (el) el.focus({ preventScroll: false })
    else rootRef.current?.focus({ preventScroll: true })
  }, [pos, subPos, active, sub, inSub])

  // The canvas highlights the wire of the hovered / focused row.
  const highlighted = inSub ? subEntries[sub!.active] : entries[active]
  useEffect(() => {
    menu.onHighlight?.(isItem(highlighted) ? highlighted : null)
  }, [menu, highlighted])

  const choose = (item: MenuItem, index: number, fromSub: boolean) => {
    if (item.disabled) return
    if (!fromSub && item.submenu) {
      setSub({ index, active: firstIndex(item.submenu) })
      return
    }
    // Close → give focus back → run: a dialog the command opens remembers the right element to return to, and
    // commands that need a user gesture (folder pickers, file input) still run inside this click / key event.
    closeContextMenu(true)
    item.run?.()
  }

  // Keys: window capture, so nothing behind the menu (useShortcuts, React Flow) ever sees them.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keyHandler.current = (e: KeyboardEvent) => {
    const list = inSub ? subEntries : entries
    const idx = inSub ? sub!.active : active
    const item = list[idx]
    const onParent = !inSub && isItem(item) && !!item.submenu && !item.disabled
    const act = menuKeyAction(e, { typingChord: isTypingChord(e), inSubmenu: inSub, onParent })
    if (act === 'passClose') {
      closeContextMenu(false)
      return
    }
    e.preventDefault()
    e.stopImmediatePropagation()
    const move = (to: number) => {
      if (to < 0) return
      if (inSub) setSub({ index: sub!.index, active: to })
      else {
        setActive(to)
        if (sub) setSub(null)
      }
    }
    switch (act) {
      case 'next':
        move(nextIndex(list, idx, 1))
        break
      case 'prev':
        move(nextIndex(list, idx, -1))
        break
      case 'first':
        move(edgeIndex(list, 'first'))
        break
      case 'last':
        move(edgeIndex(list, 'last'))
        break
      case 'activate':
        if (isItem(item)) choose(item, idx, inSub)
        break
      case 'openSub':
        if (isItem(item) && item.submenu) setSub({ index: idx, active: firstIndex(item.submenu) })
        break
      case 'closeSub':
        setSub(null)
        break
      case 'close':
      case 'tab':
        closeContextMenu(true)
        break
      case 'type': {
        const now = performance.now()
        const text = now - typed.current.at < TYPEAHEAD_MS ? typed.current.text + e.key : e.key
        typed.current = { text, at: now }
        move(typeAhead(list, idx, text))
        break
      }
      default:
        break
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const onClickItem = (item: MenuItem, index: number, fromSub: boolean) => {
    if (menu.origin === 'touch' && performance.now() - menu.openedAt < TOUCH_CLICK_GUARD_MS) return
    choose(item, index, fromSub)
  }
  // Pointer: only a real move changes the active row (a menu opening under a resting pointer keeps its first item).
  const onRootMove = (item: MenuItem, index: number) => {
    if (active !== index || inSub) setActive(index)
    if (inSub) setSub(sub ? { index: sub.index, active: -1 } : null)
    clearHover()
    if (item.submenu && !item.disabled) {
      if (sub?.index === index) return
      hoverTimer.current = setTimeout(() => setSub({ index, active: -1 }), HOVER_INTENT_MS)
    } else if (sub) {
      hoverTimer.current = setTimeout(() => setSub(null), HOVER_INTENT_MS)
    }
  }
  const onSubMove = (index: number) => {
    clearHover()
    if (sub && sub.active !== index) setSub({ index: sub.index, active: index })
  }

  const style = (p: Placement | null): CSSProperties =>
    p ? { left: p.left, top: p.top, maxHeight: p.maxHeight } : { left: 0, top: 0, visibility: 'hidden' }

  return (
    <>
      <div
        ref={rootRef}
        className="cm-menu material"
        role="menu"
        aria-label={menu.spec.label}
        aria-orientation="vertical"
        tabIndex={-1}
        data-top-overlay=""
        data-origin={menu.origin}
        style={style(pos)}
        onContextMenu={(e) => e.preventDefault()}
      >
        {menu.spec.title && (
          <div className="cm-title" role="presentation" title={menu.spec.title}>
            {menu.spec.title}
          </div>
        )}
        <Rows
          entries={entries}
          active={inSub ? -1 : active}
          openIndex={sub?.index ?? -1}
          idPrefix={`cm${menu.seq}`}
          onClick={(item, i) => onClickItem(item, i, false)}
          onMove={onRootMove}
        />
      </div>
      {sub && subEntries.length > 0 && (
        <div
          ref={subRef}
          className="cm-menu cm-sub material"
          role="menu"
          aria-label={isItem(subItem) ? subItem.label : undefined}
          aria-orientation="vertical"
          tabIndex={-1}
          data-top-overlay=""
          data-origin={menu.origin}
          style={style(subPos)}
          onContextMenu={(e) => e.preventDefault()}
          onPointerEnter={clearHover}
        >
          <Rows
            entries={subEntries}
            active={sub.active}
            openIndex={-1}
            idPrefix={`cm${menu.seq}s`}
            onClick={(item, i) => onClickItem(item, i, true)}
            onMove={(_item, i) => onSubMove(i)}
          />
        </div>
      )}
    </>
  )
}

function Rows({
  entries,
  active,
  openIndex,
  idPrefix,
  onClick,
  onMove,
}: {
  entries: MenuEntry[]
  active: number
  openIndex: number
  idPrefix: string
  onClick: (item: MenuItem, index: number) => void
  onMove: (item: MenuItem, index: number) => void
}) {
  return (
    <>
      {entries.map((e, i) => {
        if (e.type === 'separator') return <div key={`sep${i}`} role="separator" className="cm-sep" />
        if (e.type === 'label') {
          return (
            <div key={`lbl${i}`} role="presentation" className="cm-note">
              {e.text}
            </div>
          )
        }
        const Icon = e.danger ? Trash2 : e.checked !== undefined && !e.icon ? Check : e.icon ? ICONS[e.icon] : null
        const chords = chordsOf(e)
        const reasonId = e.disabled ? `${idPrefix}-r${i}` : undefined
        const cls = [
          'cm-item',
          i === active && 'is-active',
          e.danger && 'is-danger',
          e.disabled && 'is-disabled',
          e.checked && 'is-checked',
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <button
            key={e.id}
            type="button"
            className={cls}
            role={e.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={e.checked !== undefined ? e.checked : undefined}
            aria-disabled={e.disabled ? true : undefined}
            aria-describedby={reasonId}
            aria-haspopup={e.submenu ? 'menu' : undefined}
            aria-expanded={e.submenu ? openIndex === i : undefined}
            aria-keyshortcuts={ariaKeysOf(e)}
            data-idx={i}
            data-item-id={e.id}
            tabIndex={-1}
            onPointerMove={() => onMove(e, i)}
            onClick={() => onClick(e, i)}
          >
            <span className="cm-ico" aria-hidden="true">
              {Icon && <Icon size={14} strokeWidth={1.75} />}
            </span>
            <span className="cm-text">
              <span className="cm-label">{e.label}</span>
              {e.hint && <small className="cm-hint">{e.hint}</small>}
              {e.disabled && (
                <small className="cm-reason" id={reasonId}>
                  {e.disabled}
                </small>
              )}
            </span>
            {chords.length > 0 && (
              <span className="cm-side">
                <Keys keys={chords} />
              </span>
            )}
            {e.submenu && <ChevronRight className="cm-chev" size={14} strokeWidth={1.75} aria-hidden="true" />}
          </button>
        )
      })}
    </>
  )
}
