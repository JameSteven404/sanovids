// Inspector for one asset (selected on the canvas or in the library).
import { ImagePlus, Link2, LocateFixed, MapPinned, Pencil, Unlink, X } from 'lucide-react'
import { memo, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { focusNodes, linkAssets, revealNodes, viewImages } from '../../actions'
import { sceneCode } from '../../core/compile'
import { PALETTE } from '../../core/ids'
import { normalizeAssetName } from '../../core/names'
import type { Asset, AssetKind } from '../../core/types'
import { aspectOf, useImageSize } from '../../lib/imageMeta'
import { selectAsset, undoToastAction, useProject, type ProjectState } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { FullImage } from '../common/Media'
import { fold, KIND_ICON, KIND_LABEL, KINDS, PickerPopover, Section, type PickItem } from './shared'
import { addImageFiles, useAddingImages, withRenumberToast } from '../sidebar/assetImages'
import { nextAssetPosition, renameAssetTag } from '../sidebar/shared'

const SEP = '\u0001'

export function AssetInspector({ assetId }: { assetId: string }) {
  const asset = useProject(selectAsset(assetId))
  const [tagDraft, setTagDraft] = useState<string | null>(null)
  // What is typed while the name is edited: the store keeps a blank name as "Không tên" (core/names), the field shows it
  // only once the edit ends.
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // Images are being stored: keep the list as is until they are appended (a change made now would be lost).
  const busy = useAddingImages(assetId)
  if (!asset) return null
  const Icon = KIND_ICON[asset.kind] ?? KIND_ICON.character
  const update = (patch: Parameters<ProjectState['updateAsset']>[1]) => useProject.getState().updateAsset(assetId, patch)

  const commitTag = () => {
    if (tagDraft === null) return
    const raw = tagDraft.replace(/^@+/, '').trim()
    setTagDraft(null)
    if (!raw || raw === asset.tag) return
    const res = renameAssetTag(assetId, raw)
    if (!res.ok) {
      toast(res.error ?? 'Không đổi được tag.', { tone: 'warning' })
      return
    }
    if (res.tag !== raw) toast(`Tag đã được chuẩn hoá thành @${res.tag} (không dấu, không trùng).`, { tone: 'info' })
    if (res.rewritten) toast(`Đã đổi @${asset.tag} → @${res.tag} trong ${res.rewritten} prompt.`, { tone: 'success', action: undoToastAction() })
  }

  const toggleCanvas = () => {
    if (asset.position) {
      useProject.getState().setAssetOnCanvas(assetId, null)
      // Its canvas node is gone (and with it the canvas selection that showed this panel): keep showing the asset
      // here as a library selection, like the library card the user would otherwise have to click.
      const ui = useUI.getState()
      if (ui.selectedIds.includes(assetId)) ui.select(ui.selectedIds.filter((x) => x !== assetId))
      ui.setLibrarySelection([assetId])
      toast(`Đã bỏ @${asset.tag} khỏi canvas (vẫn còn trong thư viện).`, { action: undoToastAction() })
      return
    }
    // Same slot as the library's "Đặt lên canvas" (below the lowest card of the asset column, resized heights included).
    useProject.getState().setAssetOnCanvas(assetId, nextAssetPosition(useProject.getState().project, asset))
    useUI.getState().select([assetId])
    revealNodes([assetId])
  }

  return (
    <div className="in-asset">
      <AssetHero asset={asset}>
        <span className="in-asset-kind">
          <Icon size={12} /> {KIND_LABEL[asset.kind]}
        </span>
      </AssetHero>

      <div className="in-asset-fields">
        {/* Never left empty (like the asset dialog): renumbering turns removed @image_N tokens into the name. */}
        <input
          className="in-asset-name"
          value={nameDraft !== null && normalizeAssetName(nameDraft) === asset.name ? nameDraft : asset.name}
          onChange={(e) => {
            setNameDraft(e.target.value)
            update({ name: e.target.value })
          }}
          onBlur={(e) => {
            setNameDraft(null)
            if (!e.target.value.trim()) update({ name: asset.tag })
          }}
          placeholder="Tên"
          aria-label="Tên"
        />
        <div className="in-grid">
          <label className="in-field c3">
            <span>Tag</span>
            <div className="in-tag-input">
              <span>@</span>
              <input
                className="input in-sm"
                value={tagDraft ?? asset.tag}
                onChange={(e) => setTagDraft(e.target.value)}
                onBlur={commitTag}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') setTagDraft(null)
                }}
                spellCheck={false}
              />
            </div>
          </label>
          <label className="in-field c3">
            <span>Loại</span>
            <select className="select in-sm" value={asset.kind} onChange={(e) => update({ kind: e.target.value as AssetKind })}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="in-field">
          <span>Mô tả</span>
          <textarea
            className="textarea in-desc"
            rows={3}
            value={asset.description}
            placeholder="vd: young woman, long auburn braid, green wool cloak"
            onChange={(e) => update({ description: e.target.value })}
          />
        </label>
        <div className="in-help">Ghi chú cho bạn (không gửi đi). Trong prompt, ảnh của {asset.name} được gọi bằng số @image_N của từng cảnh.</div>
        <div className="in-swatches" role="radiogroup" aria-label="Màu">
          {PALETTE.map((c) => (
            <button
              type="button"
              key={c}
              className={`in-swatch ${asset.color === c ? 'active' : ''}`}
              style={{ background: c }}
              onClick={() => update({ color: c })}
              aria-label={`Màu ${c}`}
              aria-checked={asset.color === c}
              role="radio"
            />
          ))}
        </div>
      </div>

      <Section id="a-images" title="Ảnh" meta={<span className="badge">{asset.imageIds.length}</span>}>
        <div className="in-images">
          {asset.imageIds.map((id, i) => (
            <ImageTile key={id} id={id} primary={i === 0} onOpen={() => viewImages(asset.imageIds, i, asset.name)}>
              {i === 0 ? (
                <span className="in-image-badge">ảnh chính</span>
              ) : (
                <button
                  type="button"
                  className="in-image-make"
                  disabled={busy}
                  onClick={() => withRenumberToast(() => update({ imageIds: [id, ...asset.imageIds.filter((x) => x !== id)] }), 'Đã đổi ảnh chính')}
                  title="Đặt làm ảnh chính"
                >
                  Đặt chính
                </button>
              )}
              <button
                type="button"
                className="in-image-x"
                disabled={busy}
                onClick={() => withRenumberToast(() => update({ imageIds: asset.imageIds.filter((x) => x !== id) }), `Đã bỏ 1 ảnh của “${asset.name}”`, true)}
                title="Bỏ ảnh này"
                aria-label="Bỏ ảnh"
              >
                <X size={11} />
              </button>
            </ImageTile>
          ))}
          <button
            type="button"
            className="in-image-add"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            aria-busy={busy}
            title={busy ? 'Đang lưu ảnh…' : 'Thêm ảnh'}
          >
            <ImagePlus size={16} />
            <span>{busy ? 'Đang lưu…' : 'Thêm'}</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              if (files.length) void addImageFiles(assetId, files)
            }}
          />
        </div>
      </Section>

      <UsedIn assetId={assetId} tag={asset.tag} />

      <section className="in-section in-asset-actions">
        <LinkToScenes assetId={assetId} />
        <button type="button" className="btn btn-sm" onClick={toggleCanvas}>
          {asset.position ? <Unlink size={13} /> : <MapPinned size={13} />}
          {asset.position ? 'Bỏ khỏi canvas' : 'Đặt lên canvas'}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => useUI.getState().openDialog({ kind: 'asset', assetId })}>
          <Pencil size={13} /> Sửa chi tiết
        </button>
      </section>
    </div>
  )
}

