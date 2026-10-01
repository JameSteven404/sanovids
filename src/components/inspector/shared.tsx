// Small building blocks shared by the inspector panels.
import type { LucideIcon } from 'lucide-react'
import { Check, ChevronDown, MapPin, Package, Palette, Search, User } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { Asset, AssetKind, Scene } from '../../core/types'
import { useProject } from '../../store/project'
import { AssetAvatar } from '../common/Media'
import { fold } from './mentions'

export const KIND_LABEL: Record<AssetKind, string> = {
  character: 'Nhân vật',
  location: 'Bối cảnh',
  prop: 'Đạo cụ',
  style: 'Phong cách',
}
export const KIND_ICON: Record<AssetKind, LucideIcon> = {
  character: User,
  location: MapPin,
  prop: Package,
  style: Palette,
}
export const KINDS: AssetKind[] = ['character', 'location', 'prop', 'style']

export const EMPTY_IDS: string[] = []

export { fold }

export function fmt(n: number): string {
  return n.toLocaleString('vi-VN')
}

// ---------------- per-viewer UI prefs (collapsed sections...) ----------------
const PREF = 'bdp:pref:in.'
export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREF + key)
    return raw == null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
export function writePref(key: string, value: unknown) {
  try {
    localStorage.setItem(PREF + key, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}
export function usePref<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => readPref(key, fallback))
  const set = (next: T) => {
    setV(next)
    writePref(key, next)
  }
  return [v, set]
}

/** Subscribe to one field of a scene. `pick` must return a primitive or an existing object (stable). */
export function useSceneField<T>(sceneId: string, pick: (s: Scene) => T): T | undefined {
  return useProject((s) => {
    const sc = s.project.scenes.find((x) => x.id === sceneId)
    return sc ? pick(sc) : undefined
  })
}

// ---------------- collapsible section ----------------
export function Section({
  id,
  title,
  meta,
  extra,
  children,
  defaultOpen = true,
  className = '',
}: {
  id: string
  title: ReactNode
  meta?: ReactNode
  extra?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
}) {
  const [open, setOpen] = usePref('sec.' + id, defaultOpen)
  return (
    <section className={`in-section ${open ? '' : 'is-collapsed'} ${className}`}>
      <div className="in-section-head">
        <button type="button" className="in-section-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <ChevronDown size={13} className="in-chev" />
          <span className="in-section-title">{title}</span>
          {meta}
        </button>
        {extra && <div className="in-section-extra">{extra}</div>}
      </div>
      {open && <div className="in-section-body">{children}</div>}
    </section>
  )
}

// ---------------- popover with search + list ----------------
export interface PickItem {
  id: string
  label: string
  sub?: string
  /** Pre-folded search haystack. */
  search: string
  leading?: ReactNode
  trailing?: ReactNode
  checked?: boolean
  disabled?: boolean
}

/** Close on outside mousedown / Escape. `ignore` elements (e.g. the toggle button) don't count as outside. */
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void, ignore?: RefObject<HTMLElement | null>) {
  const cb = useRef(onClose)
  cb.current = onClose
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (ref.current?.contains(t)) return
      if (ignore?.current?.contains(t)) return
      cb.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        cb.current()
      }
    }
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [ref, ignore])
}

export function PickerPopover({
  items,
  onPick,
  onClose,
  placeholder = 'Tìm…',
  emptyText = 'Không có mục nào.',
  title,
  footer,
  ignoreRef,
  align = 'left',
}: {
  items: PickItem[]
  onPick: (id: string) => void
  onClose: () => void
  placeholder?: string
  emptyText?: string
  title?: ReactNode
  footer?: ReactNode
  ignoreRef?: RefObject<HTMLElement | null>
  align?: 'left' | 'right'
}) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useDismiss(ref, onClose, ignoreRef)
  const filtered = useMemo(() => {
    const f = fold(q.trim())
    return f ? items.filter((i) => i.search.includes(f)) : items
  }, [items, q])
  const safeActive = Math.min(active, Math.max(0, filtered.length - 1))

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${safeActive}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [safeActive])

  return (
    <div ref={ref} className={`in-picker ${align === 'right' ? 'align-right' : ''}`} role="dialog">
      {title && <div className="in-picker-title">{title}</div>}
      <label className="in-picker-search">
        <Search size={13} />
        <input
          autoFocus
          value={q}
          placeholder={placeholder}
          onChange={(e) => {
            setQ(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(filtered.length - 1, a + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(0, a - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const it = filtered[safeActive]
              if (it && !it.disabled) onPick(it.id)
            }
          }}
        />
      </label>
      <div className="in-picker-list" ref={listRef}>
        {filtered.length === 0 && <div className="in-picker-empty">{emptyText}</div>}
        {filtered.map((it, i) => (
          <button
            type="button"
            key={it.id}
            data-idx={i}
            className={`in-picker-item ${i === safeActive ? 'active' : ''} ${it.checked ? 'checked' : ''}`}
            disabled={it.disabled}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(it.id)}
          >
            {it.leading}
            <span className="in-picker-text">
              <span className="in-picker-label">{it.label}</span>
              {it.sub && <span className="in-picker-sub">{it.sub}</span>}
            </span>
            {it.trailing}
            {it.checked !== undefined && <span className={`in-check ${it.checked ? 'on' : ''}`}>{it.checked && <Check size={11} strokeWidth={3} />}</span>}
          </button>
        ))}
      </div>
      {footer && <div className="in-picker-foot">{footer}</div>}
    </div>
  )
}

export function assetPickItems(assets: Asset[], opts: { exclude?: Set<string>; checked?: Set<string> } = {}): PickItem[] {
  return assets
    .filter((a) => !opts.exclude?.has(a.id))
    .map((a) => {
      const Icon = KIND_ICON[a.kind]
      return {
        id: a.id,
        label: a.name,
        sub: '@' + a.tag,
        search: fold(`${a.name} ${a.tag} ${KIND_LABEL[a.kind]}`),
        leading: <AssetAvatar asset={a} size={26} />,
        trailing: (
          <span className="in-kind" title={KIND_LABEL[a.kind]}>
            <Icon size={12} />
          </span>
        ),
        checked: opts.checked ? opts.checked.has(a.id) : undefined,
      }
    })
}

/** Library asset picker (search). */
export function AssetPicker({
  onPick,
  onClose,
  exclude,
  checked,
  title,
  ignoreRef,
  align,
  footer,
}: {
  onPick: (assetId: string) => void
  onClose: () => void
  exclude?: string[]
  checked?: string[]
  title?: ReactNode
  ignoreRef?: RefObject<HTMLElement | null>
  align?: 'left' | 'right'
  footer?: ReactNode
}) {
  const assets = useProject((s) => s.project.assets)
  const items = useMemo(
    () =>
      assetPickItems(assets, {
        exclude: exclude ? new Set(exclude) : undefined,
        checked: checked ? new Set(checked) : undefined,
      }),
    [assets, exclude, checked],
  )
  return (
    <PickerPopover
      items={items}
      onPick={onPick}
      onClose={onClose}
      placeholder="Tìm nhân vật, bối cảnh…"
      emptyText={assets.length ? 'Không tìm thấy.' : 'Thư viện trống — thêm ảnh ở cột trái.'}
      title={title}
      ignoreRef={ignoreRef}
      align={align}
      footer={footer}
    />
  )
}
