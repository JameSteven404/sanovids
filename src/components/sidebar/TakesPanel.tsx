import { Film, Link2, Star } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties, type DragEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { focusNodes, linkTakes, selectedTakeIds, takeLabel } from '../../actions'
import { takeCode } from '../../core/compile'
import type { Take } from '../../core/types'
import { cachedUrl } from '../../lib/imageStore'
import { useProject, type ProjectState } from '../../store/project'
import { useRuns } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { MediaImg } from '../common/Media'
import { Section } from './bits'
import { setDragGhost } from './ghost'
import { EMPTY_IDS, finishedTakes, matchesQuery, TAKE_MIME, takeSearchFields, usePrefState, useSceneCode, useSingleSceneId } from './shared'

const sceneOrderSelector = (s: ProjectState) => {
  const m: Record<string, number> = {}
  for (const sc of s.project.scenes) m[sc.id] = sc.order
  return m
}
const sceneTitleSelector = (s: ProjectState) => {
  const m: Record<string, string> = {}
  for (const sc of s.project.scenes) m[sc.id] = sc.title
  return m
}
const sceneColorSelector = (s: ProjectState) => {
  const m: Record<string, string> = {}
  for (const sc of s.project.scenes) if (sc.color) m[sc.id] = sc.color
  return m
}
/** Number of scenes using each take as a reference video (@video_N). */
const videoUsageSelector = (s: ProjectState) => {
  const m: Record<string, number> = {}
  for (const sc of s.project.scenes) for (const t of sc.videoRefs) m[t] = (m[t] ?? 0) + 1
  return m
}

// ---------------- actions ----------------
/** Dragging a selected take carries every selected finished take; otherwise just that one. */
function dragIdsFor(id: string): string[] {
  const sel = selectedTakeIds()
  if (!sel.includes(id)) return [id]
  const done = new Set(useRuns.getState().takes.filter((t) => t.status === 'completed').map((t) => t.id))
  const out = sel.filter((x) => done.has(x))
  return out.length ? out : [id]
}

function selectTake(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, id: string) {
  const ui = useUI.getState()
  if (e.ctrlKey || e.metaKey || e.shiftKey) {
    ui.select(ui.selectedIds.includes(id) ? ui.selectedIds.filter((x) => x !== id) : [...ui.selectedIds, id])
  } else {
    ui.select([id])
  }
  if (ui.view === 'canvas') focusNodes([id])
}

function openTake(id: string) {
  useUI.getState().openDialog({ kind: 'take', takeId: id })
}

async function copyToken(token: string, code: string) {
  try {
    await navigator.clipboard.writeText(token)
    toast(`Đã copy ${token} — dán vào prompt của ${code}.`, { tone: 'success' })
  } catch {
    toast('Trình duyệt chặn clipboard.', { tone: 'error' })
  }
}

// ---------------- row ----------------
interface RowProps {
  take: Take
  /** "S03·T2" */
  code: string
  sceneTitle: string
  /** Scene color (null = default video color). */
  color: string | null
  usage: number
  selected: boolean
  dragging: boolean
  /** Exactly one scene is selected: its id and code (else null / ''). */
  singleId: string | null
  singleCode: string
  /** This take's "@video_N" in the selected scene (null = not linked there). */
  token: string | null
  onDrag: (ids: string[] | null) => void
}

const VIDEO_COLOR = '#9d86f0'

