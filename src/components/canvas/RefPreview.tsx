// Floating preview of a reference image (hover on a scene card avatar): the WHOLE picture at its own aspect ratio,
// with the asset name and its @image number(s). Rendered in a portal at screen size (readable at any canvas zoom),
// only for the avatar under the pointer. It never takes pointer events, so it cannot steal the hover.
import { createPortal } from 'react-dom'
import type { Asset } from '../../core/types'
import { aspectOf, useImageSize } from '../../lib/imageMeta'
import { FullImage } from '../common/Media'
import { placePopover, PREVIEW_CAPTION_H, PREVIEW_MIN_W, PREVIEW_PAD, previewSize } from './canvasModel'

export interface PreviewAnchor {
  left: number
  top: number
  right: number
  bottom: number
}

export function RefPreview({ asset, label, anchor }: { asset: Asset; label: string; anchor: PreviewAnchor }) {
  const id = asset.imageIds[0]
  const size = useImageSize(id)
  const img = previewSize(aspectOf(size, 1))
  // Card (border-box, 1px border): padding around the image, no bottom padding under the caption row.
  const w = Math.max(PREVIEW_MIN_W, img.w + 2 * PREVIEW_PAD + 2)
  const h = img.h + PREVIEW_PAD + PREVIEW_CAPTION_H + 2
  const pos = placePopover(anchor, w, h, window.innerWidth, window.innerHeight)
  const more = asset.imageIds.length - 1
  return createPortal(
    <div className="cv-ref-preview material nodrag nopan" style={{ left: pos.left, top: pos.top, width: w }} role="tooltip">
      <div className="cv-ref-preview-img" style={{ width: img.w, height: img.h }}>
        <FullImage id={id} alt={asset.name} fill />
      </div>
      <div className="cv-ref-preview-cap">
        <span className="cv-ref-preview-name" style={{ ['--av-c' as string]: asset.color }}>
          {asset.name}
        </span>
        {more > 0 && <span className="cv-ref-preview-more">+{more} ảnh</span>}
        <span className="cv-ref-preview-tok">{label}</span>
      </div>
    </div>,
    document.body,
  )
}
