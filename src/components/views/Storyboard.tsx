import { CirclePlay, Clapperboard, Eye, LoaderCircle, Play, Plus, Star, TriangleAlert } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { newScene, requestRun } from '../../actions'
import { sceneCode } from '../../core/compile'
import { settingsLabel } from '../../core/models'
import type { Scene, Take } from '../../core/types'
import { sortedScenes, useProject } from '../../store/project'
import { useUI } from '../../store/ui'
import { MediaImg } from '../common/Media'
import { formatRuntime, latestOf, pickShowcaseTake, STATUS_LABEL, starredTake, useTakesByScene } from './shared'
import { StoryboardPlayer, type PlayerItem } from './StoryboardPlayer'
import './views.css'

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

  const cards: CardData[] = useMemo(
    () =>
      scenes.map((scene) => {
        const list = byScene.get(scene.id) ?? []
        return { scene, show: pickShowcaseTake(list), latest: latestOf(list), starred: starredTake(list), takeCount: list.length }
      }),
    [scenes, byScene],
  )

  const starredRuntime = cards.reduce((t, c) => t + (c.starred?.settings.duration ?? 0), 0)
  const plannedRuntime = cards.reduce((t, c) => t + c.scene.settings.duration, 0)
  const missing = cards.filter((c) => !c.starred)

  const items: PlayerItem[] = useMemo(
    () =>
      cards.map((c) => ({
        sceneId: c.scene.id,
        code: sceneCode(c.scene.order),
        title: c.scene.title,
        take: c.show ?? null,
        duration: c.show?.settings.duration ?? c.scene.settings.duration,
      })),
    [cards],
  )

  const onSelect = useCallback((id: string, additive: boolean) => {
    const ui = useUI.getState()
    if (additive) ui.select(ui.selectedIds.includes(id) ? ui.selectedIds.filter((x) => x !== id) : [...ui.selectedIds, id])
    else ui.select([id])
  }, [])

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
    <div className="vw-root vw-sb-root">
      <div className="vw-head">
        <div className="vw-head-title">
          <h2>Storyboard</h2>
          <span className="badge">{scenes.length} cảnh</span>
          <span className="vw-sb-stat" title="Tổng thời lượng các take được đánh dấu ★ / tổng thời lượng dự kiến của mọi cảnh">
            <Star size={12} className="vw-star-ico" /> Thời lượng take chọn <b>{formatRuntime(starredRuntime)}</b>
            <span className="faint"> / {formatRuntime(plannedRuntime)} dự kiến</span>
          </span>
        </div>
        <div className="vw-head-actions">
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

      <div className="vw-sb-scroll">
        <div className="vw-sb-grid" ref={gridRef}>
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
              flash={flashId === c.scene.id}
              onSelect={onSelect}
              onPlay={onPlay}
            />
          ))}
        </div>
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
  flash,
  onSelect,
  onPlay,
}: CardData & {
  index: number
  selected: boolean
  flash: boolean
  onSelect: (id: string, additive: boolean) => void
  onPlay: (index: number) => void
}) {
  const code = sceneCode(scene.order)
  const running = latest && (latest.status === 'processing' || latest.status === 'queued') ? latest : undefined
  const failed = latest?.status === 'failed' ? latest : undefined
  const accent = scene.color ?? 'var(--accent)'

  return (
    <div
      data-card={scene.id}
      className={`vw-card ${selected ? 'selected' : ''} ${flash ? 'flash' : ''}`}
      onClick={(e) => onSelect(scene.id, e.ctrlKey || e.metaKey || e.shiftKey)}
      onDoubleClick={() => show && useUI.getState().openDialog({ kind: 'take', takeId: show.id })}
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
        <span className="vw-card-dur">{(show?.settings ?? scene.settings).duration}s</span>
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
            <button
              className="btn btn-sm"
              disabled={!scene.prompt.trim()}
              title={scene.prompt.trim() ? 'Chạy cảnh này' : 'Prompt trống'}
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
