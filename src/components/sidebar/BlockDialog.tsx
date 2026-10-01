import { Info, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, type CSSProperties } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { MENTION_RE, assetByTag } from '../../core/compile'
import type { PromptBlock } from '../../core/types'
import { useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { Modal } from '../common/Modal'
import { ColorSwatches, ConfirmButton, Segmented, Switch } from './bits'
import { undoToastAction, useDialogUndoKeys, useFileDropGuard } from './shared'
import './sidebar.css'

/** Shared prompt block editor. Changes apply live (undoable); "Xong" just closes. */
export function BlockDialog({ blockId }: { blockId: string }) {
  const block = useProject((s) => s.project.blocks.find((b) => b.id === blockId))
  const closeDialog = useUI((s) => s.closeDialog)
  useEffect(() => {
    if (!block) closeDialog()
  }, [block, closeDialog])
  if (!block) return null
  return <BlockEditor block={block} onClose={closeDialog} />
}

function BlockEditor({ block, onClose }: { block: PromptBlock; onClose: () => void }) {
  const update = (patch: Partial<Omit<PromptBlock, 'id'>>) => useProject.getState().updateBlock(block.id, patch)
  useDialogUndoKeys()
  useFileDropGuard()
  const stats = useProject(
    useShallow((s) => {
      let on = 0
      let forcedOn = 0
      let forcedOff = 0
      for (const sc of s.project.scenes) {
        const v = sc.blockOverrides[block.id]
        if (v === true) forcedOn++
        else if (v === false) forcedOff++
        if (v ?? block.defaultOn) on++
      }
      return { on, total: s.project.scenes.length, forcedOn, forcedOff }
    }),
  )
  const position = useProject((s) => s.project.blocks.findIndex((b) => b.id === block.id))
  const blockCount = useProject((s) => s.project.blocks.length)
  const assets = useProject((s) => s.project.assets)
  const mentions = useMemo(() => {
    const out: { tag: string; known: boolean }[] = []
    const seen = new Set<string>()
    for (const m of block.text.matchAll(MENTION_RE)) {
      const key = m[1].toLowerCase()
      if (seen.has(key) || /^image_\d+$/i.test(m[1])) continue
      seen.add(key)
      out.push({ tag: m[1], known: !!assetByTag(assets, m[1]) })
    }
    return out
  }, [block.text, assets])

  const chars = [...block.text].length
  const overrideCount = stats.forcedOn + stats.forcedOff

  const clearOverrides = () => {
    const ids = useProject
      .getState()
      .project.scenes.filter((s) => block.id in s.blockOverrides)
      .map((s) => s.id)
    useProject.getState().setBlockOverride(ids, block.id, undefined)
    toast(`Đã bỏ ghi đè ở ${ids.length} cảnh — tất cả theo mặc định của khối.`, { action: undoToastAction() })
  }

  const remove = () => {
    const title = block.title
    useProject.getState().removeBlock(block.id)
    onClose()
    toast(`Đã xoá khối “${title || 'Chưa đặt tên'}”.`, { action: undoToastAction() })
  }

  const title = (
    <span className="sb-dlg-title">
      <span className="sb-dlg-swatch" style={{ background: block.color }} />
      <span className="sb-dlg-title-text">Khối prompt · {block.title || 'Chưa đặt tên'}</span>
      <span className="badge">
        {position + 1}/{blockCount}
      </span>
    </span>
  )

  return (
    <Modal
      title={title}
      onClose={onClose}
      size="wide"
      footer={
        <>
          <ConfirmButton icon={<Trash2 size={13} />} label="Xoá khối" confirmLabel="Bấm lần nữa để xoá" className="btn btn-danger" onConfirm={remove} />
          <span className="sb-spacer" />
          <span className="faint sb-live-note">Thay đổi áp dụng ngay cho mọi cảnh · Ctrl+Z để hoàn tác</span>
          <button className="btn btn-primary" onClick={onClose}>
            Xong
          </button>
        </>
      }
    >
      <div className="sb-block-dlg" style={{ '--sb-c': block.color } as CSSProperties}>
        <div className="sb-block-dlg-side">
          <label className="field">
            <span>Tên khối</span>
            <input className="input" value={block.title} placeholder="Ví dụ: Âm thanh" onChange={(e) => update({ title: e.target.value })} />
          </label>
          <div className="field">
            <span>Vị trí trong prompt</span>
            <Segmented
              value={block.placement}
              options={[
                { value: 'before', label: 'Trước prompt cảnh', title: 'Chèn trước nội dung riêng của cảnh' },
                { value: 'after', label: 'Sau prompt cảnh', title: 'Chèn sau nội dung riêng của cảnh (và sau đoạn References)' },
              ]}
              onChange={(placement) => update({ placement })}
            />
          </div>
          <div className="sb-switch-row">
            <Switch on={block.defaultOn} onChange={(defaultOn) => update({ defaultOn })} title="Mặc định bật cho mọi cảnh" />
            <div>
              <div>Mặc định bật cho mọi cảnh</div>
              <small className="faint">Cảnh nào cần khác thì bật/tắt riêng trong Inspector hoặc ở danh sách khối khi chọn cảnh.</small>
            </div>
          </div>
          <div className="field">
            <span>Màu</span>
            <ColorSwatches value={block.color} onChange={(color) => update({ color })} />
          </div>
          <div className="sb-usage-card">
            <div className="sb-usage-big">
              Đang dùng ở{' '}
              <b>
                {stats.on}/{stats.total}
              </b>{' '}
              cảnh
            </div>
            <div className="progress">
              <i style={{ width: stats.total ? `${(stats.on / stats.total) * 100}%` : '0%', background: block.color }} />
            </div>
            {overrideCount > 0 ? (
              <div className="sb-usage-ovr">
                <span className="faint">
                  Ghi đè: {stats.forcedOn > 0 && `${stats.forcedOn} bật riêng`}
                  {stats.forcedOn > 0 && stats.forcedOff > 0 && ' · '}
                  {stats.forcedOff > 0 && `${stats.forcedOff} tắt riêng`}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={clearOverrides} title="Mọi cảnh theo mặc định của khối">
                  <RotateCcw size={12} />
                  Bỏ ghi đè
                </button>
              </div>
            ) : (
              <div className="faint">Không cảnh nào ghi đè — tất cả theo mặc định.</div>
            )}
          </div>
        </div>
        <div className="sb-block-dlg-main">
          <label className="field sb-grow">
            <span className="sb-field-head">
              Nội dung
              <span className={`sb-field-count${chars > 4000 ? ' warn' : ''}`}>{chars.toLocaleString('vi-VN')} ký tự</span>
            </span>
            <textarea
              className="textarea sb-block-textarea"
              value={block.text}
              autoFocus={!block.text}
              spellCheck={false}
              placeholder="Audio: natural ambient sound only. No music of any kind…"
              onChange={(e) => update({ text: e.target.value })}
            />
          </label>
          <div className="sb-explain-box">
            <Info size={13} />
            <div>
              Khối được chèn nguyên văn vào prompt cuối của mọi cảnh đang bật nó. <span className="mono">@Tag</span> trong khối cũng được đổi thành{' '}
              <span className="mono">@image_N</span> như trong prompt cảnh.
              {mentions.length > 0 && (
                <div className="sb-mentions">
                  {mentions.map((m) => (
                    <span key={m.tag} className={`badge ${m.known ? 'ref' : 'warn'}`} title={m.known ? 'Có trong thư viện' : 'Không có trong thư viện'}>
                      @{m.tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
