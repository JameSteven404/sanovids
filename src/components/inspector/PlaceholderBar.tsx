// "Chữ đỏ chờ ảnh": the always-available place to deal with the red placeholders a removed reference picture left in a
// scene's prompt ("@image_?2(Lumi)", core/placeholders) — under the prompt editor of the inspector (and, from E2, of the
// scene card editor: variant 'node'). One chip per group; its menu fills it with a linked picture ("Gắn ảnh đã nối"),
// turns it into plain text ("Đổi thành chữ “Lumi”") or removes it ("Xoá chữ đỏ"); a labelled token whose label does
// not fit its slot ("@image_2(Lumi)" while 2 is Làng) offers "Giữ @image_2 = Làng", keeping the bracket text as plain
// text (one space before the "(", first: nothing deleted) or deleting it. Every command is an explicit click
// and ONE undo step (src/placeholderActions.ts); nothing is filled by itself.
import { platformText, shortcutText } from '../../lib/platformText'
import { ChevronDown, TriangleAlert } from 'lucide-react'
import { memo, useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { fillChoices, placeholderGroups, planFill, type PlaceholderGroup } from '../../core/placeholders'
import { MODELS } from '../../core/models'
import type { Asset } from '../../core/types'
import {
  allPlaceholdersToTextAction,
  fillPlaceholderAction,
  fillRefusalText,
  keepTokenAction,
  placeholderToTextAction,
  removePlaceholderAction,
  splitTokenAction,
} from '../../placeholderActions'
import { useProject } from '../../store/project'
import { AssetAvatar } from '../common/Media'
import { caretCoordinates } from './caret'
import {
  PICKER_CLOSED,
  pickerClosed,
  pickerFieldKey,
  pickerMenuKey,
  pickerNext,
  placeholderMenuIndex,
  placeholderPickerAt,
  popupPlacement,
  type PickerCause,
  type PickerState,
} from './mentions'
import { EMPTY_IDS, useDismiss, useSceneField } from './shared'

// The same menu is the picker of both prompt editors (usePlaceholderPicker: the inspector's PromptEditor and the scene
// node's field): it shows while the caret rests inside red text (a click or a caret move, never typing; the "@" list
// never opens there), Enter or Alt+↓ moves into it, Esc closes it, and it adds "Nối & gắn từ Thư viện".

/** One fill command of a red-text menu: the picture, whether a real token already names it, its section. */
export interface PlaceholderChoice {
  asset: Asset
  named: boolean
  section: string
}

export const LINKED_UNUSED = 'Ảnh đã nối, chưa nhắc'
export const LINKED_OTHER = 'Ảnh đã nối khác'
export const FROM_LIBRARY = 'Nối & gắn từ Thư viện'
/** Library rows the prompt picker lists at most (newest first, like the "@" list): the rest are a drag away. */
export const PICKER_LIBRARY_MAX = 8

/** Linked pictures that may fill red text: the ones no real token names yet (newest first), then the others. Names never decide. */
export function placeholderChoices(prompt: string, assets: readonly Asset[], refs: readonly string[]): PlaceholderChoice[] {
  return fillChoices(prompt, assets, refs).map((c) => ({ ...c, section: c.named ? LINKED_OTHER : LINKED_UNUSED }))
}

/**
 * The prompt picker's "Nối & gắn từ Thư viện": library pictures with images that the scene does not link yet, newest
 * first, at most `max` (a library of hundreds never builds hundreds of rows); `more` = how many were left out.
 */
export function libraryChoices(assets: readonly Asset[], refs: readonly string[], max = PICKER_LIBRARY_MAX): { choices: PlaceholderChoice[]; more: number } {
  const linked = new Set(refs)
  const choices: PlaceholderChoice[] = []
  let more = 0
  for (let i = assets.length - 1; i >= 0; i--) {
    const asset = assets[i]
    if (!asset.imageIds.length || linked.has(asset.id)) continue
    if (choices.length < max) choices.push({ asset, named: false, section: FROM_LIBRARY })
    else more++
  }
  return { choices, more }
}

/** Heading over a run of choices: a label that does not fit keeps GT1's single "Gắn ảnh khác…" for its linked pictures. */
export function choiceHeading(group: Pick<PlaceholderGroup, 'kind'>, section: string): string {
  return group.kind === 'mismatch' && section !== FROM_LIBRARY ? 'Gắn ảnh khác…' : section
}

/** The heading shown before each choice of a menu, in order (null: the same heading as the choice before it). */
export function choiceHeadings(group: Pick<PlaceholderGroup, 'kind'>, sections: readonly string[]): (string | null)[] {
  const all = sections.map((section) => choiceHeading(group, section))
  return all.map((h, i) => (i > 0 && all[i - 1] === h ? null : h))
}

const menuItems = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]

