import { ArrowLeft, ArrowRight, ImagePlus, Info, Link2, Pin, PinOff, RefreshCw, Star, Trash2, TriangleAlert, Unlink, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { focusNodes, viewImages } from '../../actions'
import { sceneCode } from '../../core/compile'
import { MODELS } from '../../core/models'
import type { Asset, AssetKind } from '../../core/types'
import { aspectOf, useImageSize } from '../../lib/imageMeta'
import { useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { AssetAvatar, FullImage } from '../common/Media'
import { Modal } from '../common/Modal'
import { addImageFiles, staleNote, staleTokenScenes, useAddingImages, withRenumberToast } from './assetImages'
import { ColorSwatches, ConfirmButton } from './bits'
import {
  changedPrompts,
  checkTag,
  countMentions,
  hasFiles,
  imageRenumberNote,
  imageTokenLabels,
  KIND_META,
  KIND_ORDER,
  kindMeta,
  nextAssetPosition,
  renameAssetTag,
  scenesWithStaleTokens,
  staleTokenNote,
  undoToastAction,
  useDialogUndoKeys,
  useFileDropGuard,
} from './shared'
import './sidebar.css'

/** Library item editor. Every change applies live (undoable); "Xong" just closes. */
export function AssetDialog({ assetId }: { assetId: string }) {
  const asset = useProject((s) => s.project.assets.find((a) => a.id === assetId))
  const closeDialog = useUI((s) => s.closeDialog)

  // The asset can disappear (deleted, undo) while the dialog is open.
  useEffect(() => {
    if (!asset) closeDialog()
  }, [asset, closeDialog])
  if (!asset) return null
  return <AssetEditor asset={asset} onClose={closeDialog} />
}

function AssetEditor({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const update = (patch: Partial<Omit<Asset, 'id'>>) => useProject.getState().updateAsset(asset.id, patch)
  useDialogUndoKeys()
  useFileDropGuard()
  /** Image files dragged anywhere over the dialog body are added to this asset. */
  const [fileOver, setFileOver] = useState(false)

  const remove = () => {
    const name = asset.name || asset.tag
    const before = useProject.getState().project
    useProject.getState().removeAssets([asset.id])
    const after = useProject.getState().project
    const rewritten = changedPrompts(before.scenes, after.scenes).length
    // Renumbering off (Settings): the numbers after this asset's images now point at other pictures.
    const stale = scenesWithStaleTokens(before, after)
    const action = undoToastAction()
    const ui = useUI.getState()
    ui.setLibrarySelection(ui.librarySelection.filter((x) => x !== asset.id))
    if (ui.selectedIds.includes(asset.id)) ui.select(ui.selectedIds.filter((x) => x !== asset.id))
    onClose()
    if (stale.length) toast(`Đã xoá “${name}” khỏi thư viện và mọi cảnh${staleTokenNote(after, stale)}.`, { tone: 'warning', ms: 8000, action })
    else toast(`Đã xoá “${name}” khỏi thư viện và mọi cảnh${rewritten ? ` · đánh lại số @image trong ${rewritten} prompt` : ''}.`, { action })
  }

  const title = (
    <span className="sb-dlg-title">
      <AssetAvatar asset={asset} size={26} ring />
      <span className="sb-dlg-title-text">{asset.name || 'Chưa đặt tên'}</span>
      <span className="badge">{kindMeta(asset.kind).label}</span>
    </span>
  )

  return (
    <Modal
      title={title}
      onClose={onClose}
      size="wide"
      footer={
        <>
          <ConfirmButton icon={<Trash2 size={13} />} label="Xoá khỏi thư viện" confirmLabel="Xoá cả các nối? Bấm lần nữa" className="btn btn-danger" onConfirm={remove} />
          <span className="sb-spacer" />
          <span className="faint sb-live-note">Thay đổi được lưu ngay · Ctrl+Z để hoàn tác</span>
          <button className="btn btn-primary" onClick={onClose}>
            Xong
          </button>
        </>
      }
    >
      <div
        className="sb-dlg-grid"
        onDragOver={(e) => {
          if (!hasFiles(e.dataTransfer)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          if (!fileOver) setFileOver(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileOver(false)
        }}
        onDrop={(e) => {
          if (!hasFiles(e.dataTransfer)) return
          e.preventDefault()
          setFileOver(false)
          void addImageFiles(asset.id, Array.from(e.dataTransfer.files))
        }}
      >
        <div className="sb-dlg-col">
          <div className="sb-row2">
            <label className="field">
              <span>Tên</span>
              <input
                className="input"
                value={asset.name}
                placeholder="Ví dụ: Elara"
                onChange={(e) => update({ name: e.target.value })}
                onBlur={(e) => {
                  if (!e.target.value.trim()) update({ name: asset.tag })
                }}
              />
            </label>
            <TagField asset={asset} />
          </div>
          <div className="sb-row2">
            <label className="field">
              <span>Loại</span>
              <select className="select" value={asset.kind} onChange={(e) => update({ kind: e.target.value as AssetKind })}>
                {KIND_ORDER.map((k) => (
                  <option key={k} value={k}>
                    {KIND_META[k].label}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span>Màu</span>
              <ColorSwatches value={asset.color} onChange={(color) => update({ color })} />
            </div>
          </div>
          <label className="field">
            <span>Ghi chú / mô tả</span>
            <textarea
              className="textarea"
              rows={2}
              value={asset.description}
              placeholder="young woman, long auburn braid, green wool cloak"
              onChange={(e) => update({ description: e.target.value })}
            />
            <small className="faint">Chỉ để ghi nhớ và tìm kiếm — không tự thêm vào prompt.</small>
          </label>
          <div className="sb-explain-box">
            <Info size={13} />
            <div>
              Prompt được gửi đúng như bạn viết. Trong prompt, gọi ảnh của mục này bằng số <span className="sb-tok">@image_N</span> — số tuỳ theo
              thứ tự tham chiếu của từng cảnh (xem cột bên phải). Gõ <span className="kbd">@</span> trong ô prompt để chèn đúng số.
            </div>
          </div>
          <ImagesEditor asset={asset} over={fileOver} />
        </div>
        <div className="sb-dlg-col side">
          <UsageList asset={asset} onClose={onClose} />
        </div>
      </div>
    </Modal>
  )
}

// ---------------- tag ----------------
function TagField({ asset }: { asset: Asset }) {
  const [draft, setDraft] = useState(asset.tag)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setDraft(asset.tag)
  }, [asset.tag, focused])
  const project = useProject((s) => s.project)
  const check = useMemo(() => checkTag(project, asset.id, draft), [project, asset.id, draft])
  // Only a real edit renames: a stored tag that is not in slug form (e.g. "mira" / "Hùng" created from a prompt)
  // must not be rewritten (with every @mention) just because the field was focused and blurred.
  const edited = draft.trim() !== asset.tag
  const changed = edited && check.changed
  const error = edited ? check.error : null
  const mentions = useMemo(() => (changed && !error ? countMentions(project, asset.tag) : 0), [changed, error, project, asset.tag])

  const commit = () => {
    setFocused(false)
    if (!edited || !check.changed) {
      setDraft(asset.tag)
      return
    }
    if (check.error) {
      toast(`${check.error} Giữ tag @${asset.tag}.`, { tone: 'warning' })
      setDraft(asset.tag)
      return
    }
    const res = renameAssetTag(asset.id, draft)
    if (!res.ok) {
      toast(res.error ?? 'Không đổi được tag.', { tone: 'warning' })
      setDraft(asset.tag)
      return
    }
    setDraft(res.tag)
    toast(`Đã đổi tag thành @${res.tag}${res.rewritten ? ` · cập nhật ${res.rewritten} prompt` : ''}.`, {
      tone: 'success',
      action: undoToastAction(),
    })
  }

  return (
    <label className="field">
      <span title="Tên ngắn để tìm nhanh trong thư viện và khi gõ @ trong prompt">Tag (tìm nhanh)</span>
      <div className={`sb-tag-input${error && focused ? ' error' : ''}`}>
        <span className="sb-tag-at">@</span>
        <input
          className="input mono"
          value={draft}
          spellCheck={false}
          onFocus={() => setFocused(true)}
          onChange={(e) => setDraft(e.target.value.replace(/^@+/, ''))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      </div>
      {focused && (error || changed) && (
        <small className={`sb-field-note${error ? ' error' : ''}`}>
          {error
            ? error
            : `${check.tag !== draft.trim() ? `Sẽ lưu là @${check.tag}. ` : ''}${mentions ? `Tự cập nhật @${asset.tag} trong ${mentions} prompt.` : 'Enter để lưu.'}`}
        </small>
      )}
    </label>
  )
}

// ---------------- images ----------------
/**
 * Change the images of an asset (remove / reorder). The project store renumbers the @image tokens of every
 * scene using it in the same undo step; tell the user when prompts were rewritten so the toast can undo it. With
 * renumbering off (Settings) the tokens are left as written: warn about the scenes whose numbers now point elsewhere.
 * `from` / `to`: range of image indexes whose numbers change (`to` omitted = every number after `from`).
 */
function setAssetImages(asset: Asset, imageIds: string[], what: 'remove' | 'move', from: number, to?: number) {
  const before = useProject.getState().project.scenes
  const stale = staleTokenScenes(asset.id, from, to)
  useProject.getState().updateAsset(asset.id, { imageIds })
  const rewritten = changedPrompts(before, useProject.getState().project.scenes).length
  const done = what === 'remove' ? `Đã bỏ 1 ảnh của “${asset.name}”` : 'Đã đổi thứ tự ảnh'
  if (stale.length) {
    toast(`${done}${staleNote(stale)}.`, { tone: 'warning', action: undoToastAction() })
  } else if (what === 'remove') {
    toast(`${done}${rewritten ? ` · đánh lại số @image trong ${rewritten} prompt` : ''}.`, { action: undoToastAction() })
  } else if (rewritten) {
    toast(`${done} · đánh lại số @image trong ${rewritten} prompt.`, { action: undoToastAction() })
  }
}

/**
 * Full-screen viewer for this asset's images. The viewer takes the dialog slot, so the asset dialog comes back when
 * the viewer is closed (unless something else was opened meanwhile).
 */
function viewFromDialog(asset: Asset, index: number) {
  viewImages(asset.imageIds, index, asset.name)
  if (useUI.getState().dialog.kind !== 'image') return
  const unsub = useUI.subscribe((s, prev) => {
    if (s.dialog === prev.dialog) return
    unsub()
    if (s.dialog.kind === 'none' && prev.dialog.kind === 'image' && useProject.getState().project.assets.some((a) => a.id === asset.id)) {
      useUI.getState().openDialog({ kind: 'asset', assetId: asset.id })
    }
  })
}

/** Height of the image tiles (px): each tile is as wide as its picture, the whole image is shown (no crop). */
const IMG_H = 112
/** Narrowest tile: room for the ← ★ → × buttons (4 × 22 + 3 gaps + 2 × 4 inset + border; tall pictures letterbox). */
const IMG_MIN_W = 108

function ImageTile({ id, alt, primary, onOpen, children }: { id: string; alt: string; primary: boolean; onOpen: () => void; children: ReactNode }) {
  const size = useImageSize(id)
  const ar = aspectOf(size, 1, 0.5, 2.4)
  return (
    <div className={`sb-img${primary ? ' primary' : ''}`} style={{ width: Math.round(Math.max(IMG_MIN_W, IMG_H * ar)) }}>
      <FullImage id={id} alt={alt} fill className="sb-img-full" onClick={onOpen} title={size ? `Bấm để xem ảnh đầy đủ (${size.w}×${size.h})` : 'Bấm để xem ảnh đầy đủ'} />
      {children}
    </div>
  )
}

/** `over`: image files are being dragged over the dialog (the whole body is the drop zone). */
function ImagesEditor({ asset, over }: { asset: Asset; over: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const ids = asset.imageIds
  const used = useProject((s) => s.project.scenes.reduce((n, sc) => n + (sc.refs.includes(asset.id) ? 1 : 0), 0))
  const autoRenumber = useProject((s) => s.project.settings.autoRenumber)
  const note = imageRenumberNote(autoRenumber, used)
  const move = (from: number, to: number) => {
    if (to < 0 || to >= ids.length) return
    const next = [...ids]
    const [x] = next.splice(from, 1)
    next.splice(to, 0, x)
    setAssetImages(asset, next, 'move', Math.min(from, to), Math.max(from, to))
  }
  const add = (files: File[]) => addImageFiles(asset.id, files)
  // Images are being stored: keep the list as is until they are appended (a change made now would be lost).
  const busy = useAddingImages(asset.id)
  const maxSd = MODELS.seedance_2_5.maxRefImages
  const maxH3 = MODELS.minimax_h3.maxRefImages

  return (
    <div className="field">
      <span className="sb-field-head">
        Ảnh tham chiếu <span className="sb-field-count">{ids.length}</span>
      </span>
      <div className={`sb-images${over ? ' over' : ''}`}>
        {ids.map((id, i) => (
          <ImageTile key={id} id={id} alt={`${asset.name} ${i + 1}`} primary={i === 0} onOpen={() => viewFromDialog(asset, i)}>
            {i === 0 ? <span className="sb-img-badge">Ảnh chính</span> : <span className="sb-img-n">{i + 1}</span>}
            <div className="sb-img-actions">
              <button className="sb-card-btn" title="Sang trái" disabled={busy || i === 0} onClick={() => move(i, i - 1)}>
                <ArrowLeft size={12} />
              </button>
              {i > 0 && (
                <button className="sb-card-btn" title="Đặt làm ảnh chính" disabled={busy} onClick={() => move(i, 0)}>
                  <Star size={12} />
                </button>
              )}
              <button className="sb-card-btn" title="Sang phải" disabled={busy || i === ids.length - 1} onClick={() => move(i, i + 1)}>
                <ArrowRight size={12} />
              </button>
              <button className="sb-card-btn danger" title="Bỏ ảnh này" disabled={busy} onClick={() => setAssetImages(asset, ids.filter((x) => x !== id), 'remove', i)}>
                <X size={12} />
              </button>
            </div>
          </ImageTile>
        ))}
        <button
          className="sb-img-add"
          onClick={() => input.current?.click()}
          disabled={busy}
          aria-busy={busy}
          title={busy ? 'Đang lưu ảnh…' : 'Thêm ảnh (hoặc thả file vào đây)'}
        >
          <ImagePlus size={18} />
          <span>{busy ? 'Đang lưu…' : 'Thêm ảnh'}</span>
        </button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            void add(files)
          }}
        />
      </div>
      <small className="faint">
        Mỗi ảnh chiếm một số <span className="mono">@image_N</span> theo thứ tự trên (ảnh chính đầu tiên). Giới hạn: {MODELS.seedance_2_5.name} {maxSd} ảnh,{' '}
        {MODELS.minimax_h3.name} {maxH3} ảnh mỗi cảnh.
      </small>
      <small className={`sb-renumber-hint${note.warn ? ' warn' : ''}`}>
        {note.warn ? <TriangleAlert size={11} /> : <RefreshCw size={11} />}
        <span>{note.text}</span>
      </small>
    </div>
  )
}

// ---------------- usage ----------------
function UsageList({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const scenes = useProject(useShallow((s) => s.project.scenes.filter((sc) => sc.refs.includes(asset.id) || sc.firstFrame === asset.id || sc.lastFrame === asset.id)))
  const sorted = useMemo(() => [...scenes].sort((a, b) => a.order - b.order), [scenes])
  const refScenes = sorted.filter((s) => s.refs.includes(asset.id))
  const assets = useProject((s) => s.project.assets)

  const goTo = (sceneId: string) => {
    const ui = useUI.getState()
    ui.select([sceneId])
    onClose()
    if (ui.view === 'canvas') setTimeout(() => focusNodes([sceneId]), 30)
  }

  const removeAll = () =>
    withRenumberToast(
      () => useProject.getState().removeRefs(refScenes.map((s) => ({ sceneId: s.id, assetId: asset.id }))),
      `Đã bỏ “${asset.name}” khỏi ${refScenes.length} cảnh`,
      true,
    )

  const unlinkOne = (sceneId: string, order: number) =>
    withRenumberToast(() => useProject.getState().removeRef(sceneId, asset.id), `Đã bỏ “${asset.name}” khỏi ${sceneCode(order)}`)

  const toggleCanvas = () => {
    const st = useProject.getState()
    st.setAssetOnCanvas(asset.id, asset.position ? null : nextAssetPosition(st.project))
  }

  return (
    <>
      <div className="section-title">
        <span>
          Dùng ở {refScenes.length} cảnh
        </span>
        {refScenes.length > 0 && (
          <ConfirmButton
            icon={<Unlink size={12} />}
            label="Bỏ khỏi tất cả cảnh"
            confirmLabel={`Bỏ khỏi ${refScenes.length} cảnh?`}
            className="btn btn-ghost btn-sm"
            onConfirm={removeAll}
          />
        )}
      </div>
      {!sorted.length ? (
        <div className="empty sb-empty">
          Chưa nối vào cảnh nào.
          <div className="faint">Kéo thẻ này từ thư viện vào cảnh, hoặc gõ @ trong ô prompt rồi chọn “{asset.name || asset.tag}”.</div>
        </div>
      ) : (
        <div className="sb-usage">
          {sorted.map((s) => {
            const idx = s.refs.indexOf(asset.id)
            const label = idx >= 0 ? imageTokenLabels(assets, s.refs)[asset.id] : ''
            const frame = s.firstFrame === asset.id ? 'Khung đầu' : s.lastFrame === asset.id ? 'Khung cuối' : null
            return (
              <div key={s.id} className="sb-usage-row" onClick={() => goTo(s.id)} title="Đi tới cảnh">
                <span className="badge accent mono">{sceneCode(s.order)}</span>
                <span className="sb-usage-title">{s.title || <span className="faint">Chưa đặt tên</span>}</span>
                {idx >= 0 && (
                  <span className={`sb-usage-pos${label ? '' : ' faint'}`} title={label ? `Số gọi ảnh này trong prompt của ${sceneCode(s.order)}` : 'Chưa có ảnh nên chưa có số @image'}>
                    {label || 'chưa có số'}
                  </span>
                )}
                {frame && <span className="badge ok">{frame}</span>}
                {idx >= 0 && (
                  <button
                    className="sb-mini"
                    title={`Bỏ nối khỏi ${sceneCode(s.order)}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      unlinkOne(s.id, s.order)
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
      <div className="divider" />
      <div className="section-title">
        <span>Trên canvas</span>
      </div>
      <div className="sb-canvas-toggle" style={{ '--sb-c': asset.color } as CSSProperties}>
        <span className={`sb-dot${asset.position ? ' on' : ''}`} />
        <span className="muted">{asset.position ? 'Đang hiện trên canvas.' : 'Chỉ có trong thư viện.'}</span>
        <button className="btn btn-sm" onClick={toggleCanvas}>
          {asset.position ? <PinOff size={12} /> : <Pin size={12} />}
          {asset.position ? 'Bỏ khỏi canvas' : 'Đặt lên canvas'}
        </button>
      </div>
      <small className="faint sb-side-note">
        <Link2 size={11} /> Bỏ khỏi canvas không xoá các nối — cảnh vẫn dùng mục này.
      </small>
    </>
  )
}
