import {
  Ban,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Copy,
  Download,
  FileDiff,
  Image as ImageIcon,
  LoaderCircle,
  LocateFixed,
  RotateCcw,
  Star,
  Trash,
  Undo2,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { focusNodes, restoreFromTake, runNow } from '../../actions'
import { compileScene, sceneCode } from '../../core/compile'
import { MODE_LABEL, MODELS, settingsLabel } from '../../core/models'
import type { Asset, Scene, Take } from '../../core/types'
import { deleteMedia, useMediaUrl } from '../../lib/imageStore'
import { useProject } from '../../store/project'
import { useRuns, useSceneTakes } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { AssetChip } from '../common/Media'
import { Modal } from '../common/Modal'
import { TakeStrip } from './TakeStrip'
import {
  downloadMedia,
  formatClock,
  formatDuration,
  HighlightedPrompt,
  isActive,
  isTypingTarget,
  paragraphDiff,
  sameSettings,
  StatusBadge,
  toggleChosenTake,
  useNow,
} from './shared'
import './runs.css'

/** Modal to watch a take and compare / restore the prompt it was generated with. */
export function TakeViewer({ takeId }: { takeId: string }) {
  const close = useUI((s) => s.closeDialog)
  const take = useRuns((s) => s.takes.find((t) => t.id === takeId))
  if (!take) {
    return (
      <Modal title="Take" onClose={close}>
        <div className="empty">Take này không còn tồn tại (có thể đã bị xoá).</div>
      </Modal>
    )
  }
  return <TakeViewerInner take={take} onClose={close} />
}

function openTake(id: string) {
  useUI.getState().openDialog({ kind: 'take', takeId: id })
}

function TakeViewerInner({ take, onClose }: { take: Take; onClose: () => void }) {
  const scene = useProject((s) => s.project.scenes.find((x) => x.id === take.sceneId))
  const siblings = useSceneTakes(take.sceneId)
  const sorted = useMemo(() => [...siblings].sort((a, b) => a.number - b.number), [siblings])
  const idx = sorted.findIndex((t) => t.id === take.id)
  const prev = idx > 0 ? sorted[idx - 1] : undefined
  const next = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : undefined
  const code = scene ? sceneCode(scene.order) : 'S??'
  const label = `${code} · T${take.number}`

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'ArrowLeft' && prev) {
        e.preventDefault()
        openTake(prev.id)
      } else if (e.key === 'ArrowRight' && next) {
        e.preventDefault()
        openTake(next.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next])

  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => {
    setConfirmDelete(false)
  }, [take.id])
  useEffect(() => {
    if (!confirmDelete) return
    const id = setTimeout(() => setConfirmDelete(false), 3500)
    return () => clearTimeout(id)
  }, [confirmDelete])

  const remove = () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    const neighbour = next ?? prev
    useRuns.getState().removeTake(take.id)
    if (take.posterId) void deleteMedia(take.posterId)
    if (take.videoId) void deleteMedia(take.videoId)
    toast(`Đã xoá ${label}.`)
    if (neighbour) openTake(neighbour.id)
    else onClose()
  }

  const rerun = () => {
    const res = runNow([take.sceneId])
    if (res.error) return
    // Follow the new take so its progress (then video) shows right here.
    const newest = useRuns
      .getState()
      .takes.filter((t) => t.sceneId === take.sceneId)
      .sort((a, b) => b.number - a.number)[0]
    if (newest && newest.id !== take.id) openTake(newest.id)
  }

  const download = async (which: 'video' | 'poster') => {
    const id = which === 'video' ? take.videoId : take.posterId
    if (!id) return
    const ok = await downloadMedia(id, `${code}_T${take.number}`, which === 'video' ? 'webm' : 'jpg')
    if (!ok) toast('Không tìm thấy file trong bộ nhớ trình duyệt.', { tone: 'error' })
  }

  const gotoScene = () => {
    if (!scene) return
    onClose()
    useUI.getState().select([scene.id])
    focusNodes([scene.id])
  }

  return (
    <Modal
      size="xwide"
      onClose={onClose}
      title={
        <span className="rq-tv-title">
          <span className="mono">{label}</span>
          <span className={`rq-tv-scene${scene?.title ? '' : ' faint'}`}>{scene ? scene.title || 'Chưa đặt tên' : 'Cảnh đã bị xoá'}</span>
        </span>
      }
      headerExtra={
        <span className="rq-tv-nav">
          <button type="button" className="icon-btn" disabled={!prev} onClick={() => prev && openTake(prev.id)} title="Take trước (←)" aria-label="Take trước">
            <ChevronLeft size={16} />
          </button>
          <span className="mono faint">
            {idx + 1}/{sorted.length}
          </span>
          <button type="button" className="icon-btn" disabled={!next} onClick={() => next && openTake(next.id)} title="Take sau (→)" aria-label="Take sau">
            <ChevronRight size={16} />
          </button>
        </span>
      }
      footer={
        <>
          <button type="button" className={`btn btn-danger${confirmDelete ? ' rq-confirming' : ''}`} onClick={remove}>
            <Trash size={14} />
            {confirmDelete ? 'Bấm lần nữa để xoá' : 'Xoá take'}
          </button>
          <span className="rq-spacer" />
          {take.posterId && (
            <button type="button" className="btn btn-ghost" onClick={() => void download('poster')} title={`Tải ảnh poster ${code}_T${take.number}`}>
              <ImageIcon size={14} />
              Poster
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={!take.videoId && !take.posterId}
            onClick={() => void download(take.videoId ? 'video' : 'poster')}
            title={take.videoId ? `Tải ${code}_T${take.number}.webm` : 'Take này chưa có video — tải ảnh poster'}
          >
            <Download size={14} />
            Tải về
          </button>
          <button
            type="button"
            className="btn"
            disabled={!scene}
            onClick={() => restoreFromTake(take.id)}
            title="Đưa prompt, tham chiếu và cấu hình của cảnh về đúng như lúc chạy take này"
          >
            <Undo2 size={14} />
            Khôi phục prompt này
          </button>
          <button type="button" className="btn btn-primary" disabled={!scene} onClick={rerun} title="Chạy lại cảnh với prompt hiện tại">
            <RotateCcw size={14} />
            Chạy lại
          </button>
        </>
      }
    >
      <div className="rq-tv">
        <div className="rq-tv-left">
          <Stage take={take} onRerun={scene ? rerun : undefined} />
          <div className="rq-tv-strip">
            <div className="section-title">
              <span>Các take của cảnh</span>
              <span className="faint">← → để chuyển</span>
            </div>
            <TakeStrip sceneId={take.sceneId} size="md" activeTakeId={take.id} />
          </div>
        </div>
        <div className="rq-tv-right">
          <Details take={take} scene={scene} onGoto={gotoScene} />
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------------------------------

function Stage({ take, onRerun }: { take: Take; onRerun?: () => void }) {
  const videoUrl = useMediaUrl(take.videoId)
  const posterUrl = useMediaUrl(take.posterId)
  const active = isActive(take)
  const now = useNow(active)

  let content: ReactNode
  if (take.status === 'completed' && videoUrl) {
    content = <video key={videoUrl} className="rq-video" src={videoUrl} poster={posterUrl ?? undefined} autoPlay muted loop controls playsInline />
  } else if (take.status === 'completed') {
    content = (
      <>
        {posterUrl ? <img className="rq-video" src={posterUrl} alt="" draggable={false} /> : null}
        {!take.videoId && <span className="rq-stage-note">Không có video (trình duyệt không ghi được) — đang hiện ảnh poster.</span>}
      </>
    )
  } else if (active) {
    const pct = take.status === 'processing' ? take.progress : 0
    content = (
      <div className="rq-stage-state">
        <div className="rq-ring" style={{ ['--p' as string]: pct }}>
          <span className="mono">{take.status === 'processing' ? `${pct}%` : '…'}</span>
        </div>
        <div className="rq-stage-msg">{take.status === 'processing' ? 'Đang tạo video (demo)…' : 'Đang chờ trong hàng đợi…'}</div>
        <div className="faint mono">
          {take.status === 'processing' ? 'đã chạy ' : 'đã chờ '}
          {formatDuration(take.status === 'processing' && take.startedAt ? now - take.startedAt : now - take.createdAt)}
        </div>
        <button type="button" className="btn btn-sm" onClick={() => useRuns.getState().cancel(take.id)}>
          <CircleStop size={13} />
          Huỷ job · hoàn {take.cost} credit
        </button>
      </div>
    )
  } else if (take.status === 'failed') {
    content = (
      <div className="rq-stage-state danger">
        <CircleAlert size={34} />
        <div className="rq-stage-msg">Tạo video thất bại</div>
        <div className="muted">{take.error ?? 'Lỗi không rõ.'}</div>
        <div className="faint">Đã hoàn {take.cost} credit.</div>
        {onRerun && (
          <button type="button" className="btn btn-sm" onClick={onRerun}>
            <RotateCcw size={13} />
            Thử lại
          </button>
        )}
      </div>
    )
  } else {
    content = (
      <div className="rq-stage-state">
        <Ban size={30} />
        <div className="rq-stage-msg">Job đã huỷ</div>
        <div className="faint">Đã hoàn {take.cost} credit.</div>
        {onRerun && (
          <button type="button" className="btn btn-sm" onClick={onRerun}>
            <RotateCcw size={13} />
            Chạy lại
          </button>
        )}
      </div>
    )
  }

  return (
    <div className={`rq-stage ${take.status}`}>
      {content}
      {take.starred && <span className="rq-stage-star">★ Take đã chọn</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------

function Details({ take, scene, onGoto }: { take: Take; scene: Scene | undefined; onGoto: () => void }) {
  const project = useProject((s) => s.project)
  const assets = project.assets
  const current = useMemo(() => (scene ? compileScene(project, scene) : null), [project, scene])
  const [showDiff, setShowDiff] = useState(false)
  const spec = MODELS[take.settings.model]
  const refunded = take.status === 'failed' || take.status === 'cancelled'

  const refAssets = useMemo(() => {
    const map = new Map(assets.map((a) => [a.id, a]))
    const found: Asset[] = []
    let missing = 0
    for (const id of take.refsSnapshot) {
      const a = map.get(id)
      if (a) found.push(a)
      else missing++
    }
    return { found, missing }
  }, [assets, take.refsSnapshot])

  const changes = useMemo(() => {
    if (!scene || !current) return null
    const promptChanged = current.text !== take.promptSnapshot
    const settingsChanged = !sameSettings(scene.settings, take.settings)
    const tagOf = (id: string) => '@' + (assets.find((a) => a.id === id)?.tag ?? '?')
    const refsAdded = scene.refs.filter((id) => !take.refsSnapshot.includes(id)).map(tagOf)
    const refsRemoved = take.refsSnapshot.filter((id) => !scene.refs.includes(id)).map(tagOf)
    const refsReordered = !refsAdded.length && !refsRemoved.length && scene.refs.join('|') !== take.refsSnapshot.join('|')
    const diff = promptChanged ? paragraphDiff(take.promptSnapshot, current.text) : { removed: [], added: [] }
    const any = promptChanged || settingsChanged || refsAdded.length > 0 || refsRemoved.length > 0 || refsReordered
    return { promptChanged, settingsChanged, refsAdded, refsRemoved, refsReordered, diff, any }
  }, [scene, current, take, assets])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(take.promptSnapshot)
      toast(`Đã copy prompt của T${take.number} (${[...take.promptSnapshot].length.toLocaleString('vi-VN')} ký tự).`, { tone: 'success' })
    } catch {
      toast('Trình duyệt chặn clipboard. Hãy bôi đen và copy thủ công.', { tone: 'error' })
    }
  }

  return (
    <div className="rq-details">
      <div className="rq-details-head">
        <StatusBadge take={take} />
        <button
          type="button"
          className={`btn btn-sm rq-star-btn${take.starred ? ' on' : ''}`}
          disabled={take.status !== 'completed' && !take.starred}
          onClick={() => toggleChosenTake(take.id)}
          title={take.starred ? 'Bỏ chọn take này' : 'Đánh dấu là take dùng cho cảnh (Storyboard sẽ ưu tiên)'}
        >
          <Star size={13} fill={take.starred ? 'currentColor' : 'none'} />
          {take.starred ? 'Đã chọn' : 'Chọn take này'}
        </button>
        <span className="rq-spacer" />
        <button type="button" className="btn btn-ghost btn-sm" disabled={!scene} onClick={onGoto} title="Chọn cảnh và đưa canvas tới đó">
          <LocateFixed size={13} />
          Đi tới cảnh
        </button>
      </div>

      <dl className="rq-info">
        <dt>Model</dt>
        <dd>
          <span className="rq-model">
            <i style={{ background: spec?.color }} />
            {spec?.name ?? take.settings.model}
          </span>
          <span className="faint"> · {MODE_LABEL[take.settings.mode]}</span>
        </dd>
        <dt>Cấu hình</dt>
        <dd className="mono">{settingsLabel(take.settings)}</dd>
        <dt>Chi phí</dt>
        <dd>
          <span className={`mono${refunded ? ' rq-struck' : ''}`}>{take.cost} credit</span>
          {refunded && <span className="faint"> · đã hoàn</span>}
        </dd>
        <dt>Tạo lúc</dt>
        <dd className="mono">{formatClock(take.createdAt)}</dd>
        <dt>Bắt đầu</dt>
        <dd className="mono">
          {formatClock(take.startedAt)}
          {take.startedAt ? <span className="faint"> · chờ {formatDuration(take.startedAt - take.createdAt)}</span> : null}
        </dd>
        <dt>Kết thúc</dt>
        <dd className="mono">
          {formatClock(take.finishedAt)}
          {take.startedAt && take.finishedAt ? <span className="faint"> · tạo trong {formatDuration(take.finishedAt - take.startedAt)}</span> : null}
        </dd>
        {take.error && take.status === 'failed' && (
          <>
            <dt>Lỗi</dt>
            <dd className="rq-err-text">{take.error}</dd>
          </>
        )}
      </dl>

      <div className="rq-sec">
        <div className="section-title">
          <span>Tham chiếu lúc chạy</span>
          <span className="faint">{take.refsSnapshot.length}</span>
        </div>
        {refAssets.found.length ? (
          <div className="rq-chips">
            {refAssets.found.map((a, i) => (
              <AssetChip key={a.id} asset={a} index={i + 1} />
            ))}
          </div>
        ) : (
          <div className="faint rq-small">Không có tham chiếu.</div>
        )}
        {refAssets.missing > 0 && <div className="faint rq-small">{refAssets.missing} mục đã bị xoá khỏi thư viện.</div>}
      </div>

      <div className="rq-sec rq-sec-prompt">
        <div className="section-title">
          <span>Prompt đã gửi</span>
          <span className="rq-sec-actions">
            <span className="faint mono">{[...take.promptSnapshot].length.toLocaleString('vi-VN')} ký tự</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>
              <Copy size={12} />
              Copy
            </button>
          </span>
        </div>

        {!scene ? (
          <div className="rq-diff-flag muted">Cảnh đã bị xoá — không so sánh được.</div>
        ) : changes?.any ? (
          <div className="rq-diff-flag warn">
            <span className="badge warn">Prompt hiện tại đã khác</span>
            <span className="rq-diff-what">
              {[
                changes.promptChanged && 'nội dung prompt',
                changes.settingsChanged && 'cấu hình',
                (changes.refsAdded.length || changes.refsRemoved.length || changes.refsReordered) && 'tham chiếu',
              ]
                .filter(Boolean)
                .join(', ')}
            </span>
            <span className="rq-spacer" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowDiff((v) => !v)}>
              <FileDiff size={12} />
              {showDiff ? 'Ẩn khác biệt' : 'Xem khác biệt'}
            </button>
          </div>
        ) : (
          <div className="rq-diff-flag ok">
            <span className="badge ok">Khớp với prompt hiện tại</span>
          </div>
        )}

        {showDiff && changes?.any && scene && (
          <div className="rq-diff">
            {changes.settingsChanged && (
              <div className="rq-diff-line">
                <b>Cấu hình:</b> <span className="mono">{settingsLabel(take.settings)}</span> ({MODELS[take.settings.model]?.short}) →{' '}
                <span className="mono">{settingsLabel(scene.settings)}</span> ({MODELS[scene.settings.model]?.short})
              </div>
            )}
            {(changes.refsAdded.length > 0 || changes.refsRemoved.length > 0) && (
              <div className="rq-diff-line">
                <b>Tham chiếu:</b>{' '}
                {changes.refsRemoved.map((t) => (
                  <span key={'r' + t} className="rq-del">
                    −{t}{' '}
                  </span>
                ))}
                {changes.refsAdded.map((t) => (
                  <span key={'a' + t} className="rq-add">
                    +{t}{' '}
                  </span>
                ))}
              </div>
            )}
            {changes.refsReordered && (
              <div className="rq-diff-line">
                <b>Tham chiếu:</b> thứ tự đã đổi (số @image thay đổi).
              </div>
            )}
            {changes.diff.removed.map((p, i) => (
              <div key={'-' + i} className="rq-diff-para del">
                <span className="rq-diff-sign">−</span>
                <span>
                  <HighlightedPrompt text={p} />
                </span>
              </div>
            ))}
            {changes.diff.added.map((p, i) => (
              <div key={'+' + i} className="rq-diff-para add">
                <span className="rq-diff-sign">+</span>
                <span>
                  <HighlightedPrompt text={p} />
                </span>
              </div>
            ))}
            {changes.promptChanged && !changes.diff.removed.length && !changes.diff.added.length && (
              <div className="rq-diff-line faint">Chỉ khác thứ tự đoạn hoặc khoảng trắng.</div>
            )}
            <div className="rq-diff-legend faint">
              <span className="rq-del">− chỉ có trong take này</span> · <span className="rq-add">+ chỉ có trong prompt hiện tại</span>
            </div>
          </div>
        )}

        <pre className="rq-prompt">
          <HighlightedPrompt text={take.promptSnapshot || '(trống)'} />
        </pre>
      </div>

      {isActive(take) && (
        <div className="rq-small faint rq-live">
          <LoaderCircle size={12} className="rq-spin" /> Đang cập nhật trực tiếp…
        </div>
      )}
    </div>
  )
}

