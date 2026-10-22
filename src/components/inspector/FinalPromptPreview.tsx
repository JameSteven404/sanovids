// "Prompt cuối": the exact text that would be sent (the prompt as written, legacy @Tag converted to @image_N),
// with @image_N tokens highlighted (red placeholders "@image_?2(Lumi)" and labels that do not fit their slot in red,
// retired @video text struck through in red), char count, warnings (amber) and notes (grey).
import { ChevronDown, Copy, Download, Info, TriangleAlert } from 'lucide-react'
import { memo, useDeferredValue, useMemo } from 'react'
import { copyCompiledPrompt, downloadSceneZip } from '../../actions'
import { compileScene } from '../../core/compile'
import { sceneMapOf } from '../../core/sceneIndex'
import type { Asset, Project, Scene } from '../../core/types'
import { useProject } from '../../store/project'
import { fmt, usePref } from './shared'
import { imageOptsFor, invalidTokenTitle, labelChecker, segmentPrompt, type LabelCheck } from './tokens'

/** compileScene only reads the assets and the scene: avoid subscribing to the whole project. */
function compileFor(assets: Asset[], scene: Scene) {
  const stub: Project = { id: '', name: '', schemaVersion: 2, createdAt: 0, updatedAt: 0, assets, presets: [], scenes: [scene], settings: { autoRenumber: true } }
  return compileScene(stub, scene)
}

export function FinalPromptPreview({ sceneId }: { sceneId: string }) {
  const liveScene = useProject((s) => sceneMapOf(s.project.scenes).get(sceneId))
  const liveAssets = useProject((s) => s.project.assets)
  // Compiling on every keystroke is cheap but not free with 6k+ char prompts: let React defer it.
  const scene = useDeferredValue(liveScene)
  const assets = useDeferredValue(liveAssets)
  const [open, setOpen] = usePref('finalOpen', true)

  const compiled = useMemo(() => (scene ? compileFor(assets, scene) : null), [assets, scene])
  const names = useMemo(() => {
    const images = new Map<number, string>()
    if (scene) for (const o of imageOptsFor(assets, scene.refs)) images.set(o.n, o.name)
    return images
  }, [assets, scene])

  const labels = useMemo(() => (scene ? labelChecker(assets, scene.refs) : undefined), [assets, scene])

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
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void downloadSceneZip(sceneId)}
              title="Ảnh tham chiếu đặt tên theo số (image_01_Elara.png) + prompt.txt"
            >
              <Download size={13} /> Tải tham chiếu + prompt (.zip)
            </button>
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
          {compiled.notes.length > 0 && (
            <ul className="in-notes">
              {compiled.notes.map((w, i) => (
                <li key={i}>
                  <Info size={12} />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}
          <FinalText text={compiled.text} imageCount={names.size} sentImages={compiled.images.length} names={names} labels={labels} />
        </div>
      )}
    </section>
  )
}

const FinalText = memo(function FinalText({
  text,
  imageCount,
  sentImages,
  names,
  labels,
}: {
  text: string
  imageCount: number
  /** What the request really carries (compileScene's images): tokens past it reach no picture. */
  sentImages: number
  /** Asset name of each @image_N. */
  names: Map<number, string>
  /** Checks a label glued to a token ("@image_2(Lumi)") against the picture that number names now. */
  labels?: LabelCheck
}) {
  const segs = useMemo(() => segmentPrompt(text, imageCount, undefined, { images: sentImages }, labels), [text, imageCount, sentImages, labels])
  if (!text) return <div className="empty">Chưa có nội dung — viết prompt cho cảnh.</div>
  return (
    <div className="in-final-text">
      {segs.map((s, i) => {
        if (s.kind === 'text') return s.text
        const name = s.n !== undefined && s.kind === 'image' ? names.get(s.n) : undefined
        return (
          <mark
            key={i}
            className={`in-tk is-${s.kind} ${s.invalid ? 'is-invalid' : ''} ${s.reason === 'retired' ? 'is-retired' : ''}`}
            title={s.invalid ? invalidTokenTitle(s) : name ? `${s.text} = ${name}` : s.text}
          >
            {s.text}
          </mark>
        )
      })}
    </div>
  )
})
