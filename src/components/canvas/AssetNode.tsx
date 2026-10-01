// Asset card on the canvas (character / location / prop / style). Source of reference wires.
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Box, MapPin, Palette, User } from 'lucide-react'
import { memo } from 'react'
import type { AssetKind } from '../../core/types'
import { useMediaUrl } from '../../lib/imageStore'
import { useProject } from '../../store/project'
import { useUI } from '../../store/ui'
import { assetImageSide, assetMapOf, KIND_LABEL, usageOf } from './canvasModel'
import { NodeSizer, useNodeBox } from './NodeSizer'
import './canvas.css'

export type AssetFlowNode = Node<Record<string, unknown>, 'asset'>

const KIND_ICON: Record<AssetKind, typeof User> = { character: User, location: MapPin, prop: Box, style: Palette }

function AssetNodeView({ id, selected }: NodeProps<AssetFlowNode>) {
  const asset = useProject((s) => assetMapOf(s.project.assets).get(id))
  const usage = useProject((s) => usageOf(s.project.scenes).get(id) ?? 0)
  const url = useMediaUrl(asset?.imageIds[0])
  const box = useNodeBox(id, asset?.size)
  if (!asset) return null
  const Icon = KIND_ICON[asset.kind]
  // Square image: fills the card width by default, grows with a resized card (whichever side is tighter).
  const side = box ? assetImageSide(box.w, box.h) : undefined
  return (
    <>
      <div
        className={`cv-asset ${selected ? 'is-selected' : ''} ${box ? 'is-sized' : ''} kind-${asset.kind}`}
        style={{ ['--asset-c' as string]: asset.color }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          useUI.getState().openDialog({ kind: 'asset', assetId: asset.id })
        }}
      >
        <div className="cv-asset-img" style={side ? { width: side, height: side } : undefined}>
          {url ? <img src={url} alt={asset.name} draggable={false} /> : <span className="cv-asset-fallback">{asset.name.slice(0, 1).toUpperCase()}</span>}
          {asset.imageIds.length > 1 && <span className="cv-asset-count">{asset.imageIds.length} ảnh</span>}
        </div>
        <div className="cv-asset-name">
          <Icon size={12} className="cv-asset-kind" aria-label={KIND_LABEL[asset.kind]} />
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
