import { ArrowDown, ArrowUp, Blocks, GripVertical, Plus } from 'lucide-react'
import { memo, useCallback, useMemo, useState, type CSSProperties, type DragEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PromptBlock } from '../../core/types'
import { useProject, type ProjectState } from '../../store/project'
import { useUI } from '../../store/ui'
import { Section, Segmented, Switch } from './bits'
import { BLOCK_MIME, matchesQuery, useSelectedSceneIds } from './shared'

type Tri = 'on' | 'off' | 'default'
type TriState = Tri | 'mixed'
const EMPTY_TRI: Record<string, TriState> = {}

/** Number of scenes that override each block (on or off). */
const overrideSelector = (s: ProjectState) => {
  const m: Record<string, number> = {}
  for (const sc of s.project.scenes) for (const k in sc.blockOverrides) m[k] = (m[k] ?? 0) + 1
  return m
}

function triOf(v: boolean | undefined): Tri {
  return v === undefined ? 'default' : v ? 'on' : 'off'
}

const TRI_OPTIONS: { value: Tri; label: string; title: string }[] = [
  { value: 'on', label: 'Bật', title: 'Luôn bật cho các cảnh đang chọn' },
  { value: 'off', label: 'Tắt', title: 'Luôn tắt cho các cảnh đang chọn' },
  { value: 'default', label: 'Mặc định', title: 'Theo mặc định của khối' },
]

interface RowProps {
  block: PromptBlock
  index: number
  total: number
  overrides: number
  /** State of this block for the selected scenes; null when no scene is selected. */
  tri: TriState | null
  selCount: number
  dropMark: 'before' | 'after' | null
  draggable: boolean
  onDragStartRow: (e: DragEvent<HTMLDivElement>, id: string) => void
  onDragOverRow: (e: DragEvent<HTMLDivElement>, index: number) => void
  onDropRow: (e: DragEvent<HTMLDivElement>) => void
  onDragEndRow: () => void
}

