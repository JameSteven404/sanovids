// "Prompt cuối": the exact text that would be sent (blocks + scene prompt + auto references),
// with @image_N tokens highlighted and each source paragraph labelled.
import { ChevronDown, Copy, Download, TriangleAlert } from 'lucide-react'
import { memo, useDeferredValue, useMemo, type ReactNode } from 'react'
import { copyCompiledPrompt, downloadSceneZip } from '../../actions'
import { compileScene } from '../../core/compile'
import type { Asset, CompiledPrompt } from '../../core/types'
import { useProject } from '../../store/project'
import { splitCompiled, type PromptPart } from './promptParts'
import { fmt, usePref } from './shared'

const TOKEN_G = /@image_\d+|@[\p{L}\p{N}_]+/gu

export function FinalPromptPreview({ sceneId }: { sceneId: string }) {
  const project = useProject((s) => s.project)
  // Compiling on every keystroke is cheap but not free with 6k+ char prompts: let React defer it.
  const deferred = useDeferredValue(project)
  const scene = useMemo(() => deferred.scenes.find((s) => s.id === sceneId), [deferred, sceneId])
  const compiled = useMemo(() => (scene ? compileScene(deferred, scene) : null), [deferred, scene])
  const parts = useMemo(() => (scene && compiled ? splitCompiled(deferred, scene, compiled) : []), [deferred, scene, compiled])
  const [open, setOpen] = usePref('finalOpen', true)
  const imageNames = useMemo(() => {
    const names = new Map<number, string>()
    if (!compiled) return names
    const byId = new Map<string, Asset>(deferred.assets.map((a) => [a.id, a]))
    for (const img of compiled.images) {
      const a = byId.get(img.assetId)
      if (a) names.set(img.n, a.name)
    }
    return names
  }, [deferred.assets, compiled])

  if (!scene || !compiled) return null
  const over = compiled.charCount > compiled.limit

  return (
    <section className={`in-section in-final ${open ? '' : 'is-collapsed'}`}>
      <div className="in-section-head">
        <button type="button" className="in-section-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <ChevronDown size={13} className="in-chev" />
          <span className="in-section-title">Prompt cuối</span>
          <span className={`in-count mono ${over ? 'over' : ''}`} title="Số ký tự của prompt gửi đi / giới hạn của model">
            {fmt(compiled.charCount)} / {fmt(compiled.limit)}
          </span>
          {compiled.warnings.length > 0 && (
            <span className="badge warn" title={compiled.warnings.join('\n')}>
              <TriangleAlert size={11} />
              {compiled.warnings.length}
            </span>
          )}
        </button>
      </div>
      {open && (
        <div className="in-section-body">
          <div className="in-final-actions">
            <button type="button" className="btn btn-sm" onClick={() => void copyCompiledPrompt(sceneId)}>
              <Copy size={13} /> Copy prompt
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void downloadSceneZip(sceneId)} title="Ảnh tham chiếu được đặt tên theo thứ tự @image (01_Elara.png…) + prompt.txt">
              <Download size={13} /> Tải ảnh + prompt (.zip)
            </button>
            <span className="in-final-hint faint">Dùng cho canvasapp</span>
          </div>
          {compiled.warnings.length > 0 && (
            <ul className="in-warnings">
              {compiled.warnings.map((w, i) => (
                <li key={i}>
                  <TriangleAlert size={12} />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}
          <FinalText parts={parts} imageNames={imageNames} compiled={compiled} />
        </div>
      )}
    </section>
  )
}

const FinalText = memo(function FinalText({
  parts,
  imageNames,
  compiled,
}: {
  parts: PromptPart[]
  imageNames: Map<number, string>
  compiled: CompiledPrompt
}) {
  if (!compiled.text) return <div className="empty">Chưa có nội dung — viết prompt cho cảnh hoặc bật khối prompt.</div>
  return (
    <div className="in-final-text">
      {parts.map((p) => (
        <div key={p.key} className={`in-part kind-${p.kind}`} style={p.color ? { ['--part' as string]: p.color } : undefined}>
          {p.label && <div className="in-part-label">{p.label}</div>}
          <div className="in-part-text">{highlight(p.text, imageNames)}</div>
        </div>
      ))}
    </div>
  )
})

function highlight(text: string, imageNames: Map<number, string>): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(TOKEN_G)) {
    const idx = m.index ?? 0
    if (idx > last) out.push(text.slice(last, idx))
    const tok = m[0]
    const img = /^@image_(\d+)$/.exec(tok)
    if (img) {
      const name = imageNames.get(Number(img[1]))
      out.push(
        <mark key={i++} className="in-img-token" title={name ? `${tok} = ${name}` : tok}>
          {tok}
        </mark>,
      )
    } else {
      out.push(
        <mark key={i++} className="in-unknown-token" title="Không có trong thư viện — giữ nguyên chữ">
          {tok}
        </mark>,
      )
    }
    last = idx + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
