import { ChevronDown, Copy, FileInput, GripVertical, Link2, Play, Plus, Search, SlidersHorizontal, Star, Trash, TriangleAlert, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { linkAssets, linkTakes, newScene, requestRun, takeLabel } from '../../actions'
import { compileScene, imageSlotsFor, sceneCode, takeCode } from '../../core/compile'
import { costOf, MODELS, settingsLabel } from '../../core/models'
import type { Asset, Scene } from '../../core/types'
import { ASSETS_MIME, readIds, TAKES_MIME } from '../../lib/dnd'
import { sortedScenes, undoToastAction, useProject } from '../../store/project'
import { useRuns, useSceneTakes } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { AssetAvatar, MediaImg } from '../common/Media'
import { TakeStrip } from '../runs/TakeStrip'
import { latestOf, MentionText, MenuButton, SCENE_MIME, STATUS_LABEL, starredTake, useTakesByScene } from './shared'
import './views.css'

/** Scene id being reordered via the drag handle (dataTransfer is unreadable during dragover). */
let draggingSceneId: string | null = null

export function SceneTable() {
  const scenes = useProject(useShallow((s) => sortedScenes(s.project)))
  const selectedIds = useUI((s) => s.selectedIds)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scenesRef = useRef(scenes)
  scenesRef.current = scenes
  const anchorRef = useRef<string | null>(null)
  const cursorRef = useRef<string | null>(null)

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const selectedScenes = useMemo(() => scenes.filter((s) => selectedSet.has(s.id)), [scenes, selectedSet])

  const selectRange = useCallback((fromId: string, toId: string, additive: boolean) => {
    const order = scenesRef.current.map((s) => s.id)
    const a = order.indexOf(fromId)
    const b = order.indexOf(toId)
    if (a < 0 || b < 0) return
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1)
    const ui = useUI.getState()
    ui.select(additive ? [...new Set([...ui.selectedIds, ...range])] : range)
  }, [])

  const toggle = useCallback((id: string) => {
    const ui = useUI.getState()
    const cur = ui.selectedIds
    ui.select(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])
    anchorRef.current = id
    cursorRef.current = id
  }, [])

  const onRowClick = useCallback(
    (id: string, e: MouseEvent) => {
      const additive = e.ctrlKey || e.metaKey
      if (e.shiftKey && anchorRef.current) {
        selectRange(anchorRef.current, id, additive)
        cursorRef.current = id
        return
      }
      if (additive) return toggle(id)
      useUI.getState().select([id])
      anchorRef.current = id
      cursorRef.current = id
    },
    [selectRange, toggle],
  )

  // ↑ / ↓ move the selection (Shift extends it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t?.closest?.('input:not([type="checkbox"]), textarea, select, [contenteditable="true"], [role="menu"]')) return
      const ui = useUI.getState()
      if (ui.dialog.kind !== 'none') return
      const list = scenesRef.current
      if (!list.length) return
      e.preventDefault()
      const sel = ui.selectedIds.filter((id) => list.some((s) => s.id === id))
      const cursor = cursorRef.current && sel.includes(cursorRef.current) ? cursorRef.current : sel[sel.length - 1]
      const idx = cursor ? list.findIndex((s) => s.id === cursor) : -1
      const nextIdx = e.key === 'ArrowDown' ? Math.min(list.length - 1, idx + 1) : idx < 0 ? 0 : Math.max(0, idx - 1)
      const id = list[nextIdx].id
      if (e.shiftKey && anchorRef.current && list.some((s) => s.id === anchorRef.current)) selectRange(anchorRef.current, id, false)
      else {
        ui.select([id])
        anchorRef.current = id
      }
      cursorRef.current = id
      scrollRef.current?.querySelector(`[data-row="${id}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectRange])

  const allSelected = scenes.length > 0 && selectedScenes.length === scenes.length
  const someSelected = selectedScenes.length > 0 && !allSelected
  const selectAllRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected
  }, [someSelected])

  if (!scenes.length) {
    return (
      <div className="vw-root">
        <div className="vw-empty-state">
          <div className="vw-empty-icon">
            <SlidersHorizontal size={22} />
          </div>
          <h3>Chưa có cảnh nào</h3>
          <p>Tạo cảnh đầu tiên, hoặc nhập lại các prompt cũ (dán hoặc file .txt) — mỗi prompt thành một cảnh, giữ nguyên @image_N / @video_N.</p>
          <div className="vw-empty-actions">
            <button className="btn btn-primary" onClick={() => newScene()}>
              <Plus size={15} /> Cảnh mới
            </button>
            <button className="btn" onClick={() => useUI.getState().openDialog({ kind: 'import' })}>
              <FileInput size={15} /> Nhập prompt cũ
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="vw-root vw-table-root">
      <TableHeader scenes={scenes} selected={selectedScenes} />
      <div className="vw-table-scroll" ref={scrollRef}>
        <div className="vw-table" role="table" aria-label="Bảng cảnh">
          <div className="vw-tr vw-thead" role="row">
            <span />
            <span className="vw-cell-check">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allSelected}
                onChange={() => useUI.getState().select(allSelected ? [] : scenes.map((s) => s.id))}
                title={allSelected ? 'Bỏ chọn tất cả' : 'Chọn tất cả cảnh'}
                aria-label="Chọn tất cả"
              />
            </span>
            <span>Cảnh</span>
            <span>Tên</span>
            <span title="Ảnh tham chiếu — số trên ảnh là N trong @image_N">Nhân vật</span>
            <span title="Video tham chiếu — v1 là @video_1">Video tham chiếu</span>
            <span>Prompt</span>
            <span>Cấu hình</span>
            <span className="vw-r">Credit</span>
            <span>Take</span>
            <span>Trạng thái</span>
            <span />
          </div>
          {scenes.map((s) => (
            <SceneRow
              key={s.id}
              scene={s}
              selected={selectedSet.has(s.id)}
              selectionCount={selectedSet.has(s.id) ? selectedScenes.length : 0}
              onRowClick={onRowClick}
              onToggle={toggle}
            />
          ))}
        </div>
      </div>
      <TableFooter scenes={scenes} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

function TableHeader({ scenes, selected }: { scenes: Scene[]; selected: Scene[] }) {
  const presets = useProject((s) => s.project.presets)
  const ids = selected.map((s) => s.id)
  const cost = selected.reduce((t, s) => t + costOf(s.settings), 0)

  if (!selected.length) {
    return (
      <div className="vw-head">
        <div className="vw-head-title">
          <h2>Bảng cảnh</h2>
          <span className="badge">{scenes.length} cảnh</span>
          <span className="vw-head-hint">Bấm vào dòng để chọn · Shift/Ctrl để chọn nhiều · kéo nhân vật hoặc video từ thư viện thả vào dòng để nối</span>
        </div>
        <div className="vw-head-actions">
          <button className="btn btn-sm" onClick={() => useUI.getState().openDialog({ kind: 'import' })}>
            <FileInput size={14} /> Nhập prompt
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => newScene()}>
            <Plus size={14} /> Cảnh
          </button>
        </div>
      </div>
    )
  }

  const project = () => useProject.getState()
  return (
    <div className="vw-head vw-bulk">
      <div className="vw-head-title">
        <button className="icon-btn" onClick={() => useUI.getState().clearSelection()} title="Bỏ chọn (Esc)" aria-label="Bỏ chọn">
          <X size={15} />
        </button>
        <b>{selected.length} cảnh đã chọn</b>
      </div>
      <div className="vw-head-actions">
        <MenuButton
          label={
            <>
              Áp dụng preset <ChevronDown size={13} />
            </>
          }
          width={260}
        >
          {(close) =>
            presets.length ? (
              presets.map((p) => (
                <button
                  key={p.id}
                  className="vw-menu-item"
                  onClick={() => {
                    project().applyPreset(p.id, ids)
                    toast(`Đã áp dụng preset “${p.name}” cho ${ids.length} cảnh.`, { tone: 'success', action: undoToastAction() })
                    close()
                  }}
                >
                  <span className="vw-menu-main">{p.name}</span>
                  <span className="vw-menu-sub">
                    {MODELS[p.model].short} · {settingsLabel(p)} · {costOf(p)} cr
                  </span>
                </button>
              ))
            ) : (
              <div className="vw-menu-empty">Chưa có preset nào.</div>
            )
          }
        </MenuButton>
        <MenuButton
          label={
            <>
              <Link2 size={13} /> Nối nhân vật <ChevronDown size={13} />
            </>
          }
          width={300}
        >
          {(close) => <AssetPicker sceneIds={ids} onDone={close} />}
        </MenuButton>
        <button className="btn btn-sm btn-primary" onClick={() => requestRun(ids)} title="Mở bảng xác nhận chạy">
          <Play size={13} /> Chạy {selected.length} · {cost} cr
        </button>
        <button
          className="btn btn-sm"
          onClick={() => {
            const created = project().duplicateScenes(ids)
            useUI.getState().select(created)
            toast(`Đã nhân bản ${created.length} cảnh.`, { tone: 'success', action: undoToastAction() })
          }}
        >
          <Copy size={13} /> Nhân bản
        </button>
        <button
          className="btn btn-sm btn-danger"
          onClick={() => {
            project().removeScenes(ids)
            useUI.getState().clearSelection()
            toast(`Đã xoá ${ids.length} cảnh.`, { action: undoToastAction() })
          }}
        >
          <Trash size={13} /> Xoá
        </button>
      </div>
    </div>
  )
}

function AssetPicker({ sceneIds, onDone }: { sceneIds: string[]; onDone: () => void }) {
  const assets = useProject((s) => s.project.assets)
  const scenes = useProject((s) => s.project.scenes)
  const [q, setQ] = useState('')
  const idSet = useMemo(() => new Set(sceneIds), [sceneIds])
  const query = q.trim().toLowerCase()
  const list = assets.filter((a) => !query || a.name.toLowerCase().includes(query) || a.tag.toLowerCase().includes(query))
  const usage = (assetId: string) => scenes.filter((s) => idSet.has(s.id) && s.refs.includes(assetId)).length
  return (
    <div className="vw-picker">
      <label className="vw-picker-search">
        <Search size={13} />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm nhân vật, bối cảnh…" />
      </label>
      <div className="vw-picker-list">
        {list.map((a) => {
          const n = usage(a.id)
          return (
            <div key={a.id} className="vw-picker-row">
              <button
                className="vw-menu-item"
                onClick={() => {
                  linkAssets(sceneIds, [a.id])
                  onDone()
                }}
                title={`Nối @${a.tag} vào ${sceneIds.length} cảnh`}
              >
                <AssetAvatar asset={a} size={24} />
                <span className="vw-menu-main">
                  {a.name} <span className="faint">@{a.tag}</span>
                </span>
                <span className={`vw-menu-count ${n === sceneIds.length ? 'full' : ''}`}>
                  {n}/{sceneIds.length}
                </span>
              </button>
              {n > 0 && (
                <button
                  className="vw-picker-unlink"
                  title={`Bỏ nối @${a.tag} khỏi ${n} cảnh`}
                  onClick={() => {
                    useProject.getState().removeRefs(sceneIds.map((sceneId) => ({ sceneId, assetId: a.id })))
                    toast(`Đã bỏ nối @${a.tag} khỏi ${n} cảnh.`, { action: undoToastAction() })
                  }}
                >
                  Bỏ
                </button>
              )}
            </div>
          )
        })}
        {!list.length && <div className="vw-menu-empty">{assets.length ? 'Không tìm thấy.' : 'Thư viện đang trống.'}</div>}
      </div>
    </div>
  )
}

function TableFooter({ scenes }: { scenes: Scene[] }) {
  const byScene = useTakesByScene()
  const total = scenes.reduce((t, s) => t + costOf(s.settings), 0)
  const starred = scenes.filter((s) => starredTake(byScene.get(s.id) ?? [])).length
  const withTakes = scenes.filter((s) => (byScene.get(s.id) ?? []).some((t) => t.status === 'completed')).length
  return (
    <div className="vw-foot">
      <span>
        <b>{scenes.length}</b> cảnh
      </span>
      <span className="vw-foot-sep" />
      <span>
        Chạy tất cả ≈ <b>{total.toLocaleString('vi-VN')}</b> credit
      </span>
      <span className="vw-foot-sep" />
      <span>
        <b>{withTakes}</b> cảnh có take xong
      </span>
      <span className="vw-foot-sep" />
      <span>
        <Star size={12} className="vw-star-ico" /> <b>{starred}</b>/{scenes.length} cảnh có take chọn
      </span>
      <span className="vw-foot-hint">
        <span className="kbd">↑</span>
        <span className="kbd">↓</span> chuyển cảnh · <span className="kbd">Shift</span> chọn nhiều
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

interface RowProps {
  scene: Scene
  selected: boolean
  /** Number of selected scenes when this row is selected, else 0 (keeps unselected rows from re-rendering). */
  selectionCount: number
  onRowClick: (id: string, e: MouseEvent) => void
  onToggle: (id: string) => void
}

type MediaOver = 'assets' | 'takes' | null

const SceneRow = memo(function SceneRow({ scene, selected, selectionCount, onRowClick, onToggle }: RowProps) {
  const id = scene.id
  const assets = useProject((s) => s.project.assets)
  const preset = useProject((s) => (scene.presetId ? s.project.presets.find((p) => p.id === scene.presetId) : undefined))
  // Status of each reference video, as one string (cheap + stable): drives the "video not ready" warning.
  const videoStatus = useRuns((s) => (scene.videoRefs.length ? scene.videoRefs.map((t) => s.takes.find((x) => x.id === t)?.status ?? '-').join(',') : ''))
  const warnings = useMemo(() => {
    const status = new Map(scene.videoRefs.map((t, i) => [t, videoStatus.split(',')[i]]))
    const project = { ...useProject.getState().project, assets }
    return compileScene(project, scene, { takeStatus: (t) => (status.get(t) === '-' ? undefined : status.get(t)) }).warnings.join('\n')
  }, [scene, assets, videoStatus])
  const libraryDragging = useUI((s) => s.draggingAssetIds !== null)
  // A finished take is being dragged (take strip, library, canvas) and this row can use it as @video:
  // every row lights up except the scene that made all of the dragged takes (no self references).
  const takeDragging = useUI((s) => {
    const ids = s.draggingTakeIds
    if (!ids?.length) return false
    const takes = useRuns.getState().takes
    return ids.some((t) => takes.find((x) => x.id === t)?.sceneId !== id)
  })
  const [mediaOver, setMediaOver] = useState<MediaOver>(null)
  const [dropPos, setDropPos] = useState<'above' | 'below' | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)

  const code = sceneCode(scene.order)
  const refAssets = useMemo(() => {
    const byId = new Map(assets.map((a) => [a.id, a]))
    const slots = imageSlotsFor(assets, scene.refs)
    return scene.refs
      .map((r) => byId.get(r))
      .filter((a): a is Asset => !!a)
      .map((asset) => ({ asset, numbers: slots.filter((s) => s.assetId === asset.id).map((s) => s.n) }))
  }, [assets, scene.refs])
  const cost = costOf(scene.settings)
  const spec = MODELS[scene.settings.model]
  const multiTarget = selected && selectionCount > 1

  const targets = () => {
    if (!multiTarget) return [id]
    const sel = new Set(useUI.getState().selectedIds)
    return useProject
      .getState()
      .project.scenes.filter((s) => sel.has(s.id))
      .map((s) => s.id)
  }

  const onDragOver = (e: DragEvent) => {
    const types = e.dataTransfer.types
    const media: MediaOver = types.includes(ASSETS_MIME) ? 'assets' : types.includes(TAKES_MIME) ? 'takes' : null
    if (media) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      if (mediaOver !== media) setMediaOver(media)
      return
    }
    if (types.includes(SCENE_MIME) && draggingSceneId && draggingSceneId !== id) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const rect = rowRef.current!.getBoundingClientRect()
      const pos = e.clientY < rect.top + rect.height / 2 ? 'above' : 'below'
      if (pos !== dropPos) setDropPos(pos)
    }
  }
  const onDragLeave = (e: DragEvent) => {
    if (rowRef.current && e.relatedTarget instanceof Node && rowRef.current.contains(e.relatedTarget)) return
    setMediaOver(null)
    setDropPos(null)
  }
  const onDrop = (e: DragEvent) => {
    const pos = dropPos
    setMediaOver(null)
    setDropPos(null)
    const assetIds = readIds(e.dataTransfer, ASSETS_MIME)
    const takeIds = readIds(e.dataTransfer, TAKES_MIME)
    if (assetIds.length || takeIds.length) {
      e.preventDefault()
      const to = targets()
      if (assetIds.length) {
        linkAssets(to, assetIds)
        useUI.getState().setDraggingAssets(null)
      }
      if (takeIds.length) {
        linkTakes(to, takeIds)
        useUI.getState().setDraggingTakes(null)
      }
      return
    }
    const moving = draggingSceneId
    if (moving && moving !== id && pos) {
      e.preventDefault()
      const list = sortedScenes(useProject.getState().project)
      const d = list.find((s) => s.id === moving)?.order
      const k = scene.order
      if (!d) return
      const idxRemaining = k < d ? k - 1 : k - 2
      const toOrder = (pos === 'above' ? idxRemaining : idxRemaining + 1) + 1
      if (toOrder !== d) useProject.getState().moveScene(moving, toOrder)
    }
  }

  const dropHint = multiTarget ? `Nối vào ${selectionCount} cảnh đã chọn` : 'Thả để nối'

  return (
    <div
      ref={rowRef}
      data-row={id}
      role="row"
      aria-selected={selected}
      className={`vw-tr vw-row ${selected ? 'selected' : ''} ${mediaOver === 'assets' ? 'asset-over' : ''} ${mediaOver === 'takes' ? 'take-over' : ''} ${libraryDragging ? 'lib-drag' : ''} ${takeDragging ? 'take-drag' : ''} ${dropPos ? 'drop-' + dropPos : ''}`}
      onClick={(e) => onRowClick(id, e)}
      onDoubleClick={() => useUI.getState().setRightOpen(true)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span
        className="vw-handle"
        draggable
        title="Kéo để đổi thứ tự"
        onClick={(e) => e.stopPropagation()}
        onDragStart={(e) => {
          draggingSceneId = id
          e.dataTransfer.setData(SCENE_MIME, id)
          e.dataTransfer.effectAllowed = 'move'
          if (rowRef.current) e.dataTransfer.setDragImage(rowRef.current, 16, 18)
        }}
        onDragEnd={() => {
          draggingSceneId = null
        }}
      >
        <GripVertical size={14} />
      </span>
      <span className="vw-cell-check" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={() => onToggle(id)} aria-label={`Chọn ${code}`} />
      </span>
      <span className="vw-code" style={scene.color ? { color: scene.color } : undefined}>
        {code}
      </span>
      <span className="vw-cell-title">
        <input
          className="vw-cell-input"
          value={scene.title}
          placeholder="Chưa đặt tên"
          onChange={(e) => useProject.getState().updateScene(id, { title: e.target.value })}
          onClick={(e) => {
            if (e.shiftKey || e.ctrlKey || e.metaKey) return
            e.stopPropagation()
            if (!useUI.getState().selectedIds.includes(id) || selectionCount > 1) useUI.getState().select([id])
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
          }}
          aria-label={`Tên ${code}`}
        />
      </span>
      <span className="vw-cell-refs">
        {mediaOver === 'assets' ? (
          <span className="vw-drop-hint">{dropHint}</span>
        ) : refAssets.length ? (
          <span className="vw-avatars">
            {refAssets.slice(0, 4).map(({ asset: a, numbers }) => (
              <span
                key={a.id}
                className="vw-avatar"
                title={`${a.name} · ${numbers.length ? numbers.map((n) => '@image_' + n).join(', ') : 'chưa có ảnh'}`}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  useUI.getState().openDialog({ kind: 'asset', assetId: a.id })
                }}
              >
                <AssetAvatar asset={a} size={24} />
                <span className={`vw-num${numbers.length ? '' : ' none'}`}>
                  {numbers.length ? numbers[0] : '!'}
                  {numbers.length > 1 ? '+' : ''}
                </span>
              </span>
            ))}
            {refAssets.length > 4 && <span className="vw-avatar-more">+{refAssets.length - 4}</span>}
          </span>
        ) : (
          <span className="vw-faint-cell">Kéo nhân vật vào</span>
        )}
      </span>
      <span className="vw-cell-videos">
        {mediaOver === 'takes' ? (
          <span className="vw-drop-hint video">{dropHint}</span>
        ) : scene.videoRefs.length ? (
          <span className="vw-vrefs">
            {scene.videoRefs.slice(0, 3).map((takeId, i) => (
              <VideoRefThumb key={takeId} sceneId={id} takeId={takeId} n={i + 1} />
            ))}
            {scene.videoRefs.length > 3 && <span className="vw-avatar-more">+{scene.videoRefs.length - 3}</span>}
          </span>
        ) : (
          <span className="vw-faint-cell">{takeDragging ? 'Thả video vào' : '—'}</span>
        )}
      </span>
      <span className="vw-cell-prompt" title={scene.prompt.slice(0, 600)}>
        {scene.prompt.trim() ? <MentionText text={scene.prompt.replace(/\s+/g, ' ')} max={120} /> : <span className="vw-faint-cell">Chưa có prompt</span>}
      </span>
      <span className="vw-cell-settings">
        <span className="vw-settings-line">
          <i className="vw-model-dot" style={{ background: spec.color }} title={spec.name} />
          {spec.short} · {settingsLabel(scene.settings)}
        </span>
        {preset && <span className="vw-preset">{preset.name}</span>}
      </span>
      <span className="vw-r vw-cell-cost">
        {cost}
        <span className="faint"> cr</span>
      </span>
      <span className="vw-cell-takes">
        {/* 3 thumbs + "+N" fit the 186px column; more would clip the newest takes. */}
        <TakeStrip sceneId={id} size="sm" max={3} />
      </span>
      <span className="vw-cell-status">
        <RowStatus sceneId={id} />
        {warnings && (
          <span className="vw-warn" title={warnings}>
            <TriangleAlert size={13} />
          </span>
        )}
      </span>
      <span className="vw-cell-run">
        <button
          className="vw-run"
          disabled={!scene.prompt.trim()}
          title={scene.prompt.trim() ? `Chạy ${code} · ${settingsLabel(scene.settings)} · ${cost} credit` : 'Prompt trống — chưa chạy được'}
          onClick={(e) => {
            e.stopPropagation()
            requestRun([id])
          }}
          aria-label={`Chạy ${code}`}
        >
          <Play size={13} />
        </button>
      </span>
    </div>
  )
})

/** One reference video of a scene (purple thumb, "v1" = @video_1). Click opens the take, × removes the reference. */
const VideoRefThumb = memo(function VideoRefThumb({ sceneId, takeId, n }: { sceneId: string; takeId: string; n: number }) {
  const take = useRuns((s) => s.takes.find((t) => t.id === takeId))
  const order = useProject((s) => (take ? s.project.scenes.find((x) => x.id === take.sceneId)?.order : undefined))
  const label = take ? takeCode(order, take.number) : 'đã xoá'
  const ready = take?.status === 'completed'
  const remove = () => {
    useProject.getState().removeVideoRef(sceneId, takeId, `video ${take ? takeLabel(takeId) : ''}`.trim())
    toast(`Đã bỏ video tham chiếu ${label} (@video_${n}).`, { action: undoToastAction() })
  }
  return (
    <span
      className={`vw-vref${take ? '' : ' missing'}${ready ? '' : ' pending'}`}
      title={`@video_${n} · ${take ? label : 'video đã bị xoá'}${take && !ready ? ' · chưa tạo xong' : ''}`}
    >
      <button
        type="button"
        className="vw-vref-open"
        disabled={!take}
        onClick={(e) => {
          e.stopPropagation()
          useUI.getState().openDialog({ kind: 'take', takeId })
        }}
        aria-label={`Xem @video_${n}`}
      >
        {take?.posterId ? <MediaImg id={take.posterId} className="vw-vref-img" /> : <span className="vw-vref-ph" />}
        <span className="vw-vref-n">v{n}</span>
      </button>
      <button
        type="button"
        className="vw-vref-x"
        onClick={(e) => {
          e.stopPropagation()
          remove()
        }}
        title={`Bỏ @video_${n}`}
        aria-label={`Bỏ @video_${n}`}
      >
        <X size={10} />
      </button>
    </span>
  )
})

function RowStatus({ sceneId }: { sceneId: string }) {
  const takes = useSceneTakes(sceneId)
  const latest = latestOf(takes)
  if (!latest) return <span className="vw-status faint">Chưa chạy</span>
  return (
    <span className={`vw-status ${latest.status}`} title={latest.error ?? undefined}>
      <i className={`status-dot ${latest.status}`} />
      {latest.status === 'processing' ? `${STATUS_LABEL.processing} ${latest.progress}%` : STATUS_LABEL[latest.status]}
      <span className="faint">· T{latest.number}</span>
    </span>
  )
}
