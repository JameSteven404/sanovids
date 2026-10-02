// Asset card on the canvas (character / location / prop / style). Source of reference wires.
// Shows the WHOLE primary image at its own aspect ratio (never cropped): by default the card follows the image
// (width ASSET_DEFAULT_W, height = image + name/meta rows); once resized, the picture letterboxes inside the card.
import { Handle, Position, useStore, type Node, type NodeProps } from '@xyflow/react'
import { Box, MapPin, Maximize2, Palette, User } from 'lucide-react'
import { memo, type SyntheticEvent } from 'react'
import { viewAssetImages } from '../../actions'
import type { AssetKind } from '../../core/types'
import { aspectOf, useImageSize } from '../../lib/imageMeta'
import { useProject } from '../../store/project'
import { useUI } from '../../store/ui'
import { FullImage } from '../common/Media'
import { ASSET_MAX_ASPECT, ASSET_MIN_ASPECT, assetDefaultLayout, assetMapOf, KIND_LABEL, LOD_ZOOM, usageOf } from './canvasModel'
import { NodeSizer, useNodeBox, useRemeasureOn } from './NodeSizer'
import './canvas.css'

export type AssetFlowNode = Node<Record<string, unknown>, 'asset'>

const KIND_ICON: Record<AssetKind, typeof User> = { character: User, location: MapPin, prop: Box, style: Palette }

/** Keep a press on the image buttons away from node drag / selection / the double-click dialog. */
const stop = (e: SyntheticEvent) => e.stopPropagation()

function AssetNodeView({ id, selected }: NodeProps<AssetFlowNode>) {
  const asset = useProject((s) => assetMapOf(s.project.assets).get(id))
  const usage = useProject((s) => usageOf(s.project.scenes).get(id) ?? 0)
  const far = useStore((s) => s.transform[2] < LOD_ZOOM)
  const primary = asset?.imageIds[0]
  const imgSize = useImageSize(primary)
  const box = useNodeBox(id, asset?.size)
  // Square until the image's natural size is known, then its own (clamped) aspect ratio.
  const aspect = primary ? aspectOf(imgSize, 1, ASSET_MIN_ASPECT, ASSET_MAX_ASPECT) : 1

  // The default card changes height once the aspect is known: re-measure the node (handle bounds) right away.
  useRemeasureOn(id, aspect)

  if (!asset) return null
  // Unknown kind (data from a newer version / a broken import): fall back to the character icon instead of crashing.
  const Icon = KIND_ICON[asset.kind] ?? User
  const count = asset.imageIds.length
  const def = box ? null : assetDefaultLayout(aspect)
  const cls = ['cv-asset', selected && 'is-selected', box && 'is-sized', far && 'is-far', `kind-${asset.kind}`].filter(Boolean).join(' ')
  return (
    <>
      <div
        className={cls}
        style={{ ['--asset-c' as string]: asset.color, ...(def ? { width: def.w } : null) }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          useUI.getState().openDialog({ kind: 'asset', assetId: asset.id })
        }}
      >
        <div className="cv-asset-img" style={def ? { height: def.imgH } : undefined}>
          {primary ? (
            <FullImage id={primary} alt={asset.name} fill />
          ) : (
            <span className="cv-asset-fallback">{asset.name.slice(0, 1).toUpperCase()}</span>
          )}
          {primary && !far && (
            <button
              className="cv-asset-zoom nodrag nopan"
              title="Xem ảnh đầy đủ"
              aria-label={`Xem ảnh ${asset.name}`}
              onPointerDown={stop}
              onDoubleClick={stop}
              onClick={(e) => {
                e.stopPropagation()
                viewAssetImages(asset.id)
              }}
            >
              <Maximize2 size={12} strokeWidth={2.2} />
            </button>
          )}
          {count > 1 &&
            (far ? (
              <span className="cv-asset-count">+{count - 1} ảnh</span>
            ) : (
              <button
                className="cv-asset-count nodrag nopan"
                title={`Xem cả ${count} ảnh`}
                onPointerDown={stop}
                onDoubleClick={stop}
                onClick={(e) => {
                  e.stopPropagation()
                  viewAssetImages(asset.id, 1)
                }}
              >
                +{count - 1} ảnh
              </button>
            ))}
        </div>
        <div className="cv-asset-name">
          <Icon size={12} strokeWidth={2} className="cv-asset-kind" aria-label={KIND_LABEL[asset.kind] ?? KIND_LABEL.character} />
          <span>{asset.name}</span>
        </div>
        <div className="cv-asset-meta">
          <span className="cv-asset-tag">@{asset.tag}</span>
          <span className={`cv-asset-usage ${usage ? '' : 'none'}`}>{usage ? `dùng ở ${usage} cảnh` : 'chưa dùng'}</span>
        </div>
        <Handle type="source" position={Position.Right} id="out" className="cv-h cv-h-out" title="Kéo thả vào bất kỳ đâu trên thẻ cảnh để nối" />
      </div>
      <NodeSizer id={id} kind="asset" selected={!!selected} sized={!!box} />
    </>
  )
}

export const AssetNode = memo(AssetNodeView)
