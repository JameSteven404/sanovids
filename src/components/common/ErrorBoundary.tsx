import { RotateCw, TriangleAlert } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { flush } from '../../store/persist'
import { errorSummary, isChunkLoadError } from './errorInfo'
import './common.css'

/** Save what can be saved, then reload the page (never waits more than a few seconds for storage). */
export function saveAndReloadPage() {
  const timeout = new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 3000))
  void Promise.race([flush().catch(() => false), timeout]).finally(() => window.location.reload())
}

interface Props {
  /** What crashed, as the user knows it ("Thư viện", "Bảng thuộc tính", "Canvas"…). */
  area: string
  /** 'panel' fills its container (sidebar, inspector, center view); 'bar' is one line (top bar, queue). */
  variant?: 'panel' | 'bar'
  /** Extra class on the fallback, to place it (e.g. the queue bar at the bottom of the center view). */
  className?: string
  children: ReactNode
}

interface State {
  error: unknown
  failed: boolean
}

/**
 * Keeps one crashing part of the app (sidebar, inspector, center view…) from blanking the whole window: the part
 * shows a short Vietnamese message with "Tải lại" (render it again) and "Tải lại trang". Renders its children
 * as they are (no wrapper element), so layout selectors such as `.app-center > .rq-drawer` keep working.
 */
export class SectionBoundary extends Component<Props, State> {
  state: State = { error: null, failed: false }

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[SanoVids] "${this.props.area}" crashed`, error, info.componentStack)
  }

  private retry = () => this.setState({ error: null, failed: false })

  render() {
    if (!this.state.failed) return this.props.children
    const { area, variant = 'panel', className = '' } = this.props
    const chunk = isChunkLoadError(this.state.error)
    const message = chunk
      ? 'Không tải được phần này (mất mạng hoặc vừa có bản cập nhật). Hãy tải lại trang.'
      : 'Phần này gặp lỗi nên tạm dừng; phần còn lại vẫn dùng bình thường và dự án vẫn được tự lưu.'
    if (variant === 'bar') {
      return (
        <div className={`app-crash bar ${className}`} role="alert">
          <TriangleAlert size={14} className="app-crash-icon" aria-hidden="true" />
          <span className="app-crash-bar-text">
            <b>{area}</b> gặp lỗi.
          </span>
          {!chunk && (
            <button type="button" className="btn btn-sm" onClick={this.retry}>
              <RotateCw size={13} />
              Tải lại
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={saveAndReloadPage}>
            Tải lại trang
          </button>
        </div>
      )
    }
    return (
      <div className={`app-crash ${className}`} role="alert">
        <span className="app-crash-glyph" aria-hidden="true">
          <TriangleAlert size={22} />
        </span>
        <b className="app-crash-title">{area} gặp lỗi</b>
        <span className="app-crash-text">{message}</span>
        <code className="app-crash-detail">{errorSummary(this.state.error)}</code>
        <div className="app-crash-actions">
          {!chunk && (
            <button type="button" className="btn btn-primary" onClick={this.retry}>
              <RotateCw size={14} />
              Tải lại
            </button>
          )}
          <button type="button" className={chunk ? 'btn btn-primary' : 'btn btn-ghost'} onClick={saveAndReloadPage}>
            Tải lại trang
          </button>
        </div>
      </div>
    )
  }
}
