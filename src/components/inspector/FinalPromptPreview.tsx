// "Prompt cuối": the exact text that would be sent (the prompt as written, legacy @Tag converted to @image_N),
// with @image_N / @video_N tokens highlighted, char count, warnings (amber) and notes (grey).
import { ChevronDown, Copy, Download, Info, TriangleAlert } from 'lucide-react'
import { memo, useDeferredValue, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { copyCompiledPrompt, downloadSceneZip } from '../../actions'
import { compileScene } from '../../core/compile'
import type { Asset, Project, Scene } from '../../core/types'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useTakeInfos } from './hooks'
import { EMPTY_IDS, fmt, usePref } from './shared'
import { imageOptsFor, invalidTokenTitle, segmentPrompt } from './tokens'

/** compileScene only reads the assets and the scene: avoid subscribing to the whole project. */
function compileFor(assets: Asset[], scene: Scene, takeStatus: (id: string) => string | undefined) {
  const stub: Project = { id: '', name: '', schemaVersion: 2, createdAt: 0, updatedAt: 0, assets, presets: [], scenes: [scene], settings: { autoRenumber: true } }
  return compileScene(stub, scene, { takeStatus })
}

export function FinalPromptPreview({ sceneId }: { sceneId: string }) {
  const liveScene = useProject((s) => s.project.scenes.find((x) => x.id === sceneId))
  const liveAssets = useProject((s) => s.project.assets)
  // Compiling on every keystroke is cheap but not free with 6k+ char prompts: let React defer it.
  const scene = useDeferredValue(liveScene)
  const assets = useDeferredValue(liveAssets)
  const videoRefs = scene?.videoRefs ?? EMPTY_IDS
  const statuses = useRuns(useShallow((s) => videoRefs.map((id) => s.takes.find((t) => t.id === id)?.status ?? '')))
  const takeInfos = useTakeInfos(videoRefs)
  const [open, setOpen] = usePref('finalOpen', true)

  const compiled = useMemo(() => {
    if (!scene) return null
    const byId = new Map(videoRefs.map((id, i) => [id, statuses[i] || undefined]))
    return compileFor(assets, scene, (id) => byId.get(id))
  }, [assets, scene, videoRefs, statuses])
  const names = useMemo(() => {
    const images = new Map<number, string>()
    if (scene) for (const o of imageOptsFor(assets, scene.refs)) images.set(o.n, o.name)
    const videos = new Map<number, string>(takeInfos.map((t, i) => [i + 1, t.label]))
    return { images, videos }
  }, [assets, scene, takeInfos])

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
              title="Ảnh / video tham chiếu đặt tên theo số (image_01_Elara.png, video_01_S03-T2.webm) + prompt.txt"
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
          <FinalText
            text={compiled.text}
            imageCount={names.images.size}
            videoCount={videoRefs.length}
            sentImages={compiled.images.length}
            sentVideos={compiled.videos.length}
            names={names}
          />
        </div>
      )}
    </section>
  )
}

const FinalText = memo(function FinalText({
  text,
  imageCount,
  videoCount,
  sentImages,
  sentVideos,
  names,
}: {
  text: string
  imageCount: number
  videoCount: number
  /** What the request really carries (compileScene's images / videos): tokens past it reach no picture. */
  sentImages: number
  sentVideos: number
  names: { images: Map<number, string>; videos: Map<number, string> }
}) {
  const segs = useMemo(
    () => segmentPrompt(text, imageCount, videoCount, undefined, { images: sentImages, videos: sentVideos }),
    [text, imageCount, videoCount, sentImages, sentVideos],
  )
  if (!text) return <div className="empty">Chưa có nội dung — viết prompt cho cảnh.</div>
  return (
    <div className="in-final-text">
      {segs.map((s, i) => {
        if (s.kind === 'text') return s.text
        const name = s.n !== undefined ? (s.kind === 'image' ? names.images : names.videos).get(s.n) : undefined
        return (
          <mark key={i} className={`in-tk is-${s.kind} ${s.invalid ? 'is-invalid' : ''}`} title={s.invalid ? invalidTokenTitle(s) : name ? `${s.text} = ${name}` : s.text}>
            {s.text}
          </mark>
        )
      })}
    </div>
  )
})
