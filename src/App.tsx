import { Component, lazy, Suspense, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { CanvasView } from './components/canvas/CanvasView'
import { SectionBoundary } from './components/common/ErrorBoundary'
import { errorSummary, isChunkLoadError } from './components/common/errorInfo'
import { LEFT_PANEL, PanelResizer, RIGHT_PANEL, usePanelWidths } from './components/common/PanelResizer'
import { ImageLightbox } from './components/common/ImageLightbox'
import { Toasts } from './components/common/Toasts'
import { Inspector } from './components/inspector/Inspector'
import { QueueDrawer } from './components/runs/QueueDrawer'
import { Sidebar } from './components/sidebar/Sidebar'
import { useFileDropGuard } from './components/sidebar/shared'
import { TopBar } from './components/topbar/TopBar'
import { useShortcuts } from './hooks/useShortcuts'
import { activeProviderId, useProviderPrefs } from './providers'
import { closeDevPrompts, useDevPrompts } from './providers/dev/prompts'
import { bootstrap, useSave } from './store/persist'
import { toast, useUI, type DialogState } from './store/ui'
import { startUpdates } from './updateActions'

let PerfProfiler = ({ children }: { id: string; children: ReactNode }) => <>{children}</>
if (__SANOVIDS_PERF__) PerfProfiler = (await import('./perf/PerfProfiler')).PerfProfiler

// Code splitting: the canvas (the only view shown, core/shownViews) ships in the main bundle; every dialog — the
// "Phát liền" player too — is a separate chunk, loaded on first use and prefetched once the browser is idle so opening
// it stays instant. The hidden Storyboard (components/views) is not imported at all, so it is not bundled.
const chunks = {
  importDialog: () => import('./components/dialogs/ImportDialog'),
  settingsDialog: () => import('./components/dialogs/SettingsDialog'),
  shortcutsDialog: () => import('./components/dialogs/ShortcutsDialog'),
  projectsDialog: () => import('./components/dialogs/ProjectsDialog'),
  runConfirmDialog: () => import('./components/runs/RunConfirmDialog'),
  takeViewer: () => import('./components/runs/TakeViewer'),
  assetDialog: () => import('./components/sidebar/AssetDialog'),
  topUpDialog: () => import('./components/topup/TopUpDialog'),
  devPanel: () => import('./components/dev/DevPanel'),
  devSheets: () => import('./components/dev/DevSheets'),
  updateDialog: () => import('./components/dialogs/UpdateDialog'),
  importJobsDialog: () => import('./components/runs/ImportJobsDialog'),
  filmPlayer: () => import('./components/player/FilmPlayerDialog'),
}

const ImportDialog = lazy(() => chunks.importDialog().then((m) => ({ default: m.ImportDialog })))
const SettingsDialog = lazy(() => chunks.settingsDialog().then((m) => ({ default: m.SettingsDialog })))
const ShortcutsDialog = lazy(() => chunks.shortcutsDialog().then((m) => ({ default: m.ShortcutsDialog })))
const ProjectsDialog = lazy(() => chunks.projectsDialog().then((m) => ({ default: m.ProjectsDialog })))
const RunConfirmDialog = lazy(() => chunks.runConfirmDialog().then((m) => ({ default: m.RunConfirmDialog })))
const TakeViewer = lazy(() => chunks.takeViewer().then((m) => ({ default: m.TakeViewer })))
const AssetDialog = lazy(() => chunks.assetDialog().then((m) => ({ default: m.AssetDialog })))
const TopUpDialog = lazy(() => chunks.topUpDialog().then((m) => ({ default: m.TopUpDialog })))
const DevPanel = lazy(() => chunks.devPanel().then((m) => ({ default: m.DevPanel })))
const DevSheets = lazy(() => chunks.devSheets().then((m) => ({ default: m.DevSheets })))
const UpdateDialog = lazy(() => chunks.updateDialog().then((m) => ({ default: m.UpdateDialog })))
const ImportJobsDialog = lazy(() => chunks.importJobsDialog().then((m) => ({ default: m.ImportJobsDialog })))
// "Test giới hạn" pill (src/devtools/stress): development mode only, never prefetched; a chunk that cannot load shows
// nothing (the tester itself is a separate chunk, loaded by its dev-panel tab).
const StressHud = lazy(
  (): Promise<{ default: ComponentType }> =>
    import('./devtools/stress/StressHud').then((m) => ({ default: m.StressHud })).catch(() => ({ default: () => null })),
)
const FilmPlayerDialog = lazy(() => chunks.filmPlayer().then((m) => ({ default: m.FilmPlayerDialog })))

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
  const [bootError, setBootError] = useState<string | null>(null)
  useEffect(() => {
    bootstrap().catch((e: unknown) => {
      console.error('[SanoVids] startup failed', e)
      setBootError(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
    })
  }, [])
  if (bootError !== null && !ready) return <BootError detail={bootError} />
  if (!ready) return <div className="app-loading busy">Đang mở dự án…</div>
  return <Shell />
}

/**
 * Startup failed (storage blocked by the browser — "block all site data", some private windows — or saved data
 * that cannot be read). Explain instead of showing "Đang mở dự án…" forever.
 */
function BootError({ detail }: { detail: string }) {
  return (
    <div className="app-loading app-boot-error" role="alert">
      <b className="app-boot-error-title">Không mở được dự án</b>
      <span className="app-boot-error-text">
        Trình duyệt không cho SanoVids đọc/ghi bộ nhớ trên máy (ví dụ đang chặn dữ liệu trang web, hoặc cửa sổ ẩn danh), hoặc dữ liệu đã lưu
        không đọc được. Hãy cho phép trang này lưu dữ liệu (biểu tượng ổ khoá / khiên cạnh thanh địa chỉ → Cookie và dữ liệu trang web), rồi
        tải lại trang.
      </span>
      <code className="app-boot-error-detail">{detail}</code>
      <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
        Tải lại trang
      </button>
    </div>
  )
}

function Shell() {
  useEffect(() => {
    if (__SANOVIDS_PERF__) void import('./perf/runner').then((m) => m.exposeHarness()).catch((error) => console.warn('[SanoVids perf]', error))
  }, [])
  useShortcuts()
  useFileDropGuard()
  usePrefetchChunks()
  // App updates (desktop: the main process updater; development mode in a browser: its simulation): state mirror,
  // "download ready" / "updated" toasts. Ref-counted.
  useEffect(() => startUpdates(), [])
  const leftOpen = useUI((s) => s.leftOpen)
  const rightOpen = useUI((s) => s.rightOpen)
  const root = useRef<HTMLDivElement>(null)
  usePanelWidths(root)
  // Each region has its own error boundary: a crash in one (a bad scene in the inspector, the canvas…) shows a
  // short message with "Tải lại" there instead of blanking the whole window.
  return (
    <div className="app" ref={root}>
      <SectionBoundary area="Thanh công cụ" variant="bar" className="app-crash-topbar">
        {__SANOVIDS_PERF__ ? <PerfProfiler id="TopBar"><TopBar /></PerfProfiler> : <TopBar />}
      </SectionBoundary>
      <div className="app-main">
        {leftOpen && (
          <aside className="app-left">
            <SectionBoundary area="Thư viện">
              {__SANOVIDS_PERF__ ? <PerfProfiler id="Sidebar"><Sidebar /></PerfProfiler> : <Sidebar />}
            </SectionBoundary>
          </aside>
        )}
        {leftOpen && <PanelResizer spec={LEFT_PANEL} side="left" root={root} onCollapse={() => useUI.getState().setLeftOpen(false)} />}
        <main className="app-center">
          {/* The only view (core/shownViews): it never unmounts, whatever ui.view says. */}
          <SectionBoundary area="Canvas">
            {__SANOVIDS_PERF__ ? <PerfProfiler id="CanvasInner"><CanvasView /></PerfProfiler> : <CanvasView />}
          </SectionBoundary>
          <SectionBoundary area="Hàng đợi" variant="bar" className="app-crash-queue">
            <QueueDrawer />
          </SectionBoundary>
        </main>
        {rightOpen && <PanelResizer spec={RIGHT_PANEL} side="right" root={root} onCollapse={() => useUI.getState().setRightOpen(false)} />}
        {rightOpen && (
          <aside className="app-right">
            <SectionBoundary area="Bảng thuộc tính">
              {__SANOVIDS_PERF__ ? <PerfProfiler id="Inspector"><Inspector /></PerfProfiler> : <Inspector />}
            </SectionBoundary>
          </aside>
        )}
      </div>
      <Dialogs />
      <DevPrompts />
      <StressHudSlot />
      <Toasts />
    </div>
  )
}

/** The stress tester's pill + clean-up after an interrupted run: only while development mode runs new takes. */
function StressHudSlot() {
  useProviderPrefs((s) => s.provider)
  if (activeProviderId() !== 'dev') return null
  return (
    <Suspense fallback={null}>
      <StressHud />
    </Suspense>
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
      return <SettingsDialog section={dialog.section} />
    case 'shortcuts':
      return <ShortcutsDialog />
    case 'projects':
      return <ProjectsDialog />
    case 'runConfirm':
      return <RunConfirmDialog sceneIds={dialog.sceneIds} follow={dialog.follow} />
    case 'take':
      return <TakeViewer takeId={dialog.takeId} />
    case 'image':
      return <ImageLightbox key={dialog.imageIds.join('|') + dialog.index} imageIds={dialog.imageIds} index={dialog.index} title={dialog.title} />
    case 'asset':
      return <AssetDialog assetId={dialog.assetId} />
    case 'topup':
      return <TopUpDialog tab={dialog.tab} />
    case 'dev':
      return <DevPanel tab={dialog.tab} />
    case 'update':
      return <UpdateDialog />
    case 'importJobs':
      return <ImportJobsDialog back={dialog.back} provider={dialog.provider} />
    case 'player':
      return <FilmPlayerDialog start={dialog.start} />
    default:
      return null
  }
}

/**
 * Development mode's simulated login / SePay "windows" (providers/dev/prompts): sheets above every dialog, shown
 * while the dev bridge waits for an answer. Their chunk loads only when one opens.
 */
function DevPrompts() {
  const open = useDevPrompts((s) => s.login !== null || s.checkout !== null)
  if (!open) return null
  return (
    <DevPromptsBoundary>
      <Suspense fallback={null}>
        <DevSheets />
      </Suspense>
    </DevPromptsBoundary>
  )
}

// The bridge waits for the sheet's answer: if the sheet cannot be shown, answer "closed" so nothing hangs.
class DevPromptsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    console.error('[SanoVids] dev sheet failed', error)
    toast('Không mở được cửa sổ giả lập (đăng nhập / thanh toán) — đã đóng lại. Hãy tải lại trang rồi thử lại.', { tone: 'error', ms: 8000 })
    closeDevPrompts()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

// A dialog can fail: its lazy chunk did not load (offline on first visit, or a new version replaced the files) or
// it crashed. Without a boundary React would unmount the whole app; this one closes the dialog and explains.
// (The window regions use SectionBoundary.)
class DialogBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    if (isChunkLoadError(error)) toast('Không mở được hộp thoại (mất mạng hoặc vừa có bản cập nhật). Hãy tải lại trang.', { tone: 'error', ms: 6000 })
    else {
      console.error('[SanoVids] dialog crashed', error)
      toast(`Hộp thoại gặp lỗi nên đã đóng lại (${errorSummary(error)}).`, { tone: 'error', ms: 8000 })
    }
    useUI.getState().closeDialog()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}