/**
 * The red-text picker of a prompt field (the inspector's PromptEditor, the scene node's NodePromptField; `assets` /
 * `refs`: the inputs the field highlights with). The field feeds it every caret change — `update`, true when the picker
 * now shows (no "@" list there) — gives it its keys first (`onKeyDown`: Enter / Alt+↓ move into the menu, bare arrows
 * stay the caret's) and its blur, and renders `popup`. Open / closed: mentions.ts pickerNext. Typing never parses the
 * prompt here (a keystroke and the caret event after it leave the picker closed): only caret moves and clicks do.
 */
export function usePlaceholderPicker(sceneId: string, text: string, assets: Asset[], refs: string[], taRef: RefObject<HTMLTextAreaElement | null>) {
  const [state, setState] = useState<PickerState>(PICKER_CLOSED)
  const stateRef = useRef(state)
  const live = useRef({ assets, refs })
  useLayoutEffect(() => {
    live.current = { assets, refs }
  }, [assets, refs])
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  // Measured on another text (undo, a fill, a renumbering): closed until the caret moves again.
  const caret = state.at && state.at.text === text ? state.at.caret : null
  const hit = useMemo(() => (caret === null ? null : placeholderPickerAt(text, caret, caret, assets, refs)), [text, caret, assets, refs])
  const set = useCallback((next: PickerState) => {
    stateRef.current = next
    setState(next)
  }, [])
  const update = useCallback(
    (value: string, start: number, end: number, cause: PickerCause): boolean => {
      const next = pickerNext(stateRef.current, cause, value, start, end)
      set(next)
      return !!next.at && !!placeholderPickerAt(value, start, end, live.current.assets, live.current.refs)
    },
    [set],
  )
  const close = useCallback(
    (refocus = false) => {
      const ta = taRef.current
      set(ta ? pickerClosed(ta.value, ta.selectionStart) : PICKER_CLOSED)
      if (refocus) ta?.focus({ preventScroll: true })
    },
    [taRef, set],
  )
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!hit || e.nativeEvent.isComposing || pickerFieldKey(e) !== 'menu') return false
    // Into the menu: its first enabled command takes the focus (nothing runs) — never a line break inside red text.
    e.preventDefault()
    e.stopPropagation()
    const items = menuItems(menuRef.current)
    const first = placeholderMenuIndex('ArrowDown', -1, items.map((b) => b.disabled))
    if (first !== null) items[first].focus()
    return true
  }
  const onBlur = (next: EventTarget | null) => {
    if (!(next instanceof Node) || !menuRef.current?.contains(next)) close()
  }
  const popup = hit ? (
    <PromptPlaceholderMenu sceneId={sceneId} group={hit.group} anchor={hit.start} prompt={text} refs={refs} taRef={taRef} menuRef={menuRef} menuId={menuId} onClose={close} />
  ) : null
  return { update, close, onKeyDown, onBlur, menuId, open: !!hit, popup }
}

/** The prompt picker's own style; place() writes its position straight to the element (no re-render per pan frame). */
const PICKER_STYLE: CSSProperties = { position: 'fixed' }
const PICKER_W = 340

