import { X } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { Asset } from '../../core/types'
import { useMediaUrl } from '../../lib/imageStore'

/** <img> for an image-store key. Renders an empty box while loading. */
export function MediaImg({ id, alt = '', className = 'media-img', style }: { id: string | null | undefined; alt?: string; className?: string; style?: CSSProperties }) {
  const url = useMediaUrl(id)
  return url ? <img src={url} alt={alt} className={className} style={style} draggable={false} /> : <div className={className} style={style} />
}

/** Round (characters) or square (locations/props) thumbnail of an asset's primary image. */
export function AssetAvatar({ asset, size = 28, ring = false }: { asset: Asset; size?: number; ring?: boolean }) {
  const url = useMediaUrl(asset.imageIds[0])
  return (
    <span
      className={`asset-avatar ${asset.kind === 'character' ? '' : 'square'}`}
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
