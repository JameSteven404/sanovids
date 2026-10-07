import { CirclePlay, Clapperboard, Download, Eye, GripVertical, LoaderCircle, Play, Plus, Star, TriangleAlert } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { downloadChosenTakesZip, downloadTake, newScene, requestRun } from '../../actions'
import { sceneCode } from '../../core/compile'
import { settingsLabel } from '../../core/models'
import type { Scene, Take } from '../../core/types'
import { useMotionLevel, type MotionLevel } from '../../lib/canvasPrefs'
import { useDownloadPrefs } from '../../lib/downloads'
import { sortedScenes, undoToastAction, useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { MediaImg } from '../common/Media'
import { takeDurationText, takesRuntime } from '../runs/importedTake'
import { useSceneRunBlock } from '../runs/shared'
import { formatRuntime, isEditingTarget, isSelectAllKey, latestOf, pickShowcaseTake, STATUS_LABEL, starredTake, useKeyboardArea, useTakesByScene } from './shared'
import { StoryboardPlayer, type PlayerItem } from './StoryboardPlayer'
import { edgeAnnouncement, gridStep, insertBar, moveAnnouncement, reorderToast, sceneOrderAt } from './storyboardOrder'
import { useCardReorder, type DropTarget } from './useCardReorder'
import './views.css'

/** Keys that go to another card (and, with Alt, move the card there). */
const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'])
/** Tooltip on the card grip: how to reorder and what happens to the scene codes. */
const REORDER_TIP =
  'Kéo thẻ tới chỗ mới để đổi thứ tự cảnh (Esc để huỷ). Mã cảnh S01, S02… đánh số lại theo thứ tự mới, như trong Bảng cảnh; Phát liền và file .zip đi theo thứ tự này. Bàn phím: chọn thẻ rồi Alt + ←/→ (Alt + ↑/↓ theo hàng). Ctrl+Z để hoàn tác.'

/** The one-time reorder tip above the cards (per browser / app install). */
const TIP_KEY = 'bdp:hint:storyboard-reorder'
function readTipSeen(): boolean {
  try {
    return localStorage.getItem(TIP_KEY) === '1'
  } catch {
    return false
  }
}
function writeTipSeen() {
  try {
    localStorage.setItem(TIP_KEY, '1')
  } catch {
    /* storage unavailable: the tip shows again next time */
  }
}

interface CardData {
  scene: Scene
  show: Take | undefined
  latest: Take | undefined
  starred: Take | undefined
  takeCount: number
}

export function Storyboard() {
  const scenes = useProject(useShallow((s) => sortedScenes(s.project)))
  const byScene = useTakesByScene()
  const selectedIds = useUI((s) => s.selectedIds)
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const [playFrom, setPlayFrom] = useState<number | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const motion = useMotionLevel()
  const ids = useMemo(() => scenes.map((s) => s.id), [scenes])
  // The card that takes Tab (roving tabindex): the last selected scene, else the first card.
  const activeId = useMemo(() => {
    const inList = new Set(ids)
    for (let i = selectedIds.length - 1; i >= 0; i--) if (inList.has(selectedIds[i])) return selectedIds[i]
    return ids[0]
  }, [ids, selectedIds])

  const cards: CardData[] = useMemo(
    () =>
      scenes.map((scene) => {
        const list = byScene.get(scene.id) ?? []
        return { scene, show: pickShowcaseTake(list), latest: latestOf(list), starred: starredTake(list), takeCount: list.length }
      }),
    [scenes, byScene],
  )

  // an imported ★ take whose duration canvasapp did not say (placeholder) or that was only guessed: the total is a guess
  const { seconds: starredRuntime, guessed: runtimeGuessed } = takesRuntime(cards.flatMap((c) => (c.starred ? [c.starred] : [])))
  const plannedRuntime = cards.reduce((t, c) => t + c.scene.settings.duration, 0)
  const missing = cards.filter((c) => !c.starred)
  // Same pick as actions.chosenTakeIds(): the ★ take, else the newest finished take of each scene.
  const chosenCount = cards.reduce((n, c) => n + (c.show ? 1 : 0), 0)
  const zipPrompts = useDownloadPrefs((s) => s.zipPrompts)
  const [zipping, setZipping] = useState(false)
  const downloadAll = async () => {
    if (zipping) return
    setZipping(true)
    try {
      await downloadChosenTakesZip()
    } catch (e) {
      toast(`Không tạo được file .zip: ${(e as Error).message}`, { tone: 'error' })
    } finally {
      setZipping(false)
    }
  }

  const items: PlayerItem[] = useMemo(
    () =>
      cards.map((c) => ({
        sceneId: c.scene.id,
        code: sceneCode(c.scene.order),
        title: c.scene.title,
        take: c.show ?? null,
        duration: c.show?.settings.duration ?? c.scene.settings.duration,
        ...(c.show?.imported ? { durationText: takeDurationText(c.show) } : {}),
      })),
    [cards],
  )

  const scenesRef = useRef(scenes)
  scenesRef.current = scenes
  const anchorRef = useRef<string | null>(null)
  const playingRef = useRef(false)
  playingRef.current = playFrom !== null

  // Screen readers: what a move / drag did (polite live region). The same text twice is still read (NBSP toggle).
  const [announcement, setAnnouncement] = useState('')
  const say = useCallback((text: string) => setAnnouncement((prev) => (prev === text ? text + String.fromCharCode(0xa0) : text)), [])
  const [tipSeen, setTipSeen] = useState(readTipSeen)
  const dismissTip = useCallback(() => {
    setTipSeen(true)
    writeTipSeen()
  }, [])

  // ---- drag a card to a new place → moveScene (one undo step; scene codes renumber like in Bảng cảnh) ----
  const reorderToastRef = useRef<number | null>(null)
  const onDrop = useCallback(
    (id: string, from: number, to: number) => {
      const list = scenesRef.current
      const scene = list[from]
      if (!scene || scene.id !== id) return
      useProject.getState().moveScene(id, sceneOrderAt(to))
      const ui = useUI.getState()
      if (!ui.selectedIds.includes(id)) ui.select([id])
      anchorRef.current = id
      say(moveAnnouncement({ title: scene.title, from, to, count: list.length }))
      // One toast for the latest drop (Hoàn tác undoes exactly that move).
      if (reorderToastRef.current !== null) ui.dismissToast(reorderToastRef.current)
      reorderToastRef.current = toast(reorderToast(from, to), { action: undoToastAction() })
      dismissTip()
    },
    [say, dismissTip],
  )
  const onLift = useCallback((_id: string, from: number) => say(`Đang kéo ${sceneCode(from + 1)}. Thả vào chỗ mới để đổi thứ tự, Esc để huỷ.`), [say])
  const onCancel = useCallback((_id: string, from: number) => say(`Đã huỷ kéo, ${sceneCode(from + 1)} giữ nguyên vị trí.`), [say])
  const reorder = useCardReorder({ gridRef, scrollRef, ids, motion, onDrop, onLift, onCancel })
  const { prepareMove } = reorder
  /** Click: select the card. Ctrl/Cmd+Click: add/remove it. Shift+Click: select the range from the last clicked card. */
  const onSelect = useCallback((id: string, mode: 'one' | 'toggle' | 'range') => {
    const ui = useUI.getState()
    const order = scenesRef.current.map((s) => s.id)
    const anchor = anchorRef.current
    if (mode === 'range' && anchor && order.includes(anchor)) {
      const a = order.indexOf(anchor)
      const b = order.indexOf(id)
      ui.select(order.slice(Math.min(a, b), Math.max(a, b) + 1))
      return
    }
    anchorRef.current = id
    if (mode === 'toggle') ui.select(ui.selectedIds.includes(id) ? ui.selectedIds.filter((x) => x !== id) : [...ui.selectedIds, id])
    else ui.select([id])
  }, [])

  // Keys while the storyboard is the active area (not while typing in another panel): Ctrl/Cmd+A selects every
  // scene · ←/→/↑/↓/Home/End go to another card · Alt + the same keys move the card there (↑/↓ = one row) with
  // moveScene, announced for screen readers. The "Phát liền" player captures its own keys.
  const rootRef = useRef<HTMLDivElement>(null)
  const inArea = useKeyboardArea(rootRef)
  useEffect(() => {
    const cardEl = (id: string) => gridRef.current?.querySelector<HTMLElement>(`[data-card="${id}"]`) ?? null
    const goTo = (id: string) => {
      useUI.getState().select([id])
      anchorRef.current = id
      const el = cardEl(id)
      el?.focus({ preventScroll: true })
      el?.scrollIntoView({ block: 'nearest' })
    }
    /** Cards in the first row of the grid as laid out now. */
    const columnsNow = () => {
      const cards = gridRef.current?.querySelectorAll<HTMLElement>(':scope > [data-card]')
      if (!cards?.length) return 1
      const top = cards[0].offsetTop
      let n = 0
      for (const c of cards) {
        if (Math.abs(c.offsetTop - top) > 2) break
        n++
      }
      return Math.max(1, n)
    }
    /** The card the keys act on: the focused one, else the last clicked / selected scene. */
    const currentId = (target: EventTarget | null): string | null => {
      const list = scenesRef.current
      const focused = target instanceof Element ? target.closest<HTMLElement>('[data-card]') : null
      if (focused && gridRef.current?.contains(focused)) return focused.dataset.card ?? null
      const sel = useUI.getState().selectedIds
      const a = anchorRef.current
      if (a && sel.includes(a) && list.some((s) => s.id === a)) return a
      for (let i = sel.length - 1; i >= 0; i--) if (list.some((s) => s.id === sel[i])) return sel[i]
      return null
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || playingRef.current) return
      const selectAll = isSelectAllKey(e)
      if (!selectAll && (e.ctrlKey || e.metaKey || e.shiftKey || !NAV_KEYS.has(e.key))) return
      if (isEditingTarget(e.target) || !inArea(e.target)) return
      const ui = useUI.getState()
      const list = scenesRef.current
      if (ui.dialog.kind !== 'none' || !list.length) return
      e.preventDefault()
      if (selectAll) {
        ui.select(list.map((s) => s.id))
        return
      }
      const id = currentId(e.target)
      const from = id ? list.findIndex((s) => s.id === id) : -1
      if (!id || from < 0) {
        if (e.altKey) say('Chọn một thẻ trước, rồi dùng Alt + mũi tên để dời cảnh.')
        else goTo(list[0].id)
        return
      }
      const to = gridStep(from, e.key, list.length, columnsNow())
      if (to === null) return
      if (!e.altKey) {
        goTo(list[to].id)
        return
      }
      if (to === from) {
        say(edgeAnnouncement(from, list.length, e.key))
        return
      }
      prepareMove(id, from, to)
      useProject.getState().moveScene(id, sceneOrderAt(to))
      say(moveAnnouncement({ title: list[from].title, from, to, count: list.length }))
      dismissTip()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inArea, prepareMove, say, dismissTip])

  const jumpTo = (id: string) => {
    useUI.getState().select([id])
    gridRef.current?.querySelector(`[data-card="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlashId(id)
    window.setTimeout(() => setFlashId((f) => (f === id ? null : f)), 1400)
  }

  const onPlay = useCallback((index: number) => setPlayFrom(index), [])

  if (!scenes.length) {
    return (
      <div className="vw-root">
        <div className="vw-empty-state">
          <div className="vw-empty-icon">
            <Clapperboard size={22} />
          </div>
          <h3>Storyboard trống</h3>
          <p>Khi dự án có cảnh, mỗi cảnh hiện thành một khung hình theo thứ tự — dùng take được đánh dấu ★.</p>
          <div className="vw-empty-actions">
            <button className="btn btn-primary" onClick={() => newScene()}>
              <Plus size={15} /> Cảnh mới
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="vw-root vw-sb-root" ref={rootRef} data-motion={motion}>
      <div className="vw-head">
        <div className="vw-head-title">
          <h2>Storyboard</h2>
          <span className="badge">{scenes.length} cảnh</span>
          <span
            className="vw-sb-stat"
            title={`Tổng thời lượng các take được đánh dấu ★ / tổng thời lượng dự kiến của mọi cảnh${runtimeGuessed ? ' — ≈: có take nhập từ canvasapp mà thời lượng không rõ hoặc chỉ là đoán' : ''}`}
          >
            <Star size={12} className="vw-star-ico" /> Thời lượng take chọn <b>{runtimeGuessed ? '≈' : ''}{formatRuntime(starredRuntime)}</b>
            <span className="faint"> / {formatRuntime(plannedRuntime)} dự kiến</span>
          </span>
        </div>
        <div className="vw-head-actions">
          <button
            className="btn btn-sm"
            disabled={!chosenCount || zipping}
            onClick={() => void downloadAll()}
            title={
              chosenCount
                ? `Một file .zip gồm take ★ (hoặc take mới nhất đã xong) của ${chosenCount} cảnh, theo thứ tự cảnh, đặt tên theo Cài đặt → Tên file${zipPrompts ? ', kèm prompts.txt' : ''}`
                : 'Chưa có video nào tạo xong'
            }
          >
            {zipping ? <LoaderCircle size={14} className="vw-spin" /> : <Download size={14} />}
            {zipping ? 'Đang nén…' : 'Tải tất cả video chọn (.zip)'}
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => setPlayFrom(0)} title="Phát lần lượt take ★ (hoặc take mới nhất) của từng cảnh">
            <CirclePlay size={14} /> Phát liền
          </button>
        </div>
      </div>

      {missing.length > 0 && (
        <div className="vw-sb-missing">
          <span className="vw-sb-missing-label">
            <TriangleAlert size={13} /> {missing.length} cảnh chưa có take ★
          </span>
          <div className="vw-sb-missing-list">
            {missing.slice(0, 24).map((c) => (
              <button key={c.scene.id} className="vw-sb-chip" onClick={() => jumpTo(c.scene.id)} title={c.scene.title || 'Chưa đặt tên'}>
                {sceneCode(c.scene.order)}
              </button>
            ))}
            {missing.length > 24 && <span className="faint">+{missing.length - 24}</span>}
          </div>
        </div>
      )}

      {!tipSeen && scenes.length > 1 && (
        <div className="vw-sb-tip" role="note">
          <GripVertical size={14} className="vw-sb-tip-ico" />
          <span>
            <b>Kéo thẻ để đổi thứ tự cảnh.</b> Mã cảnh (S01, S02…) đánh số lại theo thứ tự mới, như Bảng cảnh; Phát liền và file .zip đi theo thứ
            tự này. Bàn phím: chọn thẻ rồi <Kbd k="Alt" />+<Kbd k="←" />/<Kbd k="→" />
            {' (theo hàng: '}
            <Kbd k="Alt" />+<Kbd k="↑" />/<Kbd k="↓" />
            {'). '}
            <Kbd k="Ctrl" />+<Kbd k="Z" /> để hoàn tác.
          </span>
          <button className="btn btn-sm" onClick={dismissTip}>
            Đã hiểu
          </button>
        </div>
      )}

      <div className="vw-sb-scroll" ref={scrollRef}>
        <div className="vw-sb-grid" ref={gridRef} role="list" aria-label="Các cảnh theo thứ tự phim" {...reorder.gridProps}>
          {reorder.target && <DropMarker target={reorder.target} motion={motion} />}
          {cards.map((c, i) => (
            <StoryCard
              key={c.scene.id}
              index={i}
              scene={c.scene}
              show={c.show}
              latest={c.latest}
              starred={c.starred}
              takeCount={c.takeCount}
              selected={selected.has(c.scene.id)}
              tabbable={c.scene.id === activeId}
              flash={flashId === c.scene.id}
              onSelect={onSelect}
              onPlay={onPlay}
            />
          ))}
          {reorder.target && <DropCode target={reorder.target} motion={motion} />}
        </div>
      </div>
      <p id="vw-sb-reorder-help" className="vw-sr">
        Mũi tên để chuyển thẻ, Enter để xem take. Kéo thẻ hoặc dùng Alt cùng phím mũi tên để đổi thứ tự cảnh; mã cảnh đánh số lại theo thứ tự mới.
      </p>
      <div className="vw-sr" role="status" aria-live="polite">
        {announcement}
      </div>

      {playFrom !== null && <StoryboardPlayer items={items} start={playFrom} onClose={() => setPlayFrom(null)} />}
    </div>
  )
}

const StoryCard = memo(function StoryCard({
  index,
  scene,
  show,
  latest,
  starred,
  takeCount,
  selected,
  tabbable,
  flash,
  onSelect,
  onPlay,
}: CardData & {
  index: number
  selected: boolean
  /** Takes Tab (roving tabindex: one card of the grid). */
  tabbable: boolean
  flash: boolean
  onSelect: (id: string, mode: 'one' | 'toggle' | 'range') => void
  onPlay: (index: number) => void
}) {
  const code = sceneCode(scene.order)
  // Why Run is off: the queue's own rules (core/runGate = store/runs check()), like the canvas card and the inspector.
  const runBlock = useSceneRunBlock(scene)
  const running = latest && (latest.status === 'processing' || latest.status === 'queued') ? latest : undefined
  const failed = latest?.status === 'failed' ? latest : undefined
  const accent = scene.color ?? 'var(--accent)'
  // On the focused card itself: Enter opens the take, Space selects (arrows are the grid's, see Storyboard).
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.target !== e.currentTarget || e.altKey) return
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && show) {
      e.preventDefault()
      useUI.getState().openDialog({ kind: 'take', takeId: show.id })
    } else if (e.key === ' ') {
      e.preventDefault()
      onSelect(scene.id, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'one')
    }
  }

  return (
    <div
      data-card={scene.id}
      role="listitem"
      tabIndex={tabbable ? 0 : -1}
      aria-label={`${code} · ${scene.title || 'Chưa đặt tên'}${selected ? ' · đang chọn' : ''}`}
      aria-describedby="vw-sb-reorder-help"
      className={`vw-card ${selected ? 'selected' : ''} ${flash ? 'flash' : ''}`}
      onClick={(e) => onSelect(scene.id, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'one')}
      onDoubleClick={() => show && useUI.getState().openDialog({ kind: 'take', takeId: show.id })}
      onKeyDown={onKeyDown}
    >
      <div className="vw-card-thumb">
        {show?.posterId ? (
          <MediaImg id={show.posterId} className="vw-card-img" alt={`${code} T${show.number}`} />
        ) : (
          <div className="vw-card-placeholder" style={{ ['--ph' as string]: accent }}>
            <span>{code}</span>
            <small>{latest ? (running ? 'Đang tạo…' : 'Chưa có take xong') : 'Chưa chạy'}</small>
          </div>
        )}
        <span className="vw-card-code">{code}</span>
        {show && (
          <span className={`vw-card-take ${show.starred ? 'starred' : ''}`} title={show.starred ? 'Take đã chọn (★)' : 'Take mới nhất — chưa chọn ★'}>
            {show.starred && <Star size={11} fill="currentColor" />}T{show.number}
          </span>
        )}
        <span className="vw-card-dur">{show ? takeDurationText(show) : `${scene.settings.duration}s`}</span>
        {running && (
          <div className="vw-card-running">
            <span>
              {running.status === 'processing' ? <LoaderCircle size={12} className="vw-spin" /> : <i className="status-dot queued" />}
              {running.status === 'processing' ? `${running.progress}%` : STATUS_LABEL.queued}
            </span>
            <div className="progress">
              <i style={{ width: `${running.progress}%` }} />
            </div>
          </div>
        )}
        {failed && !running && (
          <span className="vw-card-failed" title={failed.error ?? ''}>
            <TriangleAlert size={11} /> T{failed.number} lỗi
          </span>
        )}
        <div className="vw-card-hover">
          <button
            className="vw-card-play"
            title="Phát liền từ cảnh này"
            onClick={(e) => {
              e.stopPropagation()
              onPlay(index)
            }}
          >
            <Play size={18} fill="currentColor" />
          </button>
          <div className="vw-card-hover-actions">
            {show && (
              <button
                className="btn btn-sm"
                onClick={(e) => {
                  e.stopPropagation()
                  useUI.getState().openDialog({ kind: 'take', takeId: show.id })
                }}
              >
                <Eye size={12} /> Xem take
              </button>
            )}
            {show && (
              <button
                className="btn btn-sm"
                title={`Tải video ${code}_T${show.number}`}
                aria-label={`Tải video ${code} T${show.number}`}
                onClick={(e) => {
                  e.stopPropagation()
                  void downloadTake(show.id)
                }}
              >
                <Download size={12} /> Tải
              </button>
            )}
            <button
              className="btn btn-sm"
              disabled={!!runBlock}
              title={runBlock ? `Chưa chạy được: ${runBlock}` : 'Chạy cảnh này'}
              onClick={(e) => {
                e.stopPropagation()
                requestRun([scene.id])
              }}
            >
              <Play size={12} /> Chạy
            </button>
          </div>
        </div>
      </div>
      <div className="vw-card-body">
        <div className="vw-card-title">
          <i className={`status-dot ${latest?.status ?? ''}`} title={latest ? STATUS_LABEL[latest.status] : 'Chưa chạy'} />
          <span className={scene.title ? '' : 'faint'}>{scene.title || 'Chưa đặt tên'}</span>
          <span className="vw-card-grip" title={REORDER_TIP} aria-hidden="true">
            <GripVertical size={13} />
          </span>
        </div>
        <div className="vw-card-meta">
          <span>{settingsLabel(scene.settings)}</span>
          <span>
            {takeCount ? `${takeCount} take` : 'chưa có take'}
            {!starred && takeCount > 0 && <span className="vw-card-nostar"> · chưa ★</span>}
          </span>
        </div>
      </div>
    </div>
  )
})

/**
 * Where the dragged card will land, under the cards. 'full': a dashed slot in the gap the other cards opened (it glides
 * from slot to slot). 'reduced' / 'off' (cards stay put): an insertion bar in the gap beside the target card.
 */
function DropMarker({ target, motion }: { target: DropTarget; motion: MotionLevel }) {
  const { from, to, slots } = target
  const bar = motion === 'full' ? null : insertBar(slots, from, to)
  if (bar) return <div className="vw-sb-bar" style={{ transform: `translate(${bar.x}px, ${bar.y}px)`, height: bar.h }} aria-hidden="true" />
  const s = slots[to]
  if (!s) return null
  return <div className="vw-sb-slot" style={{ width: s.w, height: s.h, transform: `translate(${s.x}px, ${s.y}px)` }} aria-hidden="true" />
}

/** The code the dragged card will get, drawn above everything (the lifted card covers its slot). Hidden while it stays put. */
function DropCode({ target, motion }: { target: DropTarget; motion: MotionLevel }) {
  const { from, to, slots } = target
  const s = slots[to]
  if (!s || to === from) return null
  const bar = motion === 'full' ? null : insertBar(slots, from, to)
  return (
    <div className="vw-sb-dropcode" style={{ left: bar ? bar.x : s.x + s.w / 2, top: s.y }} aria-hidden="true">
      → {sceneCode(to + 1)}
    </div>
  )
}

const Kbd = ({ k }: { k: string }) => <span className="kbd">{k}</span>
