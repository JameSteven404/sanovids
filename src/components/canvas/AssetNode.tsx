// Image tile on the canvas (character / location / prop / style): the source of reference wires.
// One size for every picture, like canvasapp (choice 3L): 220 × 275 by default, the picture shown WHOLE (contain) in
// its frame, one caption line (name · how many scenes use it). Resized tiles keep their size; the frame follows.
// Zoomed out (< LOD_ZOOM): only the picture and a big name.
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Box, MapPin, Maximize2, Palette, User } from 'lucide-react'
import { memo, type SyntheticEvent } from 'react'
import { viewAssetImages } from '../../actions'
import type { AssetKind } from '../../core/types'
import { useProject } from '../../store/project'
import { useUI } from '../../store/ui'
import { FullImage } from '../common/Media'
import { assetMapOf, KIND_LABEL, usageOf } from './canvasModel'
import { NodeSizer, PortIcon, useFarView, useNodeBox } from './NodeSizer'
import './canvas.css'
import './assetNode.css'

export type AssetFlowNode = Node<Record<string, unknown>, 'asset'>

const KIND_ICON: Record<AssetKind, typeof User> = { character: User, location: MapPin, prop: Box, style: Palette }

/** Keep a press on the image buttons away from node drag / selection / the double-click dialog. */
const stop = (e: SyntheticEvent) => e.stopPropagation()

function AssetNodeView({ id, selected }: NodeProps<AssetFlowNode>) {
  const asset = useProject((s) => assetMapOf(s.project.assets).get(id))
  const usage = useProject((s) => usageOf(s.project.scenes).get(id) ?? 0)
  const far = useFarView()
  const primary = asset?.imageIds[0]
  const box = useNodeBox(id, asset?.size)

  if (!asset) return null
  // Unknown kind (data from a newer version / a broken import): fall back to the character icon instead of crashing.
  const Icon = KIND_ICON[asset.kind] ?? User
  const count = asset.imageIds.length
  const cls = ['cv-asset', 'cv-tile', selected && 'is-selected', box && 'is-sized', far && 'is-far', `kind-${asset.kind}`].filter(Boolean).join(' ')
  return (
    <>
      <div
        className={cls}
        style={{ ['--asset-c' as string]: asset.color }}
        title={`${asset.name} · @${asset.tag} · ${KIND_LABEL[asset.kind] ?? KIND_LABEL.character} — bấm đúp để sửa`}
        onDoubleClick={(e) => {
          e.stopPropagation()
          useUI.getState().openDialog({ kind: 'asset', assetId: asset.id })
        }}
      >
        <div className="cv-tile-img">
          {primary ? <FullImage id={primary} alt={asset.name} fill /> : <span className="cv-tile-fallback">{asset.name.slice(0, 1).toUpperCase()}</span>}
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
        <div className="cv-tile-cap">
          <Icon size={12} strokeWidth={2} className="cv-tile-kind" aria-label={KIND_LABEL[asset.kind] ?? KIND_LABEL.character} />
          <span className="cv-tile-name">{asset.name}</span>
          <span className={`cv-tile-use${usage ? '' : ' is-none'}`}>{usage ? `${usage} cảnh` : 'chưa nối'}</span>
        </div>
        <Handle type="source" position={Position.Right} id="out" className="cv-h cv-h-out" title="Kéo thả vào bất kỳ đâu trên node cảnh để nối">
          {selected && <PortIcon kind="image" />}
        </Handle>
      </div>
      <NodeSizer id={id} kind="asset" selected={!!selected} sized={!!box} />
    </>
  )
}

export const AssetNode = memo(AssetNodeView)
