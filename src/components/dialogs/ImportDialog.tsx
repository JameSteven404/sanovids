import { ArrowLeft, ArrowRight, Check, ChevronDown, FileText, Images, Info, Search, Sparkles, TriangleAlert, Upload, X } from 'lucide-react'
import { Fragment, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { fitNodes } from '../../actions'
import { sceneCode } from '../../core/compile'
import {
  applyImageMapping,
  buildImportScenes,
  hasMapping,
  itemsFromFiles,
  parsePromptText,
  previewItem,
  SAMPLE_IMPORT_TEXT,
  summarizeImport,
  type ImageMapping,
  type ImportItem,
  type ImportSummary,
} from '../../core/importPrompts'
import { MODELS, normalizeSettings, settingsLabel } from '../../core/models'
import type { Asset } from '../../core/types'
import { undoToastAction, useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { AssetAvatar, MediaImg } from '../common/Media'
import { Modal } from '../common/Modal'
import './dialogs.css'

interface FileItem {
  name: string
  text: string
}
type Step = 1 | 2 | 3

const fmt = (n: number) => n.toLocaleString('vi-VN')
const TOKEN_SPLIT = /(@(?:image|video)_\d+)\b/gi

/** Prompt text with @image_N (teal) / @video_N (purple) highlighted. `imageCount` marks numbers past it as unresolved. */
function TokenText({ text, imageCount }: { text: string; imageCount?: number }) {
  const parts = text.split(TOKEN_SPLIT)
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{p}</Fragment>
        const video = /^@video/i.test(p)
        const n = Number(p.slice(p.indexOf('_') + 1))
        const bad = !video && imageCount !== undefined && n > imageCount
        return (
          <mark key={i} className={`dg-tok ${video ? 'video' : 'image'}${bad ? ' bad' : ''}`}>
            {p}
          </mark>
        )
      })}
    </>
  )
}

