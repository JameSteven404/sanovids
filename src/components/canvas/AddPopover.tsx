// UI-04 (docs/UI-MUOT.md): the toolbar's "+ Thêm" popover, like the node menus of ElevenLabs Flows / Magnific — a
// search field, filter chips, grouped rows with icons. Its own lazy chunk (ToolbarBar), placed and dismissed like
// ArrangePopover: portaled to <body>, a transparent backdrop takes outside clicks / drops / wheels, Escape closes, keys
// never reach the canvas. Every row runs an existing command (addModel lists them).
import { useReactFlow } from '@xyflow/react'
import { FileText, FolderPlus, ImagePlus, Plus, SquarePlus, X, type LucideIcon } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { newScene, nextScene, pickImagesAt } from '../../actions'
import { createFolderNode } from '../../folderActions'
import { useUI } from '../../store/ui'
import { trapTabWithin, useOverlayFocus } from '../common/focus'
import { ADD_FILTERS, ADD_GROUP_LABEL, filterAddItems, type AddFilter, type AddItem, type AddItemId } from './addModel'
import { anchorRect, backdropHandlers, handlePopoverKey, placeBySide, type PopoverAnchor, type Side } from './arrangeModel'
import { viewCenterSpot } from './canvasModel'
import './addPopover.css'

const ICON: Record<AddItemId, LucideIcon> = { 'add-next': Plus, 'add-empty': SquarePlus, 'add-images': ImagePlus, 'add-import': FileText, 'add-folder': FolderPlus }
/** Overlays that own the keyboard while they are up (dialogs, confirm / dev sheets, image viewer). */
const OTHER_OVERLAYS = '.modal-backdrop, .lightbox, [data-top-overlay]'

export const AddPopover = memo(function AddPopover({ anchor, side, onClose }: { anchor: PopoverAnchor; side: Side; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null), backdrop = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<AddFilter>('all')
  const [position, setPosition] = useState({ x: 8, y: 8 })
  const rf = useReactFlow()
  const items = useMemo(() => filterAddItems(query, filter), [query, filter])
  const handlers = useMemo(() => backdropHandlers(onClose), [onClose])
  useOverlayFocus(ref)
  useLayoutEffect(() => { search.current?.focus() }, [])
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    const next = placeBySide(anchorRect(anchor), { w: rect.width, h: rect.height }, side, { w: window.innerWidth, h: window.innerHeight })
    setPosition((p) => (p.x === next.x && p.y === next.y ? p : next))
  }, [anchor, side, items.length])
  useEffect(() => {
    const ctx = {
      inside: (t: unknown) => t instanceof Node && !!ref.current?.contains(t),
      otherOverlay: () => [...document.querySelectorAll(OTHER_OVERLAYS)].some((el) => el !== backdrop.current),
      close: onClose,
      focus: () => search.current?.focus({ preventScroll: true }),
    }
    const key = (e: KeyboardEvent) => { handlePopoverKey(e, ctx) }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])

  const run = (id: AddItemId) => {
    // The file picker needs this click's user gesture: started before the popover closes.
    if (id === 'add-images') pickImagesAt(viewCenterSpot(rf.screenToFlowPosition))
    else if (id === 'add-next') nextScene()
    else if (id === 'add-empty') newScene()
    else if (id === 'add-import') useUI.getState().openDialog({ kind: 'import' })
    else void createFolderNode()
    onClose()
  }
  const groups = (['common', 'more'] as const).map((g) => [g, items.filter((i) => i.group === g)] as const).filter(([, list]) => list.length)
  const row = (item: AddItem) => {
    const Icon = ICON[item.id]
    return <button key={item.id} type="button" className="cv-add-row" onClick={() => run(item.id)}>
      <Icon size={18} strokeWidth={1.75} aria-hidden />
      <span><b>{item.label}</b><small>{item.hint}</small></span>
    </button>
  }
  return createPortal(<div ref={backdrop} className="cv-add-backdrop" data-top-overlay="" {...handlers}>
    <div ref={ref} className="cv-add-popover" role="dialog" aria-modal="true" aria-label="Thêm vào canvas" tabIndex={-1} style={{ left: position.x, top: position.y }}
      onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') return; if (ref.current) trapTabWithin(ref.current, e); e.stopPropagation() }}>
      <header><strong>Thêm vào canvas</strong><button type="button" className="icon-btn" aria-label="Đóng" onClick={onClose}><X size={16} /></button></header>
      <input ref={search} id="cv-add-search" className="input" type="search" placeholder="Tìm loại mục… (cảnh, ảnh, thư mục)" aria-label="Tìm loại mục để thêm"
        autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && items[0]) { e.preventDefault(); run(items[0].id) } }} />
      <div className="cv-add-filters" role="group" aria-label="Lọc theo loại">
        {ADD_FILTERS.map((f) => <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
      </div>
      {groups.map(([g, list]) => <section key={g} className="cv-add-group" aria-label={ADD_GROUP_LABEL[g]}>
        <h3>{ADD_GROUP_LABEL[g]}</h3>
        {list.map(row)}
      </section>)}
      {!items.length && <p className="cv-add-empty">Không có mục nào khớp “{query}”.</p>}
    </div>
  </div>, document.body)
})
