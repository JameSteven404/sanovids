// Small menu shown when a connection is released on empty canvas.
import { Clapperboard, Film, Folder, FolderPlus, Link2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createSceneFromTake, linkAssets, linkTakes, selectedSceneIds, takeLabel } from '../../actions'
import { sceneCode } from '../../core/compile'
import type { XY } from '../../core/types'
import { createFolderNode, linkScenesToFolder, linkTakesToFolder } from '../../folderActions'
import { useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { assetMapOf, drawerInset, sceneMapOf, snap } from './canvasModel'
import './canvas.css'

export interface ConnectMenuState {
  /** Pointer position relative to the canvas root (px). */
  x: number
  y: number
  /** Flow coordinates of the drop point. */
  flow: XY
  /**
   * `takeId` = the take whose handle was dragged; `takeIds` = it plus the other selected takes it carries.
   * `sceneId` = a scene whose right dot was dragged (auto-save into a folder); `sceneIds` = it plus the selected scenes.
   */
  source: { kind: 'asset'; assetIds: string[] } | { kind: 'take'; takeId: string; takeIds: string[] } | { kind: 'scene'; sceneId: string; sceneIds: string[] }
}

/** Existing folder nodes offered in the menu (the most recent ones). */
const MAX_FOLDER_ITEMS = 3

export function ConnectMenu({ menu, onClose }: { menu: ConnectMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  // A long menu (folder items) is moved up so it stays above the queue drawer that paints over the canvas.
  const [top, setTop] = useState(menu.y)
  useLayoutEffect(() => {
    const el = ref.current
    const stage = el?.parentElement
    if (!el || !stage) return
    const room = stage.clientHeight - drawerInset(stage) - 8
    setTop(Math.max(8, Math.min(menu.y, room - el.offsetHeight)))
  }, [menu.y])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [onClose])

  const project = useProject.getState().project
  const selScenes = selectedSceneIds()
  // Card's left handle lands near the pointer.
  const pos = { x: snap(menu.flow.x + 8), y: snap(menu.flow.y - 64) }
  // A new folder node: its dot (25px below its top) lands near the pointer.
  const folderPos = { x: snap(menu.flow.x + 8), y: snap(menu.flow.y - 24) }
  const folders = (project.folders ?? []).slice(-MAX_FOLDER_ITEMS).reverse()

  const items: { key: string; icon: typeof Link2; label: string; hint?: string; run: () => void; primary?: boolean }[] = []
  if (menu.source.kind === 'asset') {
    const ids = menu.source.assetIds
    const map = assetMapOf(project.assets)
    const tags = ids.map((id) => map.get(id)?.tag).filter(Boolean) as string[]
    const label = tags.length > 2 ? `@${tags[0]} +${tags.length - 1}` : tags.map((t) => '@' + t).join(', ')
    items.push({
      key: 'new',
      icon: Clapperboard,
      label: `Tạo cảnh mới có ${label}`,
      primary: true,
      run: () => {
        const sceneId = useProject.getState().addScene({ refs: [...ids] }, { position: pos })
        useUI.getState().select([sceneId])
        const s = sceneMapOf(useProject.getState().project.scenes).get(sceneId)
        toast(`Đã tạo ${s ? sceneCode(s.order) : 'cảnh mới'} với ${label}.`, { tone: 'success' })
      },
    })
    if (selScenes.length) {
      items.push({
        key: 'sel',
        icon: Link2,
        label: `Nối vào ${selScenes.length} cảnh đang chọn`,
        run: () => linkAssets(selScenes, ids),
      })
    }
  } else if (menu.source.kind === 'take') {
    const { takeId, takeIds } = menu.source
    const label = takeLabel(takeId)
    const what = takeIds.length > 1 ? `${takeIds.length} video` : label
    items.push({
      key: 'continue',
      icon: Film,
      label: 'Tạo cảnh tiếp nối từ video này',
      hint: `${label} thành @video_1, giữ ảnh tham chiếu & cấu hình`,
      primary: true,
      run: () => {
        createSceneFromTake(takeId, pos)
      },
    })
    if (selScenes.length) {
      items.push({
        key: 'sel',
        icon: Link2,
        label: `Dùng làm @video cho ${selScenes.length} cảnh đang chọn`,
        hint: what,
        run: () => linkTakes(selScenes, takeIds),
      })
    }
    for (const f of folders) {
      items.push({ key: `folder:${f.id}`, icon: Folder, label: `Lưu vào thư mục “${f.name}”`, hint: what, run: () => linkTakesToFolder(takeIds, f.id) })
    }
    items.push({
      key: 'folder-new',
      icon: FolderPlus,
      label: 'Lưu vào thư mục mới…',
      hint: 'Chọn một thư mục trên máy: video được sao chép vào đó',
      run: () => void createFolderNode({ position: folderPos, takeIds }),
    })
  } else {
    const { sceneId, sceneIds } = menu.source
    const scene = sceneMapOf(project.scenes).get(sceneId)
    const what = sceneIds.length > 1 ? `${sceneIds.length} cảnh` : scene ? sceneCode(scene.order) : 'cảnh này'
    items.push({
      key: 'folder-new',
      icon: FolderPlus,
      label: 'Tạo thư mục tự lưu…',
      hint: `Mọi video mới của ${what} được lưu vào thư mục bạn chọn`,
      primary: true,
      run: () => void createFolderNode({ position: folderPos, sceneIds }),
    })
    for (const f of folders) {
      items.push({ key: `folder:${f.id}`, icon: Folder, label: `Tự lưu vào thư mục “${f.name}”`, hint: what, run: () => linkScenesToFolder(sceneIds, f.id) })
    }
  }
  items.push({ key: 'cancel', icon: X, label: 'Huỷ', run: () => {} })

  return (
    <div
      ref={ref}
      className="cv-menu material"
      style={{ left: menu.x, top }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => (
        <button
          key={it.key}
          role="menuitem"
          autoFocus={i === 0}
          className={`cv-menu-item ${it.primary ? 'primary' : ''} ${it.key === 'cancel' ? 'cancel' : ''}`}
          onClick={() => {
            onClose()
            it.run()
          }}
        >
          <it.icon size={15} strokeWidth={1.75} />
          <span className="cv-menu-label">
            {it.label}
            {it.hint && <small>{it.hint}</small>}
          </span>
        </button>
      ))}
    </div>
  )
}