export function ImportDialog() {
  const closeDialog = useUI((s) => s.closeDialog)
  const assets = useProject((s) => s.project.assets)
  const projectName = useProject((s) => s.project.name)
  const sceneCount = useProject((s) => s.project.scenes.length)
  const draftPreset = useProject((s) => s.project.presets[0])

  const [step, setStep] = useState<Step>(1)
  const [text, setText] = useState('')
  const [files, setFiles] = useState<FileItem[]>([])
  const [mapping, setMapping] = useState<ImageMapping>([])
  const [onlyMentioned, setOnlyMentioned] = useState(true)

  const items: ImportItem[] = useMemo(() => [...parsePromptText(text), ...itemsFromFiles(files)], [text, files])
  const summary = useMemo(() => summarizeImport(items), [items])
  // New scenes get the project's first preset (same rule as project.applyImport).
  const settings = useMemo(() => normalizeSettings(draftPreset ?? {}), [draftPreset])
  const spec = MODELS[settings.model]
  const charLimit = spec.promptLimit(settings.mode)

  const effMapping: ImageMapping = useMemo(() => Array.from({ length: summary.maxImage }, (_, i) => mapping[i] ?? null), [mapping, summary.maxImage])
  const mapped = hasMapping(effMapping, assets)
  const assigned = effMapping.filter((id) => id && assets.some((a) => a.id === id && a.imageIds.length)).length

  const create = (withMapping: boolean) => {
    if (!items.length) return
    const scenes = buildImportScenes(items, withMapping ? { mapping: effMapping, assets, onlyMentioned } : {})
    const ids = useProject.getState().applyImport({ scenes })
    const undo = undoToastAction()
    const linked = scenes.filter((s) => s.refs.length).length
    const ui = useUI.getState()
    ui.closeDialog()
    ui.setView('canvas')
    ui.select(ids)
    window.setTimeout(() => fitNodes(ids), 200)
    toast(`Đã nhập ${ids.length} cảnh${linked ? ` · nối ảnh tham chiếu cho ${linked} cảnh` : ''}.`, { tone: 'success', action: undo })
  }

  const hasImages = summary.maxImage > 0
  const steps: { n: Step; label: string; off?: boolean }[] = [
    { n: 1, label: 'Dán prompt' },
    { n: 2, label: 'Xem trước' },
    { n: 3, label: 'Gán ảnh theo số', off: step > 1 && !hasImages },
  ]
  const stepper = (
    <ol className="dg-steps">
      {steps.map((s) => (
        <li key={s.n} className={step === s.n ? 'active' : step > s.n ? 'done' : s.off ? 'off' : ''} title={s.off ? 'Không có token @image_N nào để gán' : undefined}>
          <span>{step > s.n ? <Check size={11} strokeWidth={3} /> : s.n}</span>
          {s.label}
        </li>
      ))}
    </ol>
  )

  let body: ReactNode
  let footer: ReactNode
  if (step === 1) {
    body = <StepInput text={text} setText={setText} files={files} setFiles={setFiles} items={items} />
    footer = (
      <>
        <span className="dg-foot-info">
          {items.length ? (
            <>
              Nhận diện <b>{items.length}</b> prompt · {fmt(summary.chars)} ký tự
            </>
          ) : (
            'Chưa có prompt nào'
          )}
        </span>
        <button className="btn" onClick={closeDialog}>
          Huỷ
        </button>
        <button className="btn btn-primary" disabled={!items.length} onClick={() => setStep(2)}>
          Xem trước <ArrowRight size={14} />
        </button>
      </>
    )
  } else if (step === 2) {
    body = (
      <StepPreview
        items={items}
        summary={summary}
        startOrder={sceneCount + 1}
        charLimit={charLimit}
        presetLine={`${draftPreset?.name ? `“${draftPreset.name}” · ` : ''}${spec.short} · ${settingsLabel(settings)}`}
        modelName={spec.name}
        projectName={projectName}
      />
    )
    footer = (
      <>
        <span className="dg-foot-info">
          <b>{items.length}</b> cảnh mới · {sceneCode(sceneCount + 1)}
          {items.length > 1 ? ` → ${sceneCode(sceneCount + items.length)}` : ''}
        </span>
        <button className="btn" onClick={() => setStep(1)}>
          <ArrowLeft size={14} /> Quay lại
        </button>
        {hasImages ? (
          <>
            <button className="btn" onClick={() => create(false)} title="Giữ nguyên token @image_N, nối ảnh sau">
              Nhập ngay, không gán ảnh
            </button>
            <button className="btn btn-primary" onClick={() => setStep(3)}>
              Gán ảnh theo số <ArrowRight size={14} />
            </button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={() => create(false)}>
            <Check size={14} /> Nhập {items.length} cảnh
          </button>
        )}
      </>
    )
  } else {
    body = (
      <StepMapping
        items={items}
        summary={summary}
        assets={assets}
        mapping={effMapping}
        setMapping={setMapping}
        onlyMentioned={onlyMentioned}
        setOnlyMentioned={setOnlyMentioned}
        startOrder={sceneCount + 1}
        imageLimit={spec.maxRefImages}
        modelName={spec.name}
      />
    )
    footer = (
      <>
        <span className="dg-foot-info">
          Đã gán <b>{assigned}</b>/{summary.maxImage} số
        </span>
        <button className="btn" onClick={() => setStep(2)}>
          <ArrowLeft size={14} /> Quay lại
        </button>
        <button className="btn" onClick={() => create(false)} title="Giữ nguyên token @image_N, không nối ảnh nào">
          Bỏ qua, không gán
        </button>
        <button className="btn btn-primary" onClick={() => create(mapped)}>
          <Check size={14} /> Nhập {items.length} cảnh
        </button>
      </>
    )
  }

  return (
    <Modal title="Nhập prompt cũ" onClose={closeDialog} size="xwide" headerExtra={stepper} footer={footer}>
      {body}
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------
// Step 1 — paste text / drop .txt files

function StepInput({
  text,
  setText,
  files,
  setFiles,
  items,
}: {
  text: string
  setText: (t: string) => void
  files: FileItem[]
  setFiles: (f: FileItem[] | ((prev: FileItem[]) => FileItem[])) => void
  items: ImportItem[]
}) {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const addFiles = async (list: File[]) => {
    const ok = list.filter((f) => /\.(txt|md)$/i.test(f.name) || f.type.startsWith('text/'))
    if (!ok.length) {
      toast('Chỉ nhận file văn bản .txt (mỗi file = một cảnh).', { tone: 'warning' })
      return
    }
    const read = await Promise.all(ok.map(async (f) => ({ name: f.name, text: await f.text() })))
    setFiles((prev) => [...prev, ...read].sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true })))
    if (ok.length < list.length) toast(`Bỏ qua ${list.length - ok.length} file không phải .txt.`, { tone: 'warning' })
  }

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setOver(true)
  }
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return
    e.preventDefault()
    setOver(false)
    void addFiles([...e.dataTransfer.files])
  }

  const fileCount = files.filter((f) => f.text.trim()).length
  const textCount = items.length - fileCount

  return (
    <div className={`dg-import-input ${over ? 'over' : ''}`} onDragOver={onDragOver} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div className="dg-import-paste">
        <div className="dg-label-row">
          <span className="label">Dán prompt</span>
          <span className="faint">{text.trim() ? `${textCount} prompt từ ô dán` : ''}</span>
        </div>
        <textarea
          className="textarea dg-import-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          placeholder={
            'Dán nhiều prompt, mỗi prompt cách nhau bằng một dòng ---\n\nPrompt 1 … Mara (@image_1) bước vào …\n\n---\n\nPrompt 2 …\n\nCó thể đặt tên cảnh bằng dòng: === S01: Tên cảnh ==='
          }
        />
      </div>

      <div className="dg-import-side">
        <div
          className="dg-drop"
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              inputRef.current?.click()
            }
          }}
          role="button"
          tabIndex={0}
        >
          <Upload size={20} />
          <b>Thả file .txt vào đây</b>
          <span>hoặc bấm để chọn nhiều file — mỗi file là một cảnh, tên file thành tên cảnh</span>
          <input
            ref={inputRef}
            type="file"
            accept=".txt,.md,text/plain"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles([...e.target.files])
              e.target.value = ''
            }}
          />
        </div>

        {files.length > 0 && (
          <div className="dg-files">
            <div className="dg-label-row">
              <span className="label">{files.length} file</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setFiles([])}>
                Xoá hết
              </button>
            </div>
            <div className="dg-files-list">
              {files.map((f, i) => (
                <div key={f.name + i} className="dg-file">
                  <FileText size={13} />
                  <span className="dg-ellipsis">{f.name}</span>
                  <span className="faint mono">{fmt(f.text.length)}</span>
                  <button className="dg-x" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} aria-label={`Bỏ ${f.name}`}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <button className="dg-sample" onClick={() => setText(SAMPLE_IMPORT_TEXT)}>
          <Sparkles size={15} />
          <span>
            <b>Dùng ví dụ</b>
            <small>3 prompt mẫu có ảnh tham chiếu @image_1 … @image_3</small>
          </span>
        </button>

        <div className="dg-tips">
          <div className="section-title">Cách tách</div>
          <ul>
            <li>
              Dòng chỉ gồm <code>---</code>, <code>===</code> hoặc <code>***</code> ngăn cách các prompt.
            </li>
            <li>
              Dòng <code>=== S03: Tên cảnh ===</code> vừa ngăn cách vừa đặt tên cảnh (định dạng của “Copy tất cả prompt”).
            </li>
            <li>
              Prompt được giữ nguyên văn, kể cả token <code>@image_N</code> và <code>@video_N</code>. Bước sau có thể gán ảnh thư viện cho từng số.
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Step 2 — preview the scenes

function StepPreview({
  items,
  summary,
  startOrder,
  charLimit,
  presetLine,
  modelName,
  projectName,
}: {
  items: ImportItem[]
  summary: ImportSummary
  startOrder: number
  charLimit: number
  presetLine: string
  modelName: string
  projectName: string
}) {
  const previews = useMemo(() => items.map((i) => previewItem(i, 3)), [items])
  const tooLong = previews.filter((p) => p.chars > charLimit).length
  const avg = Math.round(summary.chars / Math.max(1, summary.prompts))

  return (
    <div className="dg-review">
      <div className="dg-review-main">
        <div className="dg-label-row">
          <span className="section-title">Cảnh sẽ được tạo</span>
          <span className="faint">thêm vào “{projectName}”</span>
        </div>
        <div className="dg-pv-list" role="list">
          {previews.map((p, i) => (
            <div key={i} className="dg-pv-row" role="listitem">
              <span className="mono dg-code">{sceneCode(startOrder + i)}</span>
              <div className="dg-pv-main">
                <div className={`dg-pv-title dg-ellipsis${p.title ? '' : ' faint'}`}>{p.title || 'Chưa đặt tên'}</div>
                <div className="dg-pv-excerpt">
                  <TokenText text={p.excerpt} />
                </div>
              </div>
              <div className="dg-pv-meta">
                <span className={`mono${p.chars > charLimit ? ' dg-over' : ''}`} title={p.chars > charLimit ? `Vượt giới hạn ${fmt(charLimit)} ký tự của ${modelName}` : 'Số ký tự'}>
                  {fmt(p.chars)} ký tự
                </span>
                <span className="dg-pv-tokens">
                  {p.images.length > 0 && (
                    <span className="dg-tok-count image" title={p.images.map((n) => '@image_' + n).join(', ')}>
                      {p.images.length} ảnh
                    </span>
                  )}
                  {p.videos.length > 0 && (
                    <span className="dg-tok-count video" title={p.videos.map((n) => '@video_' + n).join(', ')}>
                      {p.videos.length} video
                    </span>
                  )}
                  {!p.images.length && !p.videos.length && <span className="faint">không có token</span>}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <aside className="dg-review-side">
        <div className="dg-stats">
          <div>
            <b>{summary.prompts}</b>
            <span>cảnh</span>
          </div>
          <div>
            <b>{fmt(avg)}</b>
            <span>ký tự TB</span>
          </div>
          <div>
            <b>{summary.maxImage ? `@${summary.maxImage}` : '—'}</b>
            <span>ảnh cao nhất</span>
          </div>
        </div>

        <div className="dg-callout">
          <Info size={14} />
          <span>Prompt được gửi đúng như đã viết — không tự thêm đoạn nào. Cảnh mới dùng cấu hình {presetLine}.</span>
        </div>
        {summary.maxImage > 0 && (
          <div className="dg-callout ref">
            <Images size={14} />
            <span>
              {summary.withImages} prompt dùng ảnh tham chiếu (tới <code>@image_{summary.maxImage}</code>). Bước tiếp theo: chọn ảnh trong thư viện cho từng số — hoặc nhập
              ngay rồi nối ảnh sau.
            </span>
          </div>
        )}
        {summary.maxVideo > 0 && (
          <div className="dg-callout video">
            <Info size={14} />
            <span>
              {summary.withVideos} prompt có <code>@video_N</code>. Token được giữ nguyên; sau khi nhập, nối video (take) vào cảnh trên canvas để dùng làm video tham chiếu.
            </span>
          </div>
        )}
        {tooLong > 0 && (
          <div className="dg-callout warn">
            <TriangleAlert size={14} />
            <span>
              {tooLong} prompt dài hơn giới hạn {fmt(charLimit)} ký tự của {modelName} — cần rút gọn trước khi chạy.
            </span>
          </div>
        )}
        <p className="dg-note">Toàn bộ thao tác nhập là một bước — có thể hoàn tác bằng Ctrl+Z.</p>
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Step 3 — "Gán ảnh theo số": one library asset per @image_N, applied to every imported scene

function StepMapping({
  items,
  summary,
  assets,
  mapping,
  setMapping,
  onlyMentioned,
  setOnlyMentioned,
  startOrder,
  imageLimit,
  modelName,
}: {
  items: ImportItem[]
  summary: ImportSummary
  assets: Asset[]
  mapping: ImageMapping
  setMapping: (m: ImageMapping) => void
  onlyMentioned: boolean
  setOnlyMentioned: (v: boolean) => void
  startOrder: number
  imageLimit: number
  modelName: string
}) {
  const usable = useMemo(() => assets.filter((a) => a.imageIds.length > 0), [assets])
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])
  const [open, setOpen] = useState<number | null>(() => (usable.length ? 1 : null))
  const [preview, setPreview] = useState(() => {
    const i = items.findIndex((it) => /@image_\d/i.test(it.text))
    return i < 0 ? 0 : i
  })

  const results = useMemo(() => items.map((it) => applyImageMapping(it.text, mapping, assets, { onlyMentioned })), [items, mapping, assets, onlyMentioned])
  const overLimit = results.filter((r) => r.images > imageLimit).length
  const withPending = results.filter((r) => r.refs.length > 0 && r.pending.length > 0).length

  const assign = (n: number, id: string | null) => {
    const next = [...mapping]
    next[n - 1] = id
    setMapping(next)
    // Move on to the next number that is still empty.
    if (id) {
      const after = next.findIndex((x, i) => i >= n && !x)
      setOpen(after >= 0 ? after + 1 : null)
    } else setOpen(null)
  }

  const idx = Math.min(preview, items.length - 1)
  const res = results[idx]
  const resAssets = res.refs.map((id) => byId.get(id)).filter((a): a is Asset => !!a)

  return (
    <div className="dg-review">
      <div className="dg-review-main">
        <div className="dg-label-row">
          <span className="section-title">
            <Images size={13} /> Gán ảnh cho từng số
          </span>
          {mapping.some(Boolean) && (
            <button className="btn btn-ghost btn-sm" onClick={() => setMapping([])}>
              Bỏ gán hết
            </button>
          )}
        </div>
        <p className="dg-help">
          Prompt cũ đánh số ảnh <code>@image_1</code>, <code>@image_2</code>… theo thứ tự ảnh đã đính kèm. Chọn ảnh thư viện tương ứng — áp dụng cho cả {items.length} cảnh, số
          trong prompt được sửa để luôn trỏ đúng ảnh.
        </p>

        {!usable.length ? (
          <div className="empty dg-review-empty">
            Thư viện chưa có ảnh nào để gán.
            <br />
            Thêm nhân vật/bối cảnh vào thư viện trước, hoặc bấm “Bỏ qua, không gán” để nhập và nối ảnh sau.
          </div>
        ) : (
          <div className="dg-map-list">
            {mapping.map((id, i) => {
              const n = i + 1
              const asset = id ? byId.get(id) : undefined
              const isOpen = open === n
              const usage = summary.imageUsage[i] ?? 0
              return (
                <div key={n} className={`dg-map${isOpen ? ' open' : ''}${asset ? ' set' : ''}`}>
                  <div className="dg-map-row">
                    <mark className="dg-tok image">@image_{n}</mark>
                    <span className={`dg-map-usage${usage ? '' : ' faint'}`}>{usage ? `ở ${usage}/${items.length} prompt` : 'không prompt nào dùng'}</span>
                    <button className="dg-map-pick" onClick={() => setOpen(isOpen ? null : n)} aria-expanded={isOpen}>
                      {asset ? (
                        <>
                          <AssetAvatar asset={asset} size={22} />
                          <span className="dg-ellipsis">{asset.name}</span>
                          <span className="faint">@{asset.tag}</span>
                          {asset.imageIds.length > 1 && <span className="badge">{asset.imageIds.length} ảnh</span>}
                        </>
                      ) : (
                        <span className="faint">Chọn ảnh trong thư viện…</span>
                      )}
                      <ChevronDown size={14} className="dg-map-chev" />
                    </button>
                    {asset && (
                      <button className="dg-x" onClick={() => assign(n, null)} title="Bỏ gán" aria-label={`Bỏ gán @image_${n}`}>
                        <X size={13} />
                      </button>
                    )}
                  </div>
                  {isOpen && <AssetGrid assets={usable} selected={id} onPick={(picked) => assign(n, picked)} />}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <aside className="dg-review-side">
        <div className="dg-preview">
          <div className="dg-label-row">
            <span className="label">Xem trước</span>
            <select className="select dg-preview-select" value={idx} onChange={(e) => setPreview(Number(e.target.value))}>
              {items.map((it, i) => (
                <option key={i} value={i}>
                  {sceneCode(startOrder + i)}
                  {it.title ? ` · ${it.title}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="dg-pv-refs">
            {resAssets.length ? (
              resAssets.map((a) => (
                <span key={a.id} className="dg-pv-ref" title={`${a.name} · @${a.tag}`}>
                  <AssetAvatar asset={a} size={20} />
                  <span className="dg-ellipsis">{a.name}</span>
                </span>
              ))
            ) : (
              <span className="faint">Cảnh này chưa nối ảnh nào.</span>
            )}
          </div>
          <div className="dg-preview-body">
            <div className="dg-pv-prompt">
              <TokenText text={res.prompt} imageCount={res.refs.length ? res.images : undefined} />
            </div>
          </div>
          <div className="dg-pv-foot faint">
            {res.refs.length ? `${res.images} ảnh tham chiếu` : 'Prompt giữ nguyên'}
            {res.refs.length > 0 && res.pending.length > 0 && ` · ${res.pending.length} số chưa gán (đỏ)`}
          </div>
        </div>

        <div className="dg-options">
          <label className="checkbox">
            <input type="checkbox" checked={onlyMentioned} onChange={(e) => setOnlyMentioned(e.target.checked)} />
            <span>
              Chỉ nối ảnh mà từng prompt có nhắc tới
              <small className="dg-opt-sub">Tắt để mọi cảnh nhận đủ ảnh đã gán (ảnh không nhắc tới vẫn được gửi).</small>
            </span>
          </label>
        </div>

        {withPending > 0 && (
          <div className="dg-callout warn">
            <TriangleAlert size={14} />
            <span>
              {withPending} cảnh còn số chưa gán: các số đó được đánh lại ngay sau ảnh đã nối. Nối thêm ảnh vào cảnh sau (theo đúng thứ tự) là khớp lại.
            </span>
          </div>
        )}
        {overLimit > 0 && (
          <div className="dg-callout warn">
            <TriangleAlert size={14} />
            <span>
              {overLimit} cảnh vượt giới hạn {imageLimit} ảnh của {modelName}; ảnh cuối sẽ không được gửi.
            </span>
          </div>
        )}
        <p className="dg-note">Nhân vật có nhiều ảnh chiếm nhiều số liên tiếp. Gán cùng một nhân vật cho hai số → số thứ hai dùng ảnh thứ hai của nhân vật đó.</p>
      </aside>
    </div>
  )
}

function AssetGrid({ assets, selected, onPick }: { assets: Asset[]; selected: string | null; onPick: (id: string) => void }) {
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  const list = query ? assets.filter((a) => a.name.toLowerCase().includes(query) || a.tag.toLowerCase().includes(query)) : assets
  return (
    <div className="dg-asset-picker">
      {assets.length > 8 && (
        <label className="dg-search">
          <Search size={13} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm trong thư viện…" />
        </label>
      )}
      <div className="dg-asset-grid">
        {list.map((a) => (
          <button key={a.id} className={`dg-asset-tile${a.id === selected ? ' on' : ''}`} onClick={() => onPick(a.id)} title={`${a.name} · @${a.tag}`}>
            <span className="dg-asset-img" style={{ borderColor: a.color }}>
              <MediaImg id={a.imageIds[0]} className="dg-asset-thumb" alt={a.name} />
              {a.imageIds.length > 1 && <span className="dg-asset-count">{a.imageIds.length}</span>}
            </span>
            <span className="dg-asset-name dg-ellipsis">{a.name}</span>
          </button>
        ))}
        {!list.length && <div className="faint dg-asset-none">Không tìm thấy “{q}”.</div>}
      </div>
    </div>
  )
}
