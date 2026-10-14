// The lazy right-click menu host can fail (its chunk did not load, or a menu entry crashed while rendering). It sits
// outside every region boundary, so without this one React would unmount the whole window on a right-click.
import { Component, type ReactNode } from 'react'
import { toast } from '../../store/ui'
import { errorSummary, isChunkLoadError } from '../common/errorInfo'
import { closeContextMenu } from './contextMenuStore'

export class ContextMenuBoundary extends Component<{ children: ReactNode; onChunkError: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    if (isChunkLoadError(error)) {
      // React.lazy keeps a rejected import: the owner makes a new one so the next menu tries the chunk again.
      this.props.onChunkError()
      toast('Không mở được menu chuột phải (mất mạng hoặc vừa có bản cập nhật). Hãy thử lại hoặc tải lại trang.', { tone: 'error', ms: 6000 })
    } else {
      console.error('[SanoVids] context menu crashed', error)
      toast(`Menu chuột phải gặp lỗi nên đã đóng lại (${errorSummary(error)}).`, { tone: 'error', ms: 8000 })
    }
    closeContextMenu(false)
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}
