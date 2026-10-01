import { Component, lazy, Suspense, useEffect, useRef, type ReactNode } from 'react'
import { CanvasView } from './components/canvas/CanvasView'
import { LEFT_PANEL, PanelResizer, RIGHT_PANEL, usePanelWidths } from './components/common/PanelResizer'
import { Toasts } from './components/common/Toasts'
import { Inspector } from './components/inspector/Inspector'
import { QueueDrawer } from './components/runs/QueueDrawer'
import { Sidebar } from './components/sidebar/Sidebar'
import { useFileDropGuard } from './components/sidebar/shared'
import { TopBar } from './components/topbar/TopBar'
import { useShortcuts } from './hooks/useShortcuts'
import { bootstrap, useSave } from './store/persist'
import { toast, useUI, type DialogState } from './store/ui'

// Code splitting: the canvas (default view) ships in the main bundle; the other views and every dialog are
// separate chunks, loaded on first use and prefetched once the browser is idle so opening them stays instant.
const chunks = {
  sceneTable: () => import('./components/views/SceneTable'),
  storyboard: () => import('./components/views/Storyboard'),
  importDialog: () => import('./components/dialogs/ImportDialog'),
  settingsDialog: () => import('./components/dialogs/SettingsDialog'),
  shortcutsDialog: () => import('./components/dialogs/ShortcutsDialog'),
  projectsDialog: () => import('./components/dialogs/ProjectsDialog'),
  runConfirmDialog: () => import('./components/runs/RunConfirmDialog'),
  takeViewer: () => import('./components/runs/TakeViewer'),
  assetDialog: () => import('./components/sidebar/AssetDialog'),
}

const SceneTable = lazy(() => chunks.sceneTable().then((m) => ({ default: m.SceneTable })))
const Storyboard = lazy(() => chunks.storyboard().then((m) => ({ default: m.Storyboard })))
const ImportDialog = lazy(() => chunks.importDialog().then((m) => ({ default: m.ImportDialog })))
const SettingsDialog = lazy(() => chunks.settingsDialog().then((m) => ({ default: m.SettingsDialog })))
const ShortcutsDialog = lazy(() => chunks.shortcutsDialog().then((m) => ({ default: m.ShortcutsDialog })))
const ProjectsDialog = lazy(() => chunks.projectsDialog().then((m) => ({ default: m.ProjectsDialog })))
const RunConfirmDialog = lazy(() => chunks.runConfirmDialog().then((m) => ({ default: m.RunConfirmDialog })))
const TakeViewer = lazy(() => chunks.takeViewer().then((m) => ({ default: m.TakeViewer })))
const AssetDialog = lazy(() => chunks.assetDialog().then((m) => ({ default: m.AssetDialog })))

function usePrefetchChunks() {
  useEffect(() => {
    const run = () => {
      for (const load of Object.values(chunks)) void load().catch(() => undefined)
    }
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(run, { timeout: 5000 })
      return () => window.cancelIdleCallback(id)
    }
    const t = window.setTimeout(run, 2500)
    return () => window.clearTimeout(t)
  }, [])
}

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
  useFileDropGuard()
  usePrefetchChunks()
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
          {view === 'canvas' ? (
            <CanvasView />
          ) : (
            <ViewBoundary key={view}>
              <Suspense fallback={<div className="app-loading">Đang tải…</div>}>{view === 'table' ? <SceneTable /> : <Storyboard />}</Suspense>
            </ViewBoundary>
          )}
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
  if (dialog.kind === 'none') return null
  return (
    <DialogBoundary key={dialog.kind}>
      <Suspense fallback={null}>{renderDialog(dialog)}</Suspense>
    </DialogBoundary>
  )
}

function renderDialog(dialog: DialogState): ReactNode {
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
    default:
      return null
  }
}

// A lazy chunk can fail to load (offline on first visit, or a new version replaced the files). Without a
// boundary React would unmount the whole app; these keep the rest of the UI alive.
class ViewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="app-loading" style={{ flexDirection: 'column', gap: 10 }}>
        <span>Không mở được chế độ xem này (mất mạng hoặc vừa có bản cập nhật).</span>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          Tải lại trang
        </button>
      </div>
    )
  }
}

class DialogBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    toast('Không mở được hộp thoại (mất mạng hoặc vừa có bản cập nhật). Hãy tải lại trang.', { tone: 'error', ms: 6000 })
    useUI.getState().closeDialog()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}
