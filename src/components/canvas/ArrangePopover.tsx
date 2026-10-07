import { ChevronDown, LayoutGrid, X } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { arrangeCanvas, arrangeTakesKey, buildArrangeInput, stageSize, useArrangeMenu } from '../../arrangeActions'
import { arrange, type ArrangeOptions, type ArrangeStyle } from '../../core/arrange'
import { cleanArrangePrefs, DEFAULT_ARRANGE_PREFS, resolveArrange, useArrangePrefs, type ArrangePrefs } from '../../lib/arrangePrefs'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useUI } from '../../store/ui'
import { trapTabWithin, useOverlayFocus } from '../common/focus'
import {
  anchorRect, arrangeTitle, backdropHandlers, CHOSEN_NOTICE, FOLDER_KEEP_HINT, FOLLOW_HINT, handlePopoverKey, hiddenFolderTakes, hiddenLinkText,
  placeBySide, previewBoxes, previewCaption, scopeCounts, scopeLabel, scopeTotal, stripWarning, STYLE_HINT, STYLE_LABEL, TOO_WIDE,
  type PopoverAnchor, type Side,
} from './arrangeModel'
import './arrange.css'

const STYLES: ArrangeStyle[] = ['rows', 'grid', 'strip']
const ADVANCED_KEY = 'bdp:pref:arrange:advanced'
/** Overlays that own the keyboard while they are up (dialogs, confirm / dev sheets, image viewer). */
const OTHER_OVERLAYS = '.modal-backdrop, .lightbox, [data-top-overlay]'

export const ArrangeButton = memo(function ArrangeButton() {
  const anchor = useRef<HTMLButtonElement>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = useRef(false)
  const open = useArrangeMenu((s) => s.open)
  const prefs = useArrangePrefs(useShallow(({ style, gridCols, spacing, refs, folders, placedTakes, videoBy }) => ({ style, gridCols, spacing, refs, folders, placedTakes, videoBy })))
  // The open flag lives in a store: a button that leaves the page (other view, toolbar rebuilt) closes its popover.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); useArrangeMenu.getState().close() }, [])
  const stopHold = () => { if (timer.current) clearTimeout(timer.current) }
  const close = useCallback(() => { useArrangeMenu.getState().close(); anchor.current?.focus() }, [])
  return <div className="cv-ar-split">
    <button className="cv-tb-icon" aria-label="Sắp xếp" title={arrangeTitle(resolveArrange(prefs))}
      onClick={() => { if (!held.current) arrangeCanvas(); held.current = false }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); useArrangeMenu.getState().toggle() }}
      onPointerDown={(e) => { held.current = false; if (e.pointerType === 'touch') timer.current = setTimeout(() => { held.current = true; useArrangeMenu.getState().toggle() }, 500) }}
      onPointerUp={stopHold} onPointerCancel={stopHold} onPointerLeave={stopHold}>
      <LayoutGrid size={16} strokeWidth={1.75} />
    </button>
    <button ref={anchor} className="cv-tb-icon cv-ar-chevron" aria-label="Tuỳ chỉnh sắp xếp" title="Kiểu sắp xếp & tuỳ chỉnh" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => useArrangeMenu.getState().toggle()}><ChevronDown size={12} /></button>
    {open && anchor.current && <ArrangePopover anchor={anchor.current} side="up" onClose={close} />}
  </div>
})

function StylePreview({ style }: { style: ArrangeStyle }) {
  return <svg viewBox="0 0 100 48" aria-hidden="true">{Array.from({ length: 4 }, (_, i) => {
    const x = style === 'rows' ? 10 : style === 'grid' ? 8 + (i % 2) * 46 : 2 + i * 25
    const y = style === 'rows' ? 2 + i * 12 : style === 'grid' ? 5 + Math.floor(i / 2) * 24 : 18
    return <g key={i}><rect x={x} y={y} width={style === 'strip' ? 13 : 22} height={9} rx={2} /><rect className="cv-ar-mini-take" x={x + (style === 'strip' ? 15 : 26)} y={y} width={style === 'strip' ? 7 : 12} height={9} rx={2} /></g>
  })}</svg>
}

/**
 * "Sắp xếp canvas" popover. `anchor`: the element it opens from (read again on every placement) or a fixed rectangle;
 * `side`: where it opens (flips when there is no room). Portaled to <body> (the toolbar has a transform and scrolls);
 * a transparent backdrop takes every outside click, drop and wheel, so closing it never reaches the canvas.
 */