const TakeRow = memo(function TakeRow({ take, code, sceneTitle, color, usage, selected, dragging, singleId, singleCode, token, onDrag }: RowProps) {
  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    const ids = dragIdsFor(take.id)
    const takes = useRuns.getState().takes
    e.dataTransfer.effectAllowed = 'all'
    e.dataTransfer.setData(TAKE_MIME, JSON.stringify(ids))
    e.dataTransfer.setData('text/plain', ids.map(takeLabel).join(', '))
    const items = ids.map((id) => {
      const t = takes.find((x) => x.id === id)
      return { url: cachedUrl(t?.posterId), letter: 'T' + (t?.number ?? ''), color: color ?? VIDEO_COLOR, shape: 'wide' as const }
    })
    setDragGhost(e, items, ids.length === 1 ? takeLabel(ids[0]) : `${ids.length} video`, true)
    onDrag(ids)
  }
  const usedTitle = usage ? `Đang là video tham chiếu ở ${usage} cảnh` : 'Chưa dùng làm video tham chiếu'
  return (
    <div
      className={`sb-take${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
      style={color ? ({ '--sb-c': color } as CSSProperties) : undefined}
      draggable
      role="option"
      tabIndex={0}
      aria-selected={selected}
      title={`${code}${sceneTitle ? ` · ${sceneTitle}` : ''}\n${usedTitle}\nKéo vào cảnh để dùng làm @video · nháy đúp để xem`}
      onClick={(e) => {
        e.stopPropagation()
        if (e.detail > 1) return
        selectTake(e, take.id)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        openTake(take.id)
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter') {
          e.preventDefault()
          openTake(take.id)
        } else if (e.key === ' ') {
          e.preventDefault()
          selectTake(e, take.id)
        }
      }}
      onDragStart={onDragStart}
      onDragEnd={() => onDrag(null)}
    >
      <div className="sb-take-media">
        {take.posterId ? <MediaImg id={take.posterId} alt={code} className="media-img sb-take-img" /> : <span className="sb-take-noposter">T{take.number}</span>}
        <span className="sb-take-dur">{take.settings.duration}s</span>
      </div>
      <div className="sb-take-info">
        <div className="sb-take-top">
          <span className="sb-take-code mono">{code}</span>
          {usage > 0 && (
            <span className="sb-take-used" title={usedTitle}>
              <Link2 size={10} />
              {usage}
            </span>
          )}
        </div>
        <div className="sb-take-title">{sceneTitle || <span className="faint">Chưa đặt tên</span>}</div>
      </div>
      {singleId &&
        (token ? (
          <button
            className="sb-token video"
            title={`${token} trong ${singleCode} · bấm để copy`}
            onClick={(e) => {
              e.stopPropagation()
              void copyToken(token, singleCode)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {token}
          </button>
        ) : (
          take.sceneId !== singleId && (
            <button
              className="sb-connect video"
              title={`Dùng ${code} làm video tham chiếu (@video) cho ${singleCode}`}
              onClick={(e) => {
                e.stopPropagation()
                linkTakes([singleId], [take.id])
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              + Nối
            </button>
          )
        ))}
      <button
        className={`sb-take-star${take.starred ? ' on' : ''}`}
        title={take.starred ? 'Bỏ chọn take này' : 'Chọn take này (★)'}
        aria-pressed={take.starred}
        onClick={(e) => {
          e.stopPropagation()
          useRuns.getState().toggleStar(take.id)
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Star size={12} fill={take.starred ? 'currentColor' : 'none'} />
      </button>
    </div>
  )
})

// ---------------- panel ----------------
/** "Video đã tạo": finished takes of the project, newest first, draggable onto scenes as @video references. */
export function TakesPanel({ query, collapsed, onToggle }: { query: string; collapsed: boolean; onToggle: () => void }) {
  const orders = useProject(useShallow(sceneOrderSelector))
  const titles = useProject(useShallow(sceneTitleSelector))
  const colors = useProject(useShallow(sceneColorSelector))
  const usage = useProject(useShallow(videoUsageSelector))
  const singleId = useSingleSceneId()
  const singleCode = useSceneCode(singleId)
  /** Same array object while only the prompt changes. */
  const singleVideoRefs = useProject((s) => (singleId ? s.project.scenes.find((sc) => sc.id === singleId)?.videoRefs ?? EMPTY_IDS : EMPTY_IDS))
  const sceneIds = useMemo(() => new Set(Object.keys(orders)), [orders])
  const takes = useRuns(useShallow((s) => finishedTakes(s.takes, sceneIds)))
  const selectedIds = useUI((s) => s.selectedIds)
  const selSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const [starredOnly, setStarredOnly] = usePrefState('sb-takes-starred', false)
  const [dragging, setDragging] = useState<string[] | null>(null)
  const dragSet = useMemo(() => new Set(dragging ?? EMPTY_IDS), [dragging])
  const onDrag = useCallback((ids: string[] | null) => setDragging(ids), [])

  const visible = useMemo(
    () =>
      takes.filter((t) => (!starredOnly || t.starred) && matchesQuery(query, ...takeSearchFields(orders[t.sceneId], t.number, titles[t.sceneId]))),
    [takes, starredOnly, query, orders, titles],
  )
  const filtered = !!query.trim() || starredOnly

  // A row that unmounts mid-drag (list re-sorted, filtered) never gets its dragend: clear on the next press.
  useEffect(() => {
    if (!dragging) return
    const clear = () => setDragging(null)
    window.addEventListener('pointerdown', clear, { once: true, capture: true })
    return () => window.removeEventListener('pointerdown', clear, { capture: true })
  }, [dragging])

  return (
    <Section
      className="sb-takes"
      title="Video đã tạo"
      icon={<Film size={14} />}
      count={filtered ? `${visible.length}/${takes.length}` : takes.length}
      collapsed={collapsed}
      onToggle={onToggle}
      grow={2}
      actions={
        takes.length > 0 && (
          <button
            className={`icon-btn sb-xs sb-star-filter${starredOnly ? ' active' : ''}`}
            title={starredOnly ? 'Đang chỉ hiện take đã chọn ★ — bấm để hiện tất cả' : 'Chỉ hiện take đã chọn ★'}
            aria-pressed={starredOnly}
            onClick={() => setStarredOnly(!starredOnly)}
          >
            <Star size={13} fill={starredOnly ? 'currentColor' : 'none'} />
          </button>
        )
      }
      toolbar={
        singleId && takes.length > 0 ? (
          <div className="sb-explain">
            Số <span className="sb-tok video">@video</span> trong <b className="sb-accent">{singleCode}</b> · bấm số để copy, <b>+ Nối</b> để thêm.
          </div>
        ) : undefined
      }
      footer={takes.length ? <div className="sb-libfoot hint">Kéo video vào cảnh để dùng làm @video · nháy đúp để xem</div> : undefined}
    >
      {!takes.length ? (
        <div className="empty sb-empty">
          <div>Chưa có video nào tạo xong.</div>
          <div className="faint">Chạy một cảnh (▶). Video xong sẽ hiện ở đây để kéo vào cảnh khác làm @video.</div>
        </div>
      ) : !visible.length ? (
        <div className="empty sb-empty">
          {query.trim() ? `Không có video nào khớp “${query.trim()}”${starredOnly ? ' trong các take đã chọn ★' : ''}.` : 'Chưa có take nào được chọn ★.'}
        </div>
      ) : (
        <div className="sb-take-list" role="listbox" aria-multiselectable="true" aria-label="Video đã tạo">
          {visible.map((t) => (
            <TakeRow
              key={t.id}
              take={t}
              code={takeCode(orders[t.sceneId], t.number)}
              sceneTitle={titles[t.sceneId] ?? ''}
              color={colors[t.sceneId] ?? null}
              usage={usage[t.id] ?? 0}
              selected={selSet.has(t.id)}
              dragging={dragSet.has(t.id)}
              singleId={singleId}
              singleCode={singleCode}
              token={singleId && singleVideoRefs.includes(t.id) ? `@video_${singleVideoRefs.indexOf(t.id) + 1}` : null}
              onDrag={onDrag}
            />
          ))}
        </div>
      )}
    </Section>
  )
}
