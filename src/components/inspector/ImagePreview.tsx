// Floating full-image preview for the small square thumbnails of the inspector (reference rows, prompt legend chips).
// The thumbnails stay square on purpose; hovering one shows the WHOLE picture at its real aspect ratio next to it.
// Only one preview per list, rendered only while a thumbnail is hovered (nothing mounted otherwise).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { viewAssetImages } from '../../actions'
import type { Asset } from '../../core/types'
import { aspectOf, useImageSize } from '../../lib/imageMeta'
import { AssetAvatar, FullImage } from '../common/Media'

/** Longest side of the preview box (px). */
const PREVIEW = 240
/** Hover delay so moving the pointer across a list does not flash a preview for every row. */
const DELAY = 120
const GAP = 10
const MARGIN = 8
const MIN_ASPECT = 0.4
const MAX_ASPECT = 2.6

interface Hovered {
  /** The hovered thumbnail: the preview goes away with it. */
  el: HTMLElement
  imageId: string
  caption?: string
  rect: DOMRect
}

/** The preview box: positioned beside `rect` (left of it when there is room — the inspector is the right panel). */
function FloatingPreview({ imageId, caption, rect }: { imageId: string; caption?: string; rect: DOMRect }) {
  const size = useImageSize(imageId)
  const ar = aspectOf(size, 1, MIN_ASPECT, MAX_ASPECT)
  const w = ar >= 1 ? PREVIEW : Math.round(PREVIEW * ar)
  const h = ar >= 1 ? Math.round(PREVIEW / ar) : PREVIEW
  const boxW = w + 8 // padding of .in-hover-preview
  const boxH = h + 8 + 22 // + caption row
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = rect.left - GAP - boxW
  if (left < MARGIN) left = Math.min(vw - boxW - MARGIN, rect.right + GAP)
  left = Math.max(MARGIN, left)
  const top = Math.max(MARGIN, Math.min(vh - boxH - MARGIN, rect.top + rect.height / 2 - boxH / 2))
  return createPortal(
    <div className="in-hover-preview" style={{ left, top, width: boxW }} aria-hidden="true">
      <FullImage id={imageId} minAspect={MIN_ASPECT} maxAspect={MAX_ASPECT} />
      <div className="in-hover-cap">
        {caption && <span className="in-hover-name">{caption}</span>}
        {size && (
          <span className="in-hover-size mono">
            {size.w}×{size.h}
          </span>
        )}
      </div>
    </div>,
    document.body,
  )
}

/**
 * Hover preview for a list of thumbnails: call `show(el, imageId, caption)` from onMouseEnter and `hide()` from
 * onMouseLeave; render `preview` anywhere in the component. Scrolling, pressing a mouse button or a key, dragging,
 * resizing or leaving the window hides it, and so does the hovered thumbnail disappearing.
 */
export function useImagePreview() {
  const [hovered, setHovered] = useState<Hovered | null>(null)
  const timer = useRef<number | undefined>(undefined)

  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    setHovered(null)
  }, [])

  const show = useCallback((el: HTMLElement, imageId: string | null | undefined, caption?: string) => {
    window.clearTimeout(timer.current)
    if (!imageId) {
      setHovered(null)
      return
    }
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      if (!el.isConnected) return
      setHovered({ el, imageId, caption, rect: el.getBoundingClientRect() })
    }, DELAY)
  }, [])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  // The thumbnail can disappear without a mouseleave (undo, ref removed, legend emptied): drop the preview with it.
  // Sets state only when the anchor is gone, so this cannot loop.
  useLayoutEffect(() => {
    if (hovered && !hovered.el.isConnected) setHovered(null)
  })

  const visible = !!hovered
  useEffect(() => {
    if (!visible) return
    // A key press (typing, Ctrl+Z, ↑/↓ reorder…) can move or remove the hovered thumbnail: hide; hover again to see.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') hide()
    }
    window.addEventListener('scroll', hide, true)
    window.addEventListener('mousedown', hide, true)
    window.addEventListener('dragstart', hide, true)
    window.addEventListener('wheel', hide, { capture: true, passive: true })
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', hide)
    window.addEventListener('blur', hide)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('mousedown', hide, true)
      window.removeEventListener('dragstart', hide, true)
      window.removeEventListener('wheel', hide, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', hide)
      window.removeEventListener('blur', hide)
    }
  }, [visible, hide])

  const preview = hovered ? <FloatingPreview imageId={hovered.imageId} caption={hovered.caption} rect={hovered.rect} /> : null
  return { show, hide, preview }
}

export type ImagePreview = ReturnType<typeof useImagePreview>

/**
 * Small square thumbnail of a reference (stays square): hover → floating full-image preview, click → full-screen
 * viewer on image `index` of the asset. Without an image it is a plain avatar.
 */
export function RefThumb({ asset, preview, size = 28, index = 0 }: { asset: Asset; preview: ImagePreview; size?: number; index?: number }) {
  const i = asset.imageIds[index] ? index : 0
  const imageId = asset.imageIds[i]
  if (!imageId) return <AssetAvatar asset={asset} size={size} />
  const total = asset.imageIds.length
  const caption = total > 1 ? `${asset.name} · ảnh ${i + 1}/${total}` : asset.name
  return (
    <button
      type="button"
      className="in-ref-thumb"
      aria-label={`Xem ảnh đầy đủ của ${asset.name}`}
      onMouseEnter={(e) => preview.show(e.currentTarget, imageId, caption)}
      onMouseLeave={preview.hide}
      onClick={() => {
        preview.hide()
        viewAssetImages(asset.id, i)
      }}
    >
      <AssetAvatar asset={asset} size={size} />
    </button>
  )
}
