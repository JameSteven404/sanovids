// "Chữ đỏ chờ ảnh": the always-available place to deal with the red placeholders a removed reference picture left in a
// scene's prompt ("@image_?2(Lumi)", core/placeholders) — under the prompt editor of the inspector (and, from E2, of the
// scene card editor: variant 'node'). One chip per group; its menu fills it with a linked picture ("Gắn ảnh đã nối"),
// turns it into plain text ("Đổi thành chữ “Lumi”") or removes it ("Xoá chữ đỏ"); a labelled token whose label does
// not fit its slot ("@image_2(Lumi)" while 2 is Làng) offers "Giữ @image_2 = Làng", keeping the bracket text as plain
// text (one space before the "(", first: nothing deleted) or deleting it. Every command is an explicit click
// and ONE undo step (src/placeholderActions.ts); nothing is filled by itself.
import { platformText, shortcutText } from '../../lib/platformText'
import { ChevronDown, TriangleAlert } from 'lucide-react'
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
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
import { EMPTY_IDS, useDismiss, useSceneField } from './shared'

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
  const choices = useMemo(() => (groups.length ? fillChoices(prompt, assets, refs) : []), [groups.length, prompt, assets, refs])
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
  choices: { asset: Asset; named: boolean }[]
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

function PlaceholderMenu({ sceneId, group, choices, prompt, refs, assets, onClose, ignoreRef }: ChipProps & { onClose: (refocus?: boolean) => void; ignoreRef: RefObject<HTMLButtonElement | null> }) {
  const ref = useRef<HTMLDivElement>(null)
  const renumber = useProject((s) => s.project.settings.autoRenumber)
  const model = useSceneField(sceneId, (s) => s.settings.model)
  useDismiss(ref, () => onClose(true), ignoreRef)
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [])
  // What each linked picture would do (refused ones stay visible, disabled, with the reason).
  const plans = useMemo(() => {
    const maxImages = model ? MODELS[model].maxRefImages : 0
    return choices.map((c) => ({ ...c, plan: planFill({ prompt, refs }, assets, group.key, c.asset.id, { renumber, maxImages }) }))
  }, [choices, prompt, refs, assets, group.key, renumber, model])
  const run = (fn: () => void) => {
    onClose()
    fn()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
    items[next]?.focus()
  }
  const base = group.base
  return (
    <div ref={ref} className="in-picker in-ph-menu" role="menu" aria-label={menuTitle(group)} onKeyDown={onKeyDown}>
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
        {plans.length > 0 && <div className="in-ph-sub">{group.kind === 'mismatch' ? 'Gắn ảnh khác…' : 'Gắn ảnh đã nối'}</div>}
        {plans.map(({ asset, named, plan }) => {
          const name = asset.name || asset.tag
          return (
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
                  {named ? 'đã nhắc trong prompt' : 'đã nối, chưa nhắc'}
                  {plan.ok ? ` → ${plan.token}` : ''}
                </span>
              </span>
            </button>
          )
        })}
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
    </div>
  )
}
