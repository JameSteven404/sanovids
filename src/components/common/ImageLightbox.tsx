import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useImageSize } from '../../lib/imageMeta'
import { useMediaUrl } from '../../lib/imageStore'
import { useUI } from '../../store/ui'
import { trapTab, useOverlayFocus } from './focus'
import './common.css'

/**
 * Full-screen viewer for reference images: the whole picture at its real aspect ratio, as large as the window allows.
 * ←/→ switch between images, Esc or a click on the backdrop closes. Opened with actions.viewImages().
 */
export function ImageLightbox({ imageIds, index, title }: { imageIds: string[]; index: number; title?: string }) {
  const close = useUI((s) => s.closeDialog)
  const [i, setI] = useState(() => Math.max(0, Math.min(imageIds.length - 1, index)))
  const id = imageIds[i]
  const url = useMediaUrl(id)
  const size = useImageSize(id)
  const many = imageIds.length > 1
  // The viewer is often opened by a double-click: ignore the second press so it does not close the viewer at once.
  const openedAt = useRef(performance.now())
  // Take the keyboard focus (and give it back on close) so keys never reach the canvas behind the viewer.
  const rootRef = useRef<HTMLDivElement>(null)
  useOverlayFocus(rootRef)
  const closeFromBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && performance.now() - openedAt.current > 400) close()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      } else if (many && e.key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        setI((n) => (n + 1) % imageIds.length)
      } else if (many && e.key === 'ArrowLeft') {
        e.preventDefault()
        e.stopPropagation()
        setI((n) => (n - 1 + imageIds.length) % imageIds.length)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [close, many, imageIds.length])

  return (
    <div
      ref={rootRef}
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={title ?? 'Xem ảnh'}
      tabIndex={-1}
      onMouseDown={closeFromBackdrop}
      onKeyDown={trapTab}
    >
      <div className="lightbox-bar material">
        <span className="lightbox-title">{title ?? 'Ảnh tham chiếu'}</span>
        {many && (
          <span className="lightbox-count">
            {i + 1}/{imageIds.length}
          </span>
        )}
        {size && (
          <span className="lightbox-size mono">
            {size.w}×{size.h}
          </span>
        )}
        <button type="button" className="icon-btn lightbox-close" onClick={close} title="Đóng (Esc)" aria-label="Đóng">
          <X size={18} />
        </button>
      </div>
      <div className="lightbox-stage" onMouseDown={closeFromBackdrop}>
        {url ? <img src={url} alt={title ?? ''} className="lightbox-img" draggable={false} /> : <div className="lightbox-loading">Đang tải ảnh…</div>}
      </div>
      {many && (
        <>
          <button type="button" className="lightbox-nav prev material" onClick={() => setI((n) => (n - 1 + imageIds.length) % imageIds.length)} aria-label="Ảnh trước">
            <ChevronLeft size={22} />
          </button>
          <button type="button" className="lightbox-nav next material" onClick={() => setI((n) => (n + 1) % imageIds.length)} aria-label="Ảnh sau">
            <ChevronRight size={22} />
          </button>
        </>
      )}
    </div>
  )
}
