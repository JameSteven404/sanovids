import { Download, FileArchive, Film, Link2, LoaderCircle, Star } from 'lucide-react'
import { memo, useEffect, useMemo, useState, type CSSProperties, type DragEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { downloadChosenTakesZip, downloadTake, focusNodes, linkTakes, selectedTakeIds, takeLabel } from '../../actions'
import { sceneCode, takeCode } from '../../core/compile'
import { modeLabel } from '../../core/models'
import type { Take } from '../../core/types'
import { TAKES_MIME } from '../../lib/dnd'
import { useDownloadPrefs } from '../../lib/downloads'
import { cachedUrl } from '../../lib/imageStore'
import { useProject, type ProjectState } from '../../store/project'
import { useRuns } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { MediaImg } from '../common/Media'
import { Section } from './bits'
import { setDragGhost } from './ghost'
import {
  EMPTY_IDS,
  finishedTakes,
  matchesQuery,
  takeHiddenOnCanvas,
  takeSearchFields,
  usePrefState,
  useSceneCode,
  useSceneMediaFlags,
  useSingleSceneId,
} from './shared'

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

/** Drag-ghost thumbnail fill for a take of a scene without its own color (the ghost lives in <body>: tokens apply). */
const VIDEO_COLOR = 'var(--video)'

// ---------------- actions ----------------
/** Dragging a selected take carries every selected finished take; otherwise just that one. */
function dragIdsFor(id: string): string[] {
  const sel = selectedTakeIds()
  if (!sel.includes(id)) return [id]
  const done = new Set(useRuns.getState().takes.filter((t) => t.status === 'completed').map((t) => t.id))
  const out = sel.filter((x) => done.has(x))
  return out.length ? out : [id]
}

/** HTML5 drag of finished videos: TAKES_MIME payload + ghost; `ui.draggingTakeIds` lets drop targets light up. */
function startTakeDrag(e: DragEvent<HTMLElement>, takeId: string, color: string | null) {
  const ids = dragIdsFor(takeId)
  const takes = useRuns.getState().takes
  e.dataTransfer.effectAllowed = 'all'
  e.dataTransfer.setData(TAKES_MIME, JSON.stringify(ids))
  e.dataTransfer.setData('text/plain', ids.map(takeLabel).join(', '))
  const items = ids.map((id) => {
    const t = takes.find((x) => x.id === id)
    return { url: cachedUrl(t?.posterId), letter: 'T' + (t?.number ?? ''), color: color ?? VIDEO_COLOR, shape: 'wide' as const }
  })
  setDragGhost(e, items, ids.length === 1 ? takeLabel(ids[0]) : `${ids.length} video`, true)
  useUI.getState().setDraggingTakes(ids)
}

function endTakeDrag() {
  useUI.getState().setDraggingTakes(null)
}

/**
 * Select a finished video (its node on the canvas). When the canvas shows only the chosen take of each scene
 * ("Chỉ take chọn") and this one is hidden there, select its scene instead — same as the queue's "Đi tới" — so the
 * selection never holds an invisible node (that Delete would then act on). "Chỉ take chọn" only filters the canvas:
 * the other views show every take, so there the take itself is selected.
 */
function selectTake(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, id: string) {
  const ui = useUI.getState()
  const take = useRuns.getState().takes.find((t) => t.id === id)
  const scenes = useProject.getState().project.scenes
  const scene = take ? scenes.find((s) => s.id === take.sceneId) : undefined
  const hidden = ui.view === 'canvas' && !!take && !!scene && takeHiddenOnCanvas(id, useRuns.getState().takes, scenes, ui.takeDisplay)
  const target = hidden ? scene!.id : id
  if (e.ctrlKey || e.metaKey || e.shiftKey) {
    ui.select(ui.selectedIds.includes(target) ? ui.selectedIds.filter((x) => x !== target) : [...ui.selectedIds, target])
  } else {
    ui.select([target])
  }
  if (hidden) toast(`${takeCode(scene!.order, take!.number)} đang ẩn (canvas chỉ hiện take chọn) — đã chọn cảnh ${sceneCode(scene!.order)}.`)
  if (ui.view === 'canvas') focusNodes([target])
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

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

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
  /** The selected scene's model / mode accepts reference videos (false: "+ Nối" can only fail, @video does nothing). */
  sendsVideos: boolean
  /** "MiniMax-H3": model of that scene, for the explanations. */
  sceneModel: string
  /** What the download button saves and where, e.g. "video + prompt .txt → thư mục “Phim”". */
  saveHint: string
}

const TakeRow = memo(function TakeRow({
  take,
  code,
  sceneTitle,
  color,
  usage,
  selected,
  dragging,
  singleId,
  singleCode,
  token,
  sendsVideos,
  sceneModel,
  saveHint,
}: RowProps) {
  const [saving, setSaving] = useState(false)
  const download = () => {
    if (saving) return
    setSaving(true)
    void downloadTake(take.id).finally(() => setSaving(false))
  }
  const usedTitle = usage ? `Đang là video tham chiếu ở ${usage} cảnh` : 'Chưa dùng làm video tham chiếu'
  const offNote = `${sceneModel || 'Model'} ở chế độ hiện tại của ${singleCode} không nhận video tham chiếu`
  /** @video number / "+ Nối" for the single selected scene (under the code, so the row never overflows). */
  const pill = !singleId ? null : token ? (
    sendsVideos ? (
      <button
        key="tok"
        className="sb-token video"
        title={`${token} trong ${singleCode} · bấm để copy`}
        onClick={(e) => {
          e.stopPropagation()
          // 2nd click of a double-click on "+ Nối": this button replaced it under the pointer.
          if (e.detail > 1) return
          void copyToken(token, singleCode)
        }}
        onDoubleClick={stop}
      >
        {token}
      </button>
    ) : (
      <span key="off" className="sb-token video off" title={`${token} trong ${singleCode} — ${offNote}, số này chưa có tác dụng.`}>
        {token}
      </span>
    )
  ) : take.sceneId === singleId ? null : (
    <button
      key="link"
      className={`sb-connect video${sendsVideos ? '' : ' off'}`}
      title={sendsVideos ? `Dùng ${code} làm video tham chiếu (@video) cho ${singleCode}` : `Không nối được: ${offNote}.`}
      aria-disabled={!sendsVideos}
      onClick={(e) => {
        e.stopPropagation()
        if (e.detail > 1) return
        if (sendsVideos) linkTakes([singleId], [take.id])
        else toast(`Không nối được: ${offNote}. Dùng Seedance 2.5, hoặc chế độ “${modeLabel('i2v', 'minimax_h3')}” của MiniMax-H3.`, { tone: 'warning' })
      }}
      onDoubleClick={stop}
    >
      + Nối
    </button>
  )
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
      onDragStart={(e) => startTakeDrag(e, take.id, color)}
      onDragEnd={endTakeDrag}
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
        <div className="sb-take-sub">
          {pill}
          <span className="sb-take-title">{sceneTitle || <span className="faint">Chưa đặt tên</span>}</span>
        </div>
      </div>
      <button
        className={`sb-take-btn sb-take-dl${saving ? ' busy' : ''}`}
        title={saving ? `Đang lưu ${code}…` : `Tải ${code} (${saveHint})`}
        aria-label={`Tải video ${code}`}
        aria-busy={saving}
        disabled={saving}
        onClick={(e) => {
          e.stopPropagation()
          download()
        }}
        onDoubleClick={stop}
      >
        {saving ? <LoaderCircle size={12} className="sb-spin" /> : <Download size={12} />}
      </button>
      <button
        className={`sb-take-btn sb-take-star${take.starred ? ' on' : ''}`}
        title={take.starred ? 'Bỏ chọn take này' : 'Chọn take này (★)'}
        aria-pressed={take.starred}
        onClick={(e) => {
          e.stopPropagation()
          useRuns.getState().toggleStar(take.id)
        }}
        onDoubleClick={stop}
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
  const media = useSceneMediaFlags(singleId)
  /** Same array object while only the prompt changes. */
  const singleVideoRefs = useProject((s) => (singleId ? s.project.scenes.find((sc) => sc.id === singleId)?.videoRefs ?? EMPTY_IDS : EMPTY_IDS))
  const sceneIds = useMemo(() => new Set(Object.keys(orders)), [orders])
  const takes = useRuns(useShallow((s) => finishedTakes(s.takes, sceneIds)))
  const selectedIds = useUI((s) => s.selectedIds)
  const selSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const [starredOnly, setStarredOnly] = usePrefState('sb-takes-starred', false)
  /** Takes being dragged anywhere in the app (this list, the take strips): shown dimmed here. */
  const dragging = useUI((s) => s.draggingTakeIds)
  const dragSet = useMemo(() => new Set(dragging ?? EMPTY_IDS), [dragging])
  const withPrompt = useDownloadPrefs((s) => s.withPrompt)
  const folderName = useDownloadPrefs((s) => s.folderName)
  const folderHint = folderName ? ` → thư mục “${folderName}”` : ''
  const saveHint = `${withPrompt ? 'video + prompt .txt' : 'video'}${folderHint}`
  /** One chosen take per scene that has a finished video (= what the .zip contains). */
  const chosenCount = useMemo(() => new Set(takes.map((t) => t.sceneId)).size, [takes])
  const [zipping, setZipping] = useState(false)

  const visible = useMemo(
    () =>
      takes.filter((t) => (!starredOnly || t.starred) && matchesQuery(query, ...takeSearchFields(orders[t.sceneId], t.number, titles[t.sceneId]))),
    [takes, starredOnly, query, orders, titles],
  )
  const filtered = !!query.trim() || starredOnly

  // A row that unmounts mid-drag (take deleted, list filtered) never gets its dragend. No pointerdown can happen
  // during an HTML5 drag, so the next press after it ends clears the stale state (only if it is still that drag).
  useEffect(() => {
    if (!dragging) return
    const clear = () => {
      if (useUI.getState().draggingTakeIds === dragging) useUI.getState().setDraggingTakes(null)
    }
    window.addEventListener('pointerdown', clear, { once: true, capture: true })
    return () => window.removeEventListener('pointerdown', clear, { capture: true })
  }, [dragging])

  const zipAll = async () => {
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
  const zipTitle = zipping
    ? 'Đang nén video…'
    : `Tải tất cả video chọn (.zip) · ${chosenCount} video: take ★ của mỗi cảnh (chưa có ★ thì take mới nhất), theo thứ tự cảnh, kèm prompts.txt${folderHint}`

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
          <>
            <button
              className={`icon-btn sb-xs sb-zip-all${zipping ? ' busy' : ''}`}
              title={zipTitle}
              aria-label="Tải tất cả video chọn (.zip)"
              aria-busy={zipping}
              disabled={zipping}
              onClick={() => void zipAll()}
            >
              {zipping ? <LoaderCircle size={13} className="sb-spin" /> : <FileArchive size={13} />}
            </button>
            <button
              className={`icon-btn sb-xs sb-star-filter${starredOnly ? ' active' : ''}`}
              title={starredOnly ? 'Đang chỉ hiện take đã chọn ★ — bấm để hiện tất cả' : 'Chỉ hiện take đã chọn ★'}
              aria-pressed={starredOnly}
              onClick={() => setStarredOnly(!starredOnly)}
            >
              <Star size={13} fill={starredOnly ? 'currentColor' : 'none'} />
            </button>
          </>
        )
      }
      toolbar={
        singleId && takes.length > 0 ? (
          media.videos ? (
            <div className="sb-explain">
              Số <span className="sb-tok video">@video</span> trong <b className="sb-accent">{singleCode}</b> · bấm số để copy, <b>+ Nối</b> để thêm.
            </div>
          ) : (
            <div
              className="sb-explain warn"
              title={`${media.model} ở chế độ hiện tại của ${singleCode} không nhận video tham chiếu (@video). Dùng Seedance 2.5, hoặc chế độ “${modeLabel('i2v', 'minimax_h3')}” của MiniMax-H3.`}
            >
              <b className="sb-accent">{singleCode}</b> ({media.model}) ở chế độ này không nhận video <span className="sb-tok video off">@video</span>.
            </div>
          )
        ) : undefined
      }
      footer={takes.length ? <div className="sb-libfoot hint">Kéo video vào cảnh để dùng làm @video · nháy đúp để xem · ⬇ để tải</div> : undefined}
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
              sendsVideos={media.videos}
              sceneModel={media.model}
              saveHint={saveHint}
            />
          ))}
        </div>
      )}
    </Section>
  )
}