export const ArrangePopover = memo(function ArrangePopover({ anchor, side, onClose }: { anchor: PopoverAnchor; side: Side; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null), backdrop = useRef<HTMLDivElement>(null)
  const [prefs, setPrefs] = useState(() => cleanArrangePrefs(useArrangePrefs.getState()))
  const [scope, setScope] = useState<ArrangeOptions['scope']>('all')
  const [advanced, setAdvanced] = useState(() => { try { return localStorage.getItem(ADVANCED_KEY) === 'true' } catch { return false } })
  const [position, setPosition] = useState({ x: 8, y: 8 })
  // Read once: measuring the stage on every preview would force a layout per job progress tick.
  const [stage] = useState(stageSize)
  const project = useProject((s) => s.project), selected = useUI((s) => s.selectedIds), display = useUI((s) => s.takeDisplay)
  // Only what moves the layout (ids, sizes, positions, chosen take): progress ticks of running jobs leave it alone.
  const takesKey = useRuns((s) => arrangeTakesKey(s.takes))
  const base = useMemo(() => resolveArrange(prefs), [prefs])
  // buildArrangeInput reads the stores: project / takesKey / selected / display are the parts it depends on.
  const input = useMemo(() => buildArrangeInput({ ...base, scope }, { stage }), [base, scope, stage, project, takesKey, selected, display])
  const counts = useMemo(() => scopeCounts(input, base.refs), [input, base.refs])
  // "Áp dụng cho" only with 2+ selected cards the arrange would move; otherwise the whole canvas.
  const canSelect = scopeTotal(counts) >= 2
  const opts = useMemo(() => ({ ...base, scope: canSelect ? scope : 'all' as const }), [base, scope, canSelect])
  const result = useMemo(() => arrange(input, opts), [input, opts])
  const boxes = useMemo(() => previewBoxes(result), [result])
  const count = input.clusters.filter((s) => opts.scope === 'all' || s.inScope).length
  const hiddenLinked = useMemo(() => opts.video === 'chosen' && display === 'all' ? hiddenFolderTakes(project.folders ?? [], input.takes) : 0, [opts.video, display, project.folders, input.takes])
  const handlers = useMemo(() => backdropHandlers(onClose), [onClose])
  useOverlayFocus(ref)
  useLayoutEffect(() => { ref.current?.querySelector<HTMLInputElement>('input:checked')?.focus() }, [])
  useLayoutEffect(() => {
    const update = () => {
      const rect = ref.current?.getBoundingClientRect()
      if (!rect) return
      const next = placeBySide(anchorRect(anchor), { w: rect.width, h: rect.height }, side, { w: window.innerWidth, h: window.innerHeight })
      setPosition((p) => (p.x === next.x && p.y === next.y ? p : next))
    }
    // After a window resize the toolbar re-lays out (density) in the next frame: read the anchor once it has.
    let frame = 0
    const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update) }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later)
    if (ref.current) observer?.observe(ref.current)
    if (typeof Element !== 'undefined' && anchor instanceof Element) observer?.observe(anchor)
    window.addEventListener('resize', later)
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize', later) }
  }, [anchor, side])
  useEffect(() => {
    const ctx = {
      inside: (t: unknown) => t instanceof Node && !!ref.current?.contains(t),
      otherOverlay: () => [...document.querySelectorAll(OTHER_OVERLAYS)].some((el) => el !== backdrop.current),
      close: onClose,
      focus: () => ref.current?.focus({ preventScroll: true }),
    }
    const key = (e: KeyboardEvent) => { handlePopoverKey(e, ctx) }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])
  const patch = (p: Partial<ArrangePrefs>) => setPrefs((s) => cleanArrangePrefs({ ...s, ...p }))
  const video = (v: ArrangeOptions['video']) => patch({ videoBy: { ...prefs.videoBy, [prefs.style]: v } })
  const b = result.bbox
  return createPortal(<div ref={backdrop} className="cv-ar-backdrop" data-top-overlay="" {...handlers}>
    <div ref={ref} className="cv-ar-popover" role="dialog" aria-modal="true" aria-label="Sắp xếp canvas" tabIndex={-1} style={{ left: position.x, top: position.y }}
      onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') return; if (ref.current) trapTabWithin(ref.current, e); e.stopPropagation() }}>
      <header><strong>Sắp xếp canvas</strong><button className="icon-btn" aria-label="Đóng" onClick={onClose}><X size={16} /></button></header>
      <fieldset className="cv-ar-styles"><legend>Kiểu sắp xếp</legend>{STYLES.map((style) => <label key={style} className={prefs.style === style ? 'is-selected' : ''} title={STYLE_HINT[style]}>
        <input type="radio" name="arrange-style" value={style} checked={prefs.style === style} onChange={() => patch({ style })} />
        <StylePreview style={style} /><span>{STYLE_LABEL[style]}</span>
      </label>)}</fieldset>
      <p className="cv-ar-hint">{STYLE_HINT[prefs.style]}{prefs.style === 'strip' && stripWarning(count) ? ` ${stripWarning(count)}` : ''}</p>
      {prefs.style === 'grid' && <label className="cv-ar-row">Số cảnh mỗi hàng<select className="select" value={prefs.gridCols} onChange={(e) => patch({ gridCols: e.target.value === 'auto' ? 'auto' : Number(e.target.value) as ArrangeOptions['gridCols'] })}>
        <option value="auto">Tự động</option>{[2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
      </select></label>}
      <label className="cv-ar-row">Video<select className="select" value={opts.video} onChange={(e) => video(e.target.value as ArrangeOptions['video'])}><option value="all">Tất cả</option><option value="chosen">Chỉ take chọn (gọn)</option></select></label>
      {opts.video === 'chosen' && <p className="cv-ar-hint">{CHOSEN_NOTICE}</p>}
      <label className="cv-ar-row">Khoảng cách<select className="select" value={prefs.spacing} onChange={(e) => patch({ spacing: e.target.value as ArrangeOptions['spacing'] })}><option value="tight">Sát</option><option value="normal">Vừa</option><option value="roomy">Thoáng</option></select></label>
      {canSelect && <label className="cv-ar-row">Áp dụng cho<select className="select" value={opts.scope} onChange={(e) => setScope(e.target.value as ArrangeOptions['scope'])}><option value="all">Cả canvas</option><option value="selection">{scopeLabel(counts)}</option></select></label>}
      <button className="btn cv-ar-more" aria-expanded={advanced} onClick={() => { setAdvanced(!advanced); try { localStorage.setItem(ADVANCED_KEY, String(!advanced)) } catch { /* Storage unavailable. */ } }}>Thêm tuỳ chọn</button>
      {advanced && <div>
        <label className="cv-ar-row">Nhân vật, bối cảnh<select className="select" value={prefs.refs} onChange={(e) => patch({ refs: e.target.value as ArrangeOptions['refs'] })}><option value="column">Cột bên trái</option><option value="byKind">Theo loại</option><option value="keep">Để nguyên chỗ</option></select></label>
        <label className="cv-ar-row">Thư mục<select className="select" value={prefs.folders} onChange={(e) => patch({ folders: e.target.value as ArrangeOptions['folders'] })}><option value="keep">Để nguyên chỗ</option><option value="top">Hàng phía trên cảnh</option></select></label>
        {prefs.folders === 'keep' && <p className="cv-ar-hint">{FOLDER_KEEP_HINT}</p>}
        <label className="cv-ar-row">Video đã kéo ra<select className="select" value={prefs.placedTakes} onChange={(e) => patch({ placedTakes: e.target.value as ArrangeOptions['placedTakes'] })}><option value="reset">Về cạnh cảnh</option><option value="follow">Đi theo cảnh</option></select></label>
        {prefs.placedTakes === 'follow' && <p className="cv-ar-hint">{FOLLOW_HINT}</p>}
      </div>}
      <figure className="cv-ar-preview"><svg role="img" aria-label="Xem trước bố cục canvas" viewBox={`${b.x - 24} ${b.y - 24} ${b.w + 48} ${b.h + 48}`}>
        {boxes.map((box) => <rect key={box.id} className={`cv-ar-box-${box.kind}`} x={box.x} y={box.y} width={box.w} height={box.h} rx={6} />)}
      </svg><figcaption>{previewCaption(result)}</figcaption></figure>
      {hiddenLinked > 0 && <p className="cv-ar-hint">{hiddenLinkText(hiddenLinked)}</p>}
      {result.fitZoom < 0.1 && <p className="cv-ar-hint">{TOO_WIDE}</p>}
      <footer><button className="btn" onClick={() => { useArrangePrefs.getState().reset(); setPrefs(cleanArrangePrefs(DEFAULT_ARRANGE_PREFS)); setScope('all') }}>Về mặc định</button><button className="btn btn-primary" onClick={() => { useArrangePrefs.getState().set(prefs); arrangeCanvas({ scope: opts.scope }); onClose() }}>Sắp xếp</button></footer>
    </div>
  </div>, document.body)
})