/** Tallest the main image may get in the panel (px); wider images use the full panel width. */
const HERO_MAX_H = 320

/** The asset's primary image in full at its own aspect ratio (no crop); click opens the full-screen viewer. */
function AssetHero({ asset, children }: { asset: Asset; children: ReactNode }) {
  const id = asset.imageIds[0]
  const size = useImageSize(id)
  const ar = aspectOf(size, 1, 0.4, 2.6)
  if (!id) {
    return (
      <div className="in-asset-hero is-empty" style={{ ['--asset' as string]: asset.color }}>
        <div className="in-asset-noimg">Chưa có ảnh</div>
        {children}
      </div>
    )
  }
  return (
    <div className="in-asset-hero">
      <div className="in-asset-figure" style={{ ['--asset' as string]: asset.color, width: `min(100%, ${Math.round(HERO_MAX_H * ar)}px)` } as CSSProperties}>
        <FullImage
          id={id}
          alt={asset.name}
          className="in-asset-full"
          minAspect={0.4}
          maxAspect={2.6}
          onClick={() => viewImages(asset.imageIds, 0, asset.name)}
          title={size ? `Bấm để xem ảnh đầy đủ (${size.w}×${size.h})` : 'Bấm để xem ảnh đầy đủ'}
        />
        {children}
      </div>
    </div>
  )
}

/** Height of the image tiles under "Ảnh" (px): each tile is as wide as its picture (whole image, no crop). */
const TILE_H = 76

function ImageTile({ id, primary, onOpen, children }: { id: string; primary: boolean; onOpen: () => void; children: ReactNode }) {
  const size = useImageSize(id)
  const ar = aspectOf(size, 1, 0.75, 2)
  return (
    <div className={`in-image ${primary ? 'is-primary' : ''}`} style={{ width: Math.round(TILE_H * ar) }}>
      <FullImage id={id} fill className="in-image-full" onClick={onOpen} title={size ? `Bấm để xem ảnh đầy đủ (${size.w}×${size.h})` : 'Bấm để xem ảnh đầy đủ'} />
      {children}
    </div>
  )
}

