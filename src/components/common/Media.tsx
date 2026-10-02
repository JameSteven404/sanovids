import { X } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { Asset } from '../../core/types'
import { aspectOf, useImageSize } from '../../lib/imageMeta'
import { useMediaUrl } from '../../lib/imageStore'

/** <img> for an image-store key. Renders an empty box while loading. */
export function MediaImg({ id, alt = '', className = 'media-img', style }: { id: string | null | undefined; alt?: string; className?: string; style?: CSSProperties }) {
  const url = useMediaUrl(id)
  return url ? <img src={url} alt={alt} className={className} style={style} draggable={false} /> : <div className={className} style={style} />
}

/**
 * The WHOLE image at its real aspect ratio (object-fit: contain, never cropped). The box takes the image's aspect
 * ratio unless `fill` is set, in which case it fills its parent and letterboxes the picture.
 */
export function FullImage({
  id,
  alt = '',
  className = '',
  fill = false,
  maxAspect = 2.6,
  minAspect = 0.4,
  onClick,
  title,
}: {
  id: string | null | undefined
  alt?: string
  className?: string
  fill?: boolean
  maxAspect?: number
  minAspect?: number
  onClick?: () => void
  title?: string
}) {
  const url = useMediaUrl(id)
  const size = useImageSize(id)
  const style: CSSProperties = fill ? {} : { aspectRatio: String(aspectOf(size, 1, minAspect, maxAspect)) }
  return (
    <div className={`full-img ${fill ? 'fill' : ''} ${onClick ? 'zoomable' : ''} ${className}`} style={style} onClick={onClick} title={title}>
      {url && <img src={url} alt={alt} draggable={false} />}
    </div>
  )
}

/** Square thumbnail of an asset's primary image (all kinds). */
export function AssetAvatar({ asset, size = 28, ring = false }: { asset: Asset; size?: number; ring?: boolean }) {
  const url = useMediaUrl(asset.imageIds[0])
  return (
    <span
      className="asset-avatar square"
      style={{ width: size, height: size, ['--avatar-ring' as string]: ring ? asset.color : 'transparent' }}
      title={`${asset.name} · @${asset.tag}`}
    >
      {url ? (
        <img src={url} alt={asset.name} draggable={false} />
      ) : (
        <span className="fallback" style={{ background: asset.color, fontSize: size * 0.42 }}>
          {asset.name.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  )
}

/** Avatar + @tag pill, optionally removable. `index` shows the @image number. */
export function AssetChip({ asset, onRemove, index }: { asset: Asset; onRemove?: () => void; index?: number }) {
  return (
    <span className="chip" style={{ borderColor: asset.color + '66' }}>
      <AssetAvatar asset={asset} size={20} />
      {index !== undefined && <span className="mono faint">{index}</span>}
      <span>@{asset.tag}</span>
      {onRemove && (
        <button className="x" onClick={onRemove} title="Bỏ nối" aria-label={`Bỏ nối ${asset.name}`}>
          <X size={12} />
        </button>
      )}
    </span>
  )
}