function PromptPlaceholderMenu({ sceneId, group, anchor, prompt, refs, taRef, menuRef, menuId, onClose }: {
  sceneId: string
  group: PlaceholderGroup
  anchor: number
  prompt: string
  refs: string[]
  taRef: RefObject<HTMLTextAreaElement | null>
  menuRef: RefObject<HTMLDivElement | null>
  menuId: string
  onClose: (refocus?: boolean) => void
}) {
  // Only the open picker subscribes to the whole library.
  const assets = useProject((s) => s.project.assets)
  const { choices, more } = useMemo(() => {
    const library = libraryChoices(assets, refs)
    return { choices: [...placeholderChoices(prompt, assets, refs), ...library.choices], more: library.more }
  }, [prompt, assets, refs])
  useLayoutEffect(() => {
    const ta = taRef.current
    const menu = menuRef.current
    if (!ta || !menu) return
    const canvas = ta.closest('.react-flow__viewport')
    const place = () => {
      const c = caretCoordinates(ta, anchor)
      const r = ta.getBoundingClientRect()
      // A node's field is scaled by the canvas zoom: local caret px → screen px.
      const k = ta.offsetWidth ? r.width / ta.offsetWidth : 1
      const width = Math.min(PICKER_W, window.innerWidth - 16)
      const pos = popupPlacement(r.top + (c.top - ta.scrollTop) * k, c.height * k, PICKER_W, window.innerHeight)
      const st = menu.style
      st.zIndex = canvas ? '96' : '150' // as the "@" list there
      st.width = `${width}px`
      st.minWidth = '0'
      st.left = `${Math.round(Math.max(8, Math.min(r.left + (c.left - ta.scrollLeft) * k, window.innerWidth - width - 8)))}px`
      st.top = pos.top === undefined ? 'auto' : `${pos.top}px`
      st.bottom = pos.bottom === undefined ? 'auto' : `${pos.bottom}px`
      st.maxHeight = `${pos.maxHeight}px`
    }
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node) || !menu.contains(e.target)) place()
    }
    place()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', place)
    // Canvas pan / zoom changes a transform, not a scroll offset.
    const observer = canvas ? new MutationObserver(place) : null
    if (canvas) observer?.observe(canvas, { attributes: true, attributeFilter: ['style'] })
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', place)
      observer?.disconnect()
    }
  }, [taRef, menuRef, anchor, prompt])
  // A picker that goes away under the keyboard (its red text gone after Ctrl+Z…) hands the focus back to the field.
  useLayoutEffect(() => {
    const menu = menuRef.current
    const ta = taRef.current
    return () => {
      if (menu?.contains(document.activeElement)) ta?.focus({ preventScroll: true })
    }
  }, [menuRef, taRef])
  return createPortal(
    <PlaceholderMenu
      sceneId={sceneId}
      group={group}
      prompt={prompt}
      refs={refs}
      assets={assets}
      choices={choices}
      more={more}
      ignoreRef={taRef}
      onClose={onClose}
      menuRef={menuRef}
      menuId={menuId}
      style={PICKER_STYLE}
      picker
    />,
    document.body,
  )
}

/** Text shown on the chip of a group. */
export function chipLabel(g: Pick<PlaceholderGroup, 'kind' | 'n' | 'base' | 'text'>): string {
  if (g.kind === 'mismatch') return `@image_${g.n} · ${g.base ?? ''}?`
  return g.base ? `@image_?${g.n} · ${g.base}` : g.text
}

/** The label glued to a token / placeholder text ("@image_2(Lumi · ảnh 2)" → "Lumi · ảnh 2"), '' without one. */
export function gluedLabel(text: string): string {
  const at = text.indexOf('(')
  return at >= 0 && text.endsWith(')') ? text.slice(at + 1, -1) : ''
}

/** Title of a group's menu. */
export function menuTitle(g: Pick<PlaceholderGroup, 'kind' | 'n' | 'base' | 'text' | 'slotName'>): string {
  if (g.kind === 'mismatch') return `@image_${g.n} đang là “${g.slotName ?? '?'}”, không phải “${g.base ?? ''}”`
  if (g.base) return `Chữ đỏ chờ ảnh · ${g.base} (trước là @image_${g.n})`
  return `${g.text} — chưa gắn ảnh nào`
}

export const PlaceholderBar = memo(function PlaceholderBar({ sceneId, variant = 'panel' }: { sceneId: string; variant?: 'panel' | 'node' }) {
  const livePrompt = useSceneField(sceneId, (s) => s.prompt) ?? ''
  const refs = useSceneField(sceneId, (s) => s.refs) ?? EMPTY_IDS
  const assets = useProject((s) => s.project.assets)
  // The bar may lag a keystroke behind the editor; the run gate never does (core/runRules on the store).
  const prompt = useDeferredValue(livePrompt)
  const groups = useMemo(() => (prompt.includes('@') ? placeholderGroups(prompt, assets, refs) : []), [prompt, assets, refs])
  const choices = useMemo(() => (groups.length ? placeholderChoices(prompt, assets, refs) : []), [groups.length, prompt, assets, refs])
  if (!groups.length) return null
  const labelled = groups.filter((g) => g.kind !== 'bare').length
  const node = variant === 'node'
  const emptyHint = 'Nối ảnh thay thế vào cảnh trước (kéo dây), rồi chọn ở đây'
  // The node's strip is one 22px line (the node never grows): the hints go into titles there.
  return (
    <div
      className={`in-ph is-${variant}`}
      role="group"
      aria-label="Chữ đỏ chờ ảnh"
      title={node ? `Bấm một chữ đỏ để gắn ảnh, đổi thành chữ hoặc xoá — hoặc kéo ảnh / nhân vật thả lên nó${choices.length ? '' : `. ${emptyHint}`}` : undefined}
    >
      <span className="in-ph-title">
        <TriangleAlert size={12} aria-hidden="true" />
        Chữ đỏ chờ ảnh:
      </span>
      {groups.map((g) => (
        <PlaceholderChip key={g.key} sceneId={sceneId} group={g} choices={choices} prompt={prompt} refs={refs} assets={assets} />
      ))}
      {labelled > 1 && !node && (
        <button type="button" className="in-hint-btn" onClick={() => allPlaceholdersToTextAction(sceneId)} title={shortcutText('Mọi chữ đỏ có tên thành chữ thường (Ctrl+Z để hoàn tác)')}>
          Đổi tất cả thành chữ
        </button>
      )}
      {!choices.length && !node && <span className="in-ph-empty">{emptyHint}</span>}
    </div>
  )
})

