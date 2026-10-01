import { ImagePlus, Library, Link2, Pencil, Pin, PinOff, Plus, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createAssetsFromFiles, ensureAssetToken, focusNodes, linkAssets, selectedSceneIds } from '../../actions'
import { sceneCode } from '../../core/compile'
import type { Asset, AssetKind } from '../../core/types'
import { cachedUrl } from '../../lib/imageStore'
import { useProject, type ProjectState } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { MediaImg } from '../common/Media'
import { Section } from './bits'
import { setDragGhost } from './ghost'
import {
  ASSET_MIME,
  imageTokenLabels,
  KIND_META,
  KIND_ORDER,
  matchesQuery,
  nextAssetPosition,
  undoToastAction,
  usePrefState,
  useSceneCode,
  useSelectedSceneIds,
  useSingleSceneId,
} from './shared'

type KindFilter = 'all' | AssetKind
const EMPTY_COUNTS: Record<string, number> = {}
const EMPTY_LABELS: Record<string, string> = {}

/** Number of scenes whose refs include each asset. */
const usageSelector = (s: ProjectState) => {
  const m: Record<string, number> = {}
  for (const sc of s.project.scenes) for (const r of sc.refs) m[r] = (m[r] ?? 0) + 1
  return m
}

// ---------------- drag & drop (HTML5) ----------------
function dragIdsFor(id: string): string[] {
  const { librarySelection } = useUI.getState()
  const exists = new Set(useProject.getState().project.assets.map((a) => a.id))
  if (!librarySelection.includes(id)) return [id]
  return librarySelection.filter((x) => exists.has(x))
}

function startAssetDrag(e: DragEvent<HTMLElement>, id: string) {
  const ids = dragIdsFor(id)
  const byId = new Map(useProject.getState().project.assets.map((a) => [a.id, a]))
  const list = ids.map((x) => byId.get(x)).filter((a): a is Asset => !!a)
  if (!list.length) {
    e.preventDefault()
    return
  }
  e.dataTransfer.effectAllowed = 'all'
  e.dataTransfer.setData(ASSET_MIME, JSON.stringify(list.map((a) => a.id)))
  // Plain-text fallback (dropped into any text field): the names. The @image number depends on the target scene,
  // so scene drop targets read the asset ids above and link + number them themselves.
  e.dataTransfer.setData('text/plain', list.map((a) => a.name || a.tag).join(', '))
  setDragGhost(
    e,
    list.map((a) => ({
      url: cachedUrl(a.imageIds[0]),
      letter: (a.name || a.tag).slice(0, 1).toUpperCase(),
      color: a.color,
      shape: a.kind === 'character' ? ('round' as const) : ('square' as const),
    })),
    list.length === 1 ? list[0].name || '@' + list[0].tag : `${list.length} mục`,
  )
  useUI.getState().setDraggingAssets(list.map((a) => a.id))
}

function endAssetDrag() {
  useUI.getState().setDraggingAssets(null)
}

// ---------------- card actions ----------------
function openAsset(id: string) {
  useUI.getState().openDialog({ kind: 'asset', assetId: id })
}

function toggleOnCanvas(id: string) {
  const st = useProject.getState()
  const asset = st.project.assets.find((a) => a.id === id)
  if (!asset) return
  const ui = useUI.getState()
  if (asset.position) {
    st.setAssetOnCanvas(id, null)
    if (ui.selectedIds.includes(id)) ui.select(ui.selectedIds.filter((x) => x !== id))
    toast(`Đã bỏ “${asset.name}” khỏi canvas — vẫn còn trong thư viện, các nối giữ nguyên.`, { action: undoToastAction() })
  } else {
    st.setAssetOnCanvas(id, nextAssetPosition(st.project))
    toast(`Đã đặt “${asset.name}” lên canvas.`, { tone: 'success', action: undoToastAction() })
    if (ui.view === 'canvas') setTimeout(() => focusNodes([id]), 80)
  }
}