const BlockRow = memo(function BlockRow({ block, index, total, overrides, tri, selCount, dropMark, draggable, onDragStartRow, onDragOverRow, onDropRow, onDragEndRow }: RowProps) {
  const open = () => useUI.getState().openDialog({ kind: 'block', blockId: block.id })
  const move = (to: number) => useProject.getState().moveBlock(block.id, to)
  const preview = block.text.trim()
  return (
    <div
      className={`sb-block${block.defaultOn ? '' : ' off'}${dropMark ? ' drop-' + dropMark : ''}`}
      style={{ '--sb-c': block.color } as CSSProperties}
      role="button"
      tabIndex={0}
      draggable={draggable}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) open()
      }}
      onDragStart={(e) => onDragStartRow(e, block.id)}
      onDragOver={(e) => onDragOverRow(e, index)}
      onDrop={onDropRow}
      onDragEnd={onDragEndRow}
      title="Bấm để sửa · kéo để đổi thứ tự"
    >
      <span className="sb-block-grip" aria-hidden>
        <GripVertical size={12} />
      </span>
      <span className="sb-block-bar" />
      <div className="sb-block-main">
        <div className="sb-block-top">
          <span className="sb-block-title">{block.title || <span className="faint">Chưa đặt tên</span>}</span>
          <span className={`sb-place ${block.placement}`} title={block.placement === 'before' ? 'Chèn trước prompt của cảnh' : 'Chèn sau prompt của cảnh'}>
            {block.placement === 'before' ? 'Trước' : 'Sau'}
          </span>
          <Switch
            size="sm"
            on={block.defaultOn}
            title={block.defaultOn ? 'Mặc định bật cho mọi cảnh — bấm để tắt' : 'Mặc định tắt — bấm để bật cho mọi cảnh'}
            onChange={(v) => useProject.getState().updateBlock(block.id, { defaultOn: v })}
          />
        </div>
        <div className={`sb-block-text${preview ? '' : ' faint'}`}>{preview || 'Khối trống — bấm để viết nội dung.'}</div>
        <div className="sb-block-meta">
          <span className="faint">
            {preview.length.toLocaleString('vi-VN')} ký tự
            {overrides > 0 && (
              <>
                {' · '}
                <span className="sb-block-ovr" title="Số cảnh bật/tắt riêng khối này">
                  {overrides} cảnh ghi đè
                </span>
              </>
            )}
          </span>
          <span className="sb-block-move" onClick={(e) => e.stopPropagation()}>
            <button className="sb-mini" title="Lên" disabled={index === 0} onClick={() => move(index - 1)}>
              <ArrowUp size={11} />
            </button>
            <button className="sb-mini" title="Xuống" disabled={index === total - 1} onClick={() => move(index + 1)}>
              <ArrowDown size={11} />
            </button>
          </span>
        </div>
        {tri && (
          <div className="sb-block-tri" onClick={(e) => e.stopPropagation()}>
            <span className={`sb-tri-label${tri === 'mixed' ? ' mixed' : ''}`} title={tri === 'mixed' ? 'Các cảnh đang chọn có trạng thái khác nhau' : undefined}>
              {selCount} cảnh{tri === 'mixed' ? ' · khác nhau' : ''}
            </span>
            <Segmented<Tri>
              size="sm"
              value={tri === 'mixed' ? null : tri}
              options={TRI_OPTIONS}
              onChange={(v) => {
                const ids = useUI.getState().selectedIds
                const sceneIds = useProject.getState().project.scenes.filter((s) => ids.includes(s.id)).map((s) => s.id)
                useProject.getState().setBlockOverride(sceneIds, block.id, v === 'default' ? undefined : v === 'on')
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
})

export function BlocksPanel({ query, collapsed, onToggle }: { query: string; collapsed: boolean; onToggle: () => void }) {
  const blocks = useProject((s) => s.project.blocks)
  const sceneCount = useProject((s) => s.project.scenes.length)
  const overrides = useProject(useShallow(overrideSelector))
  const selectedScenes = useSelectedSceneIds()
  const tri = useProject(
    useShallow((s) => {
      if (!selectedScenes.length) return EMPTY_TRI
      const sel = new Set(selectedScenes)
      const scenes = s.project.scenes.filter((sc) => sel.has(sc.id))
      const out: Record<string, TriState> = {}
      for (const b of s.project.blocks) {
        let state: TriState | null = null
        for (const sc of scenes) {
          const t = triOf(sc.blockOverrides[b.id])
          if (state === null) state = t
          else if (state !== t) {
            state = 'mixed'
            break
          }
        }
        out[b.id] = state ?? 'default'
      }
      return out
    }),
  )
  const [dragId, setDragId] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ index: number; where: 'before' | 'after' } | null>(null)

  const rows = useMemo(
    () => blocks.map((b, i) => ({ b, i })).filter(({ b }) => matchesQuery(query, b.title, b.text)),
    [blocks, query],
  )

  const onDragStartRow = useCallback((e: DragEvent<HTMLDivElement>, id: string) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(BLOCK_MIME, id)
    setDragId(id)
  }, [])
  const onDragOverRow = useCallback((e: DragEvent<HTMLDivElement>, index: number) => {
    if (!e.dataTransfer.types.includes(BLOCK_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const r = e.currentTarget.getBoundingClientRect()
    const where = e.clientY < r.top + r.height / 2 ? 'before' : 'after'
    setDrop((d) => (d && d.index === index && d.where === where ? d : { index, where }))
  }, [])
  const onDragEndRow = useCallback(() => {
    setDragId(null)
    setDrop(null)
  }, [])
  const onDropRow = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes(BLOCK_MIME)) return
      e.preventDefault()
      const id = e.dataTransfer.getData(BLOCK_MIME) || dragId
      const target = drop
      setDragId(null)
      setDrop(null)
      if (!id || !target) return
      const list = useProject.getState().project.blocks
      const from = list.findIndex((b) => b.id === id)
      if (from < 0) return
      const insertAt = target.where === 'before' ? target.index : target.index + 1
      const to = from < insertAt ? insertAt - 1 : insertAt
      if (to !== from) useProject.getState().moveBlock(id, to)
    },
    [dragId, drop],
  )

  const addBlock = () => {
    const id = useProject.getState().addBlock({ title: 'Khối mới' })
    useUI.getState().openDialog({ kind: 'block', blockId: id })
  }

  const onCount = blocks.filter((b) => b.defaultOn).length

  return (
    <Section
      className="sb-blocks"
      title="Khối prompt"
      icon={<Blocks size={14} />}
      count={query.trim() ? `${rows.length}/${blocks.length}` : blocks.length}
      collapsed={collapsed}
      onToggle={onToggle}
      grow={3}
      actions={
        <button className="btn btn-ghost btn-sm" onClick={addBlock} title="Thêm khối prompt dùng chung">
          <Plus size={13} />
          Khối
        </button>
      }
      toolbar={
        <div className="sb-explain">
          {selectedScenes.length ? (
            <>
              Bật/tắt riêng cho <b className="sb-accent">{selectedScenes.length} cảnh đang chọn</b> ở dưới mỗi khối.
            </>
          ) : (
            <>
              Sửa một lần, áp dụng cho mọi cảnh.{' '}
              {blocks.length > 0 && (
                <span className="faint">
                  {onCount}/{blocks.length} khối bật mặc định · {sceneCount} cảnh
                </span>
              )}
            </>
          )}
        </div>
      }
    >
      {!blocks.length ? (
        <div className="empty sb-empty">
          <div>Chưa có khối prompt.</div>
          <div className="faint">Tạo khối cho phong cách, âm thanh, ràng buộc… — viết một lần, tự chèn vào prompt của mọi cảnh.</div>
          <button className="btn btn-sm" onClick={addBlock}>
            <Plus size={13} />
            Tạo khối đầu tiên
          </button>
        </div>
      ) : !rows.length ? (
        <div className="empty sb-empty">Không có khối nào khớp “{query.trim()}”.</div>
      ) : (
        <div className="sb-block-list" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDrop(null)}>
          {rows.map(({ b, i }) => (
            <BlockRow
              key={b.id}
              block={b}
              index={i}
              total={blocks.length}
              overrides={overrides[b.id] ?? 0}
              tri={selectedScenes.length ? (tri[b.id] ?? 'default') : null}
              selCount={selectedScenes.length}
              dropMark={dragId && drop && drop.index === i && dragId !== b.id ? drop.where : null}
              draggable
              onDragStartRow={onDragStartRow}
              onDragOverRow={onDragOverRow}
              onDropRow={onDropRow}
              onDragEndRow={onDragEndRow}
            />
          ))}
        </div>
      )}
    </Section>
  )
}