interface ChipProps {
  sceneId: string
  group: PlaceholderGroup
  choices: PlaceholderChoice[]
  prompt: string
  refs: string[]
  assets: Asset[]
}

function PlaceholderChip(props: ChipProps) {
  const { group } = props
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const count = group.members.length
  return (
    <span className="in-pop-host in-ph-host">
      <button
        ref={btn}
        type="button"
        className={`in-ph-chip is-${group.kind}`}
        // the scene node's strip: a picture dropped on this chip fills this group (SceneNodeEditor fillFromDrop)
        data-ph-group={group.key}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={`${menuTitle(group)}${count > 1 ? ` · ${count} chỗ` : ''}`}
      >
        <span className="in-ph-chip-text">{chipLabel(group)}</span>
        {count > 1 && <span className="in-ph-count">×{count}</span>}
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {open && (
        <PlaceholderMenu
          {...props}
          ignoreRef={btn}
          onClose={(refocus) => {
            setOpen(false)
            if (refocus) btn.current?.focus()
          }}
        />
      )}
    </span>
  )
}

/** A group's menu: a chip's (the bar, focus inside at once) or the prompt picker's (`picker`). Exported for tests. */
export function PlaceholderMenu({ sceneId, group, choices, prompt, refs, assets, onClose, ignoreRef, menuRef, menuId, style, picker = false, more = 0 }: ChipProps & {
  onClose: (refocus?: boolean) => void
  ignoreRef: RefObject<HTMLElement | null>
  menuRef?: RefObject<HTMLDivElement | null>
  menuId?: string
  style?: CSSProperties
  /** The prompt picker (usePlaceholderPicker): the focus stays in the field until Enter / Alt+↓; a key footer. */
  picker?: boolean
  /** Library pictures left out of the picker (libraryChoices). */
  more?: number
}) {
  const ownRef = useRef<HTMLDivElement>(null)
  const ref = menuRef ?? ownRef
  const renumber = useProject((s) => s.project.settings.autoRenumber)
  const model = useSceneField(sceneId, (s) => s.settings.model)
  // Is the keyboard in the menu? (the picker's footer names the keys of where it is)
  const [inside, setInside] = useState(!picker)
  useDismiss(ref, () => onClose(true), ignoreRef)
  useEffect(() => {
    if (picker) return
    const items = menuItems(ref.current)
    const first = placeholderMenuIndex('Home', -1, items.map((b) => b.disabled))
    if (first !== null) items[first].focus()
  }, [picker, ref])
  // What each picture would do (refused ones stay visible, disabled, with the reason).
  const plans = useMemo(() => {
    const maxImages = model ? MODELS[model].maxRefImages : 0
    return choices.map((c) => ({ ...c, plan: planFill({ prompt, refs }, assets, group.key, c.asset.id, { renumber, maxImages }) }))
  }, [choices, prompt, refs, assets, group.key, renumber, model])
  const headings = choiceHeadings(group, plans.map((p) => p.section))
  const run = (fn: () => void) => {
    fn()
    onClose(true)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const what = pickerMenuKey(e)
    if (what === 'pass') return // Ctrl / ⌘ chords: undo, save, run still work from here
    e.stopPropagation()
    if (what === 'close') {
      // Esc, Tab, Shift+Tab: back to the field / the chip — never stranded on <body>
      e.preventDefault()
      onClose(true)
      return
    }
    if (what !== 'move') return
    const items = menuItems(ref.current)
    const next = placeholderMenuIndex(e.key, items.indexOf(document.activeElement as HTMLButtonElement), items.map((b) => b.disabled))
    if (next === null) return
    e.preventDefault()
    items[next].focus()
  }
  const base = group.base
  return (
    <div
      ref={ref}
      id={menuId}
      style={style}
      className="in-picker in-ph-menu nodrag nopan nowheel nokey"
      role="menu"
      aria-label={menuTitle(group)}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      // the picker: clicking a command leaves the caret in the field
      onMouseDown={picker ? (e) => e.preventDefault() : undefined}
      onFocus={() => setInside(true)}
      onBlur={(e) => {
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setInside(false)
      }}
    >
      <div className="in-picker-title">{menuTitle(group)}</div>
      <div className="in-picker-list">
        {group.kind === 'mismatch' && (
          <>
            <button
              type="button"
              role="menuitem"
              className="in-picker-item"
              onClick={() => run(() => splitTokenAction(sceneId, group.key, `@image_${group.n}`))}
              title={shortcutText('Chữ trong ngoặc được giữ và gửi như chữ thường: chỉ thêm một dấu cách trước “(” (Ctrl+Z để hoàn tác)')}
            >
              <span className="in-picker-text">
                <span className="in-picker-label">
                  Giữ @image_{group.n} = {group.slotName}, giữ chữ “({gluedLabel(group.text)})”
                </span>
                <span className="in-picker-sub">thêm dấu cách trước “(”</span>
              </span>
            </button>
            <button type="button" role="menuitem" className="in-picker-item" onClick={() => run(() => keepTokenAction(sceneId, group.key, `@image_${group.n}`))} title={shortcutText('Ctrl+Z để hoàn tác')}>
              <span className="in-picker-text">
                <span className="in-picker-label">
                  Giữ @image_{group.n} = {group.slotName}, xoá chữ “({gluedLabel(group.text)})”
                </span>
              </span>
            </button>
          </>
        )}
        {plans.flatMap(({ asset, named, section, plan }, i) => {
          const name = asset.name || asset.tag
          const item = (
            <button
              type="button"
              role="menuitem"
              key={asset.id}
              className="in-picker-item"
              disabled={!plan.ok}
              title={plan.ok ? `Gắn ${name} vào chỗ này → ${plan.token} (${platformText.mod}+Z để hoàn tác)` : fillRefusalText(plan.why, name, plan.token)}
              onClick={() => run(() => fillPlaceholderAction(sceneId, group.key, asset.id))}
            >
              <AssetAvatar asset={asset} size={22} />
              <span className="in-picker-text">
                <span className="in-picker-label">{name}</span>
                <span className="in-picker-sub">
                  {!plan.ok ? fillRefusalText(plan.why, name, plan.token) : section === FROM_LIBRARY ? 'Nối & gắn' : named ? 'đã nhắc trong prompt' : 'đã nối, chưa nhắc'}
                  {plan.ok ? ` → ${plan.token}` : ''}
                </span>
              </span>
            </button>
          )
          return headings[i] ? [<div key={`h:${asset.id}`} className="in-ph-sub">{headings[i]}</div>, item] : [item]
        })}
        {more > 0 && <div className="in-ph-sub">+{more} ảnh khác trong Thư viện — kéo thẻ thả lên chữ đỏ để gắn</div>}
        {!plans.length && <div className="in-picker-empty">Nối ảnh thay thế vào cảnh trước (kéo dây), rồi chọn ở đây</div>}
      </div>
      <div className="in-ph-foot">
        {base && (
          <button type="button" role="menuitem" className="in-picker-item" onClick={() => run(() => placeholderToTextAction(sceneId, group.key, base))} title={shortcutText('Không cần nhân vật đó nữa: chữ đỏ thành chữ thường (Ctrl+Z để hoàn tác)')}>
            Đổi thành chữ “{base}”
          </button>
        )}
        {group.kind !== 'mismatch' && (
          <button type="button" role="menuitem" className="in-picker-item is-danger" onClick={() => run(() => removePlaceholderAction(sceneId, group.key))} title={shortcutText('Xoá chữ đỏ khỏi prompt, chữ khác giữ nguyên (Ctrl+Z để hoàn tác)')}>
            Xoá chữ đỏ
          </button>
        )}
      </div>

      {picker && (
        <div className="in-mention-foot" aria-hidden="true">
          {inside ? (
            <>
              <span>
                <span className="kbd">↑</span>
                <span className="kbd">↓</span> di chuyển
              </span>
              <span>
                <span className="kbd">Enter</span> chọn
              </span>
            </>
          ) : (
            <span>
              <span className="kbd">Enter</span> để chọn
            </span>
          )}
          <span>
            <span className="kbd">Esc</span> đóng
          </span>
        </div>
      )}
    </div>
  )
}
