import { useEffect, useRef } from 'react'
import { CanvasView } from './components/canvas/CanvasView'
import { LEFT_PANEL, PanelResizer, RIGHT_PANEL, usePanelWidths } from './components/common/PanelResizer'
import { Toasts } from './components/common/Toasts'
import { ImportDialog } from './components/dialogs/ImportDialog'
import { ProjectsDialog } from './components/dialogs/ProjectsDialog'
import { SettingsDialog } from './components/dialogs/SettingsDialog'
import { ShortcutsDialog } from './components/dialogs/ShortcutsDialog'
import { Inspector } from './components/inspector/Inspector'
import { QueueDrawer } from './components/runs/QueueDrawer'
import { RunConfirmDialog } from './components/runs/RunConfirmDialog'
import { TakeViewer } from './components/runs/TakeViewer'
import { AssetDialog } from './components/sidebar/AssetDialog'
import { BlockDialog } from './components/sidebar/BlockDialog'
import { Sidebar } from './components/sidebar/Sidebar'
import { TopBar } from './components/topbar/TopBar'
import { SceneTable } from './components/views/SceneTable'
import { Storyboard } from './components/views/Storyboard'
import { useShortcuts } from './hooks/useShortcuts'
import { bootstrap, useSave } from './store/persist'
import { useUI } from './store/ui'

export function App() {
  const ready = useSave((s) => s.ready)
  useEffect(() => {
    void bootstrap()
  }, [])
  if (!ready) return <div className="app-loading">Đang mở dự án…</div>
  return <Shell />
}

function Shell() {
  useShortcuts()
  const view = useUI((s) => s.view)
  const leftOpen = useUI((s) => s.leftOpen)
  const rightOpen = useUI((s) => s.rightOpen)
  const root = useRef<HTMLDivElement>(null)
  usePanelWidths(root)
  return (
    <div className="app" ref={root}>
      <TopBar />
      <div className="app-main">
        {leftOpen && (
          <aside className="app-left">
            <Sidebar />
          </aside>
        )}
        {leftOpen && <PanelResizer spec={LEFT_PANEL} side="left" root={root} onCollapse={() => useUI.getState().setLeftOpen(false)} />}
        <main className="app-center">
          {view === 'canvas' ? <CanvasView /> : view === 'table' ? <SceneTable /> : <Storyboard />}
          <QueueDrawer />
        </main>
        {rightOpen && <PanelResizer spec={RIGHT_PANEL} side="right" root={root} onCollapse={() => useUI.getState().setRightOpen(false)} />}
        {rightOpen && (
          <aside className="app-right">
            <Inspector />
          </aside>
        )}
      </div>
      <Dialogs />
      <Toasts />
    </div>
  )
}

function Dialogs() {
  const dialog = useUI((s) => s.dialog)
  switch (dialog.kind) {
    case 'import':
      return <ImportDialog />
    case 'settings':
      return <SettingsDialog />
    case 'shortcuts':
      return <ShortcutsDialog />
    case 'projects':
      return <ProjectsDialog />
    case 'runConfirm':
      return <RunConfirmDialog sceneIds={dialog.sceneIds} />
    case 'take':
      return <TakeViewer takeId={dialog.takeId} />
    case 'asset':
      return <AssetDialog assetId={dialog.assetId} />
    case 'block':
      return <BlockDialog blockId={dialog.blockId} />
    default:
      return null
  }
}