const UsedIn = memo(function UsedIn({ assetId, tag }: { assetId: string; tag: string }) {
  const keys = useProject(
    useShallow((s) =>
      s.project.scenes
        .filter((x) => x.refs.includes(assetId) || x.firstFrame === assetId || x.lastFrame === assetId)
        .map((x) => `${x.order}${SEP}${x.id}${SEP}${x.title}${SEP}${x.refs.includes(assetId) ? 'r' : ''}${x.firstFrame === assetId ? 'f' : ''}${x.lastFrame === assetId ? 'l' : ''}`),
    ),
  )
  const rows = useMemo(
    () =>
      keys
        .map((k) => {
          const [order, id, title, flags] = k.split(SEP)
          return { id, order: Number(order), title, isRef: flags.includes('r'), first: flags.includes('f'), last: flags.includes('l') }
        })
        .sort((a, b) => a.order - b.order),
    [keys],
  )
  const refRows = rows.filter((r) => r.isRef)
  const removeAll = () => {
    withRenumberToast(() => useProject.getState().removeRefs(refRows.map((r) => ({ sceneId: r.id, assetId }))), `Đã bỏ @${tag} khỏi ${refRows.length} cảnh`, true)
  }
  return (
    <Section
      id="a-usedin"
      title={`Dùng ở ${refRows.length} cảnh`}
      extra={
        refRows.length > 0 && (
          <button type="button" className="btn btn-sm btn-ghost in-mini" onClick={removeAll} title="Bỏ nối khỏi tất cả cảnh">
            <Unlink size={12} /> Bỏ khỏi tất cả
          </button>
        )
      }
    >
      {rows.length === 0 ? (
        <div className="in-refs-empty">Chưa nối vào cảnh nào. Kéo thẻ này vào một cảnh, hoặc gõ @ trong prompt của cảnh để nối & chèn.</div>
      ) : (
        <div className="in-usedin">
          {rows.map((r) => (
            <div key={r.id} className="in-usedin-row">
              <button
                type="button"
                className="in-usedin-main"
                onClick={() => {
                  useUI.getState().select([r.id])
                  focusNodes([r.id])
                }}
                title="Chọn cảnh và di chuyển tới"
              >
                <span className="in-code-chip mono">{sceneCode(r.order)}</span>
                <span className={`in-usedin-title ${r.title ? '' : 'faint'}`}>{r.title || 'Chưa đặt tên'}</span>
                {r.first && <span className="in-frame-tag is-first">đầu</span>}
                {r.last && <span className="in-frame-tag is-last">cuối</span>}
                <LocateFixed size={12} className="in-usedin-go" />
              </button>
              {r.isRef && (
                <button
                  type="button"
                  className="in-x"
                  onClick={() => withRenumberToast(() => useProject.getState().removeRef(r.id, assetId), `Đã bỏ @${tag} khỏi ${sceneCode(r.order)}`, true)}
                  title="Bỏ nối khỏi cảnh này"
                  aria-label="Bỏ nối"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  )
})

/** "Nối vào cảnh…": toggle list of all scenes. */
function LinkToScenes({ assetId }: { assetId: string }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  return (
    <div className="in-pop-host">
      <button ref={btn} type="button" className="btn btn-sm btn-primary" onClick={() => setOpen((o) => !o)}>
        <Link2 size={13} /> Nối vào cảnh…
      </button>
      {open && <ScenePicker assetId={assetId} ignoreRef={btn} onClose={() => setOpen(false)} />}
    </div>
  )
}

function ScenePicker({ assetId, ignoreRef, onClose }: { assetId: string; ignoreRef: RefObject<HTMLElement | null>; onClose: () => void }) {
  const keys = useProject(useShallow((s) => s.project.scenes.map((x) => `${x.order}${SEP}${x.id}${SEP}${x.title}${SEP}${x.refs.includes(assetId) ? '1' : ''}`)))
  const items = useMemo<PickItem[]>(
    () =>
      keys
        .map((k) => {
          const [order, id, title, linked] = k.split(SEP)
          return { id, order: Number(order), title, linked: linked === '1' }
        })
        .sort((a, b) => a.order - b.order)
        .map((r) => ({
          id: r.id,
          label: `${sceneCode(r.order)} · ${r.title || 'Chưa đặt tên'}`,
          search: fold(`${sceneCode(r.order)} ${r.title}`),
          checked: r.linked,
        })),
    [keys],
  )
  return (
    <PickerPopover
      items={items}
      ignoreRef={ignoreRef}
      title="Bấm để nối / bỏ nối"
      placeholder="Tìm cảnh (S03, tên…)"
      emptyText="Chưa có cảnh nào."
      onClose={onClose}
      onPick={(sceneId) => {
        const { project } = useProject.getState()
        const scene = project.scenes.find((s) => s.id === sceneId)
        if (!scene) return
        if (!scene.refs.includes(assetId)) {
          linkAssets([sceneId], [assetId])
          return
        }
        // Un-linking turns this asset's @image_N tokens into its name and renumbers the others (like UsedIn's X).
        const tag = project.assets.find((a) => a.id === assetId)?.tag ?? ''
        withRenumberToast(() => useProject.getState().removeRef(sceneId, assetId), `Đã bỏ @${tag} khỏi ${sceneCode(scene.order)}`, true)
      }}
    />
  )
}