function linkCardToSelection(id: string) {
  const scenes = selectedSceneIds()
  if (!scenes.length) {
    toast('Chọn một hoặc nhiều cảnh trên canvas / bảng cảnh trước.', { tone: 'warning' })
    return
  }
  linkAssets(scenes, dragIdsFor(id))
}

/** "+ Nối" on a card while one scene is selected: link it and tell which @image number it got. */
function linkToScene(sceneId: string, assetId: string) {
  const token = ensureAssetToken(sceneId, assetId)
  const p = useProject.getState().project
  const scene = p.scenes.find((s) => s.id === sceneId)
  const asset = p.assets.find((a) => a.id === assetId)
  // Not linked: ensureAssetToken already explained why (image limit of the model).
  if (!scene || !asset || !scene.refs.includes(assetId)) return
  toast(`Đã nối “${asset.name}” vào ${sceneCode(scene.order)}${token ? ` → ${token}` : ' (chưa có ảnh nên chưa có số @image)'}.`, {
    tone: 'success',
    action: undoToastAction(),
  })
}

async function copyToken(token: string, code: string) {
  try {
    await navigator.clipboard.writeText(token)
    toast(`Đã copy ${token} — dán vào prompt của ${code}.`, { tone: 'success' })
  } catch {
    toast('Trình duyệt chặn clipboard.', { tone: 'error' })
  }
}

// ---------------- card ----------------
interface CardProps {
  asset: Asset
  usage: number
  selected: boolean
  dragging: boolean
  /** Number of selected scenes that already reference this asset. */
  linked: number
  selScenes: number
  /** Exactly one scene selected: its id / code, else null / ''. */
  singleId: string | null
  singleCode: string
  /** "@image_N" (or range) in that scene; '' = linked but no image yet; undefined = not linked there. */
  token: string | undefined
  /** How many assets a drag / link from this card would carry. */
  groupSize: number
  onSelect: (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, id: string) => void
}

const AssetCard = memo(function AssetCard({ asset, usage, selected, dragging, linked, selScenes, singleId, singleCode, token, groupSize, onSelect }: CardProps) {
  const { Icon, label } = KIND_META[asset.kind]
  const many = selected && groupSize > 1
  const linkTitle = selScenes
    ? `Nối ${many ? `${groupSize} mục đã chọn` : `“${asset.name}”`} vào ${selScenes} cảnh đang chọn`
    : 'Nối vào cảnh đang chọn — hãy chọn cảnh trước'
  const firstToken = token ? token.replace(/–\d+$/, '') : ''
  return (
    <div
      className={`sb-card${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
      style={{ '--sb-c': asset.color } as CSSProperties}
      draggable
      role="option"
      tabIndex={0}
      aria-selected={selected}
      title={`${asset.name} · @${asset.tag}\nKéo vào cảnh để nối · nháy đúp để sửa`}
      onClick={(e) => {
        e.stopPropagation()
        // The 2nd click of a double-click must not undo the selection made by the 1st.
        if (e.detail > 1) return
        onSelect(e, asset.id)
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter') {
          e.preventDefault()
          openAsset(asset.id)
        } else if (e.key === ' ') {
          e.preventDefault()
          useUI.getState().toggleLibrary(asset.id, e.ctrlKey || e.metaKey || e.shiftKey)
        }
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        openAsset(asset.id)
      }}
      onDragStart={(e) => startAssetDrag(e, asset.id)}
      onDragEnd={endAssetDrag}
    >
      <div className="sb-card-media">
        {asset.imageIds[0] ? (
          <MediaImg id={asset.imageIds[0]} alt={asset.name} className="media-img sb-card-img" />
        ) : (
          <div className="sb-card-fallback">
            <span>{(asset.name || asset.tag).slice(0, 1).toUpperCase()}</span>
            <small>Chưa có ảnh</small>
          </div>
        )}
        <span className="sb-card-kind" title={label}>
          <Icon size={11} />
          {asset.position && <i className="sb-card-oncanvas" title="Đang có trên canvas" />}
        </span>
        {asset.imageIds.length > 1 && <span className="sb-card-imgs" title={`${asset.imageIds.length} ảnh — mỗi ảnh một số @image`}>{asset.imageIds.length} ảnh</span>}
        {singleId ? (
          token !== undefined ? (
            token ? (
              <button
                className="sb-token sb-card-token"
                title={`${token} trong ${singleCode}${asset.imageIds.length > 1 ? ` (${asset.imageIds.length} ảnh)` : ''} · bấm để copy ${firstToken}`}
                onClick={(e) => {
                  e.stopPropagation()
                  void copyToken(firstToken, singleCode)
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {token}
              </button>
            ) : (
              <span className="sb-token sb-card-token muted" title={`Đã nối vào ${singleCode} nhưng chưa có ảnh nên chưa có số @image`}>
                Đã nối
              </span>
            )
          ) : (
            <button
              className="sb-connect sb-card-token"
              title={`Nối “${asset.name}” vào ${singleCode} (thêm một số @image)`}
              onClick={(e) => {
                e.stopPropagation()
                linkToScene(singleId, asset.id)
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              + Nối
            </button>
          )
        ) : (
          selScenes > 1 &&
          linked > 0 && (
            <span className="sb-card-linked" title={`Đã nối vào ${linked}/${selScenes} cảnh đang chọn`}>
              {linked}/{selScenes}
            </span>
          )
        )}
        <div className="sb-card-actions">
          <button
            className="sb-card-btn"
            title={asset.position ? 'Bỏ khỏi canvas' : 'Đặt lên canvas'}
            onClick={(e) => {
              e.stopPropagation()
              toggleOnCanvas(asset.id)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {asset.position ? <PinOff size={12} /> : <Pin size={12} />}
          </button>
          {!singleId && (
            <button
              className={`sb-card-btn${selScenes ? ' ref' : ' off'}`}
              title={linkTitle}
              aria-disabled={!selScenes}
              onClick={(e) => {
                e.stopPropagation()
                linkCardToSelection(asset.id)
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <Link2 size={12} />
            </button>
          )}
          <button
            className="sb-card-btn"
            title="Sửa"
            onClick={(e) => {
              e.stopPropagation()
              openAsset(asset.id)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Pencil size={12} />
          </button>
        </div>
      </div>
      <div className="sb-card-info">
        <div className="sb-card-name">{asset.name || <span className="faint">Chưa đặt tên</span>}</div>
        <div className={`sb-card-usage${usage ? '' : ' zero'}`} title={usage ? `Là ảnh tham chiếu của ${usage} cảnh` : 'Chưa nối vào cảnh nào'}>
          {usage ? `dùng ở ${usage} cảnh` : 'chưa dùng'}
        </div>
      </div>
    </div>
  )
})

// ---------------- library ----------------
export function AssetLibrary({ query, collapsed, onToggle }: { query: string; collapsed: boolean; onToggle: () => void }) {
  const assets = useProject((s) => s.project.assets)
  const usage = useProject(useShallow(usageSelector))
  const librarySelection = useUI((s) => s.librarySelection)
  const draggingIds = useUI((s) => s.draggingAssetIds)
  const selectedScenes = useSelectedSceneIds()
  const singleId = useSingleSceneId()
  const singleCode = useSceneCode(singleId)
  const linked = useProject(
    useShallow((s) => {
      if (selectedScenes.length < 2) return EMPTY_COUNTS
      const sel = new Set(selectedScenes)
      const m: Record<string, number> = {}
      for (const sc of s.project.scenes) if (sel.has(sc.id)) for (const r of sc.refs) m[r] = (m[r] ?? 0) + 1
      return m
    }),
  )
  /** @image labels of the single selected scene (string values: shallow-stable while the prompt is typed). */
  const tokens = useProject(
    useShallow((s) => {
      if (!singleId) return EMPTY_LABELS
      const sc = s.project.scenes.find((x) => x.id === singleId)
      return sc ? imageTokenLabels(s.project.assets, sc.refs) : EMPTY_LABELS
    }),
  )
  const [kind, setKind] = usePrefState<KindFilter>('sb-kind', 'all')
  const [fileOver, setFileOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const anchor = useRef<string | null>(null)

  const matched = useMemo(() => assets.filter((a) => matchesQuery(query, a.name, a.tag, a.description)), [assets, query])
  const counts = useMemo(() => {
    const c: Record<KindFilter, number> = { all: matched.length, character: 0, location: 0, prop: 0, style: 0 }
    for (const a of matched) c[a.kind]++
    return c
  }, [matched])
  const visible = useMemo(() => (kind === 'all' ? matched : matched.filter((a) => a.kind === kind)), [matched, kind])
  const selection = useMemo(() => {
    const exists = new Set(assets.map((a) => a.id))
    return librarySelection.filter((id) => exists.has(id))
  }, [assets, librarySelection])
  const selSet = useMemo(() => new Set(selection), [selection])
  const dragSet = useMemo(() => new Set(draggingIds ?? []), [draggingIds])

  // Safety net: if the dragged card unmounts mid-drag its `dragend` never reaches React.
  // No pointerdown can happen during an HTML5 drag, so the next press after it ends clears stale state.
  useEffect(() => {
    if (!draggingIds) return
    const clear = () => {
      if (useUI.getState().draggingAssetIds === draggingIds) useUI.getState().setDraggingAssets(null)
    }
    window.addEventListener('pointerdown', clear, { once: true, capture: true })
    return () => window.removeEventListener('pointerdown', clear, { capture: true })
  }, [draggingIds])

  const onSelect = useCallback(
    (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, id: string) => {
      const ui = useUI.getState()
      if (e.shiftKey && anchor.current && anchor.current !== id) {
        const ids = visible.map((a) => a.id)
        const from = ids.indexOf(anchor.current)
        const to = ids.indexOf(id)
        if (from >= 0 && to >= 0) {
          const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1)
          ui.setLibrarySelection([...new Set([...ui.librarySelection, ...range])])
          return
        }
      }
      ui.toggleLibrary(id, e.ctrlKey || e.metaKey || e.shiftKey)
      anchor.current = id
    },
    [visible],
  )

  const defaultKind: AssetKind = kind === 'all' ? 'character' : kind

  const addFiles = async (files: File[]) => {
    if (!files.length) return
    const ids = await createAssetsFromFiles(files, { kind: defaultKind })
    if (ids.length) useUI.getState().setLibrarySelection(ids)
  }

  const createEmpty = () => {
    const id = useProject.getState().addAsset({ name: KIND_META[defaultKind].newName, kind: defaultKind })
    useUI.getState().setLibrarySelection([id])
    openAsset(id)
  }

  const isFileDrag = (e: DragEvent) => e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes(ASSET_MIME)

  const kinds: KindFilter[] = ['all', ...KIND_ORDER.filter((k) => counts[k] > 0 || kind === k)]

  const toolbar = (
    <>
      <div className="sb-kinds" role="tablist" aria-label="Lọc theo loại">
        {kinds.map((k) => {
          const meta = k === 'all' ? null : KIND_META[k]
          const Icon = meta?.Icon
          return (
            <button key={k} role="tab" aria-selected={kind === k} className={`sb-kind${kind === k ? ' active' : ''}`} onClick={() => setKind(k)}>
              {Icon && <Icon size={11} />}
              <span>{meta ? meta.label : 'Tất cả'}</span>
              <span className="sb-kind-n">{counts[k]}</span>
            </button>
          )
        })}
      </div>
      {singleId && (
        <div className="sb-explain">
          Số <span className="sb-tok">@image</span> trong <b className="sb-accent">{singleCode}</b> · bấm số để copy, <b>+ Nối</b> để thêm.
        </div>
      )}
    </>
  )

  const footer = selection.length ? (
    <div className="sb-libfoot sel">
      <span className="sb-libfoot-count">
        <b>{selection.length}</b> đã chọn
      </span>
      <button
        className="btn btn-sm sb-link-btn"
        disabled={!selectedScenes.length}
        title={selectedScenes.length ? `Nối ${selection.length} mục vào ${selectedScenes.length} cảnh đang chọn (C)` : 'Chọn cảnh trên canvas / bảng cảnh trước'}
        onClick={() => linkAssets(selectedScenes, selection)}
      >
        <Link2 size={13} />
        {selectedScenes.length ? `Nối vào ${selectedScenes.length} cảnh` : 'Chưa chọn cảnh'}
      </button>
      <button className="icon-btn sb-xs" title="Bỏ chọn" aria-label="Bỏ chọn" onClick={() => useUI.getState().setLibrarySelection([])}>
        <X size={13} />
      </button>
    </div>
  ) : (
    <div className="sb-libfoot hint">
      Kéo thả vào cảnh để nối · chọn nhiều + <span className="kbd">C</span> để nối hàng loạt
    </div>
  )

  return (
    <Section
      className={`sb-library${fileOver ? ' file-over' : ''}`}
      title="Thư viện"
      icon={<Library size={14} />}
      count={query.trim() ? `${matched.length}/${assets.length}` : assets.length}
      collapsed={collapsed}
      onToggle={onToggle}
      grow={5}
      toolbar={assets.length ? toolbar : undefined}
      footer={assets.length ? footer : undefined}
      actions={
        <>
          <button className="btn btn-ghost btn-sm" title="Thêm ảnh vào thư viện (chọn nhiều file được)" onClick={() => fileInput.current?.click()}>
            <ImagePlus size={13} />
            Thêm
          </button>
          <button className="icon-btn sb-xs" title={`Tạo ${KIND_META[defaultKind].label.toLowerCase()} trống (chưa có ảnh)`} onClick={createEmpty}>
            <Plus size={14} />
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              void addFiles(files)
            }}
          />
        </>
      }
      rootProps={{
        onDragOver: (e) => {
          if (!isFileDrag(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          if (!fileOver) setFileOver(true)
        },
        onDragLeave: (e) => {
          const next = e.relatedTarget as Node | null
          if (!next || !e.currentTarget.contains(next)) setFileOver(false)
        },
        onDrop: (e) => {
          if (!isFileDrag(e)) return
          e.preventDefault()
          setFileOver(false)
          void addFiles(Array.from(e.dataTransfer.files))
        },
      }}
      bodyProps={{
        onClick: () => {
          if (useUI.getState().librarySelection.length) useUI.getState().setLibrarySelection([])
        },
      }}
    >
      {!assets.length ? (
        <div className="empty sb-empty">
          <ImagePlus size={22} />
          <div>Thư viện trống.</div>
          <div className="faint">Thêm ảnh nhân vật, bối cảnh, đạo cụ — rồi kéo vào cảnh để nối. Có thể thả file ảnh vào đây.</div>
          <button
            className="btn btn-sm"
            onClick={(e) => {
              e.stopPropagation()
              fileInput.current?.click()
            }}
          >
            <ImagePlus size={13} />
            Thêm ảnh
          </button>
        </div>
      ) : !visible.length ? (
        <div className="empty sb-empty">
          {query.trim()
            ? `Không có kết quả cho “${query.trim()}”${kind !== 'all' ? ` trong ${KIND_META[kind].label.toLowerCase()}` : ''}.`
            : `Chưa có ${kind === 'all' ? 'mục' : KIND_META[kind].label.toLowerCase()} nào.`}
        </div>
      ) : (
        <div className="sb-grid" role="listbox" aria-multiselectable="true" aria-label="Thư viện">
          {visible.map((a) => (
            <AssetCard
              key={a.id}
              asset={a}
              usage={usage[a.id] ?? 0}
              selected={selSet.has(a.id)}
              dragging={dragSet.has(a.id)}
              linked={linked[a.id] ?? 0}
              selScenes={selectedScenes.length}
              singleId={singleId}
              singleCode={singleCode}
              token={singleId ? tokens[a.id] : undefined}
              groupSize={selection.length}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
      {fileOver && (
        <div className="sb-dropzone">
          <ImagePlus size={20} />
          Thả ảnh để thêm vào {KIND_META[defaultKind].label.toLowerCase()}
        </div>
      )}
    </Section>
  )
}
