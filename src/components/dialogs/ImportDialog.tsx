import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, FileText, Layers, Sparkles, TriangleAlert, Upload, X } from 'lucide-react'
import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { focusNodes } from '../../actions'
import { assetByTag, extractMentions, sceneCode } from '../../core/compile'
import {
  analyzePrompts,
  applyImport,
  imageTokens,
  parsePromptText,
  SAMPLE_IMPORT_TEXT,
  type ImportCandidate,
  type ImportItem,
  type PromptAnalysis,
  type SelectedCandidate,
} from '../../core/importPrompts'
import { MODELS } from '../../core/models'
import type { Asset, BlockPlacement, ModelId } from '../../core/types'
import { undo, useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { Modal } from '../common/Modal'
import './dialogs.css'

interface FileItem {
  name: string
  text: string
}
interface Choice {
  on: boolean
  title: string
  placement: BlockPlacement
  mergeVariants: boolean
}
type Step = 1 | 2 | 3

const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: 'Dán prompt' },
  { n: 2, label: 'Chọn khối' },
  { n: 3, label: 'Xác nhận' },
]

const fmt = (n: number) => n.toLocaleString('vi-VN')

/** Assets mentioned as @Tag in a prompt, within the model's image limit. */
function mentionedRefs(prompt: string, assets: Asset[], model: ModelId): string[] {
  const limit = MODELS[model].maxRefImages
  const refs: string[] = []
  let images = 0
  for (const tag of extractMentions(prompt)) {
    const a = assetByTag(assets, tag)
    if (!a || refs.includes(a.id)) continue
    const n = Math.max(1, a.imageIds.length)
    if (images + n > limit) continue
    refs.push(a.id)
    images += n
  }
  return refs
}

export function ImportDialog() {
  const closeDialog = useUI((s) => s.closeDialog)
  const assets = useProject((s) => s.project.assets)
  const projectName = useProject((s) => s.project.name)
  const sceneCount = useProject((s) => s.project.scenes.length)
  const blockCount = useProject((s) => s.project.blocks.length)
  const draftPreset = useProject((s) => s.project.presets[0])
  const existingOn = useProject(useShallow((s) => s.project.blocks.filter((b) => b.defaultOn).map((b) => b.title)))

  const [step, setStep] = useState<Step>(1)
  const [text, setText] = useState('')
  const [files, setFiles] = useState<FileItem[]>([])
  const [analysis, setAnalysis] = useState<PromptAnalysis | null>(null)
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [disableExisting, setDisableExisting] = useState(true)
  const [autoLink, setAutoLink] = useState(true)

  const items: ImportItem[] = useMemo(
    () => [...parsePromptText(text), ...files.map((f) => ({ title: f.name, text: f.text.trim() })).filter((i) => i.text)],
    [text, files],
  )
  const prompts = useMemo(() => items.map((i) => i.text), [items])
  const titles = useMemo(() => items.map((i) => i.title), [items])

  const selected: SelectedCandidate[] = useMemo(
    () =>
      (analysis?.candidates ?? [])
        .filter((c) => choices[c.key]?.on)
        .map((c) => ({ ...c, title: choices[c.key].title, placement: choices[c.key].placement, mergeVariants: choices[c.key].mergeVariants })),
    [analysis, choices],
  )
  const result = useMemo(
    () => (step >= 2 ? applyImport(prompts, selected, { titles, colorOffset: blockCount + 2 }) : null),
    [step, prompts, selected, titles, blockCount],
  )

  const model: ModelId = draftPreset?.model ?? 'seedance_2_5'
  const refsByScene = useMemo(
    () => (result && autoLink ? result.scenes.map((s) => mentionedRefs(s.prompt, assets, model)) : []),
    [result, autoLink, assets, model],
  )

  const goReview = () => {
    const a = analyzePrompts(prompts)
    setAnalysis(a)
    setChoices((prev) =>
      Object.fromEntries(a.candidates.map((c) => [c.key, prev[c.key] ?? { on: true, title: c.title, placement: c.placement, mergeVariants: false }])),
    )
    setStep(2)
  }

  const confirm = () => {
    if (!result) return
    const st = useProject.getState()
    const offExisting: Record<string, boolean> = disableExisting
      ? Object.fromEntries(st.project.blocks.filter((b) => b.defaultOn).map((b) => [b.id, false]))
      : {}
    const scenes = result.scenes.map((s, i) => ({
      ...s,
      blockOverrides: { ...offExisting, ...s.blockOverrides },
      refs: autoLink ? (refsByScene[i] ?? []) : [],
    }))
    st.applyImport({ blocks: result.blocks, scenes })
    const ids = scenes.map((s) => s.id)
    const ui = useUI.getState()
    ui.closeDialog()
    ui.setView('canvas')
    ui.select(ids)
    window.setTimeout(() => focusNodes(ids), 200)
    toast(`Đã nhập ${ids.length} cảnh${result.blocks.length ? ` và ${result.blocks.length} khối prompt` : ''}.`, {
      tone: 'success',
      action: { label: 'Hoàn tác', run: undo },
    })
  }

  const stepper = (
    <ol className="dg-steps">
      {STEPS.map((s) => (
        <li key={s.n} className={step === s.n ? 'active' : step > s.n ? 'done' : ''}>
          <span>{step > s.n ? <Check size={11} strokeWidth={3} /> : s.n}</span>
          {s.label}
        </li>
      ))}
    </ol>
  )

  let body: ReactNode
  let footer: ReactNode
  if (step === 1) {
    const chars = prompts.reduce((t, p) => t + p.length, 0)
    body = <StepInput text={text} setText={setText} files={files} setFiles={setFiles} items={items} />
    footer = (
      <>
        <span className="dg-foot-info">
          {items.length ? (
            <>
              Nhận diện <b>{items.length}</b> prompt · {fmt(chars)} ký tự
            </>
          ) : (
            'Chưa có prompt nào'
          )}
        </span>
        <button className="btn" onClick={closeDialog}>
          Huỷ
        </button>
        <button className="btn btn-primary" disabled={!items.length} onClick={goReview}>
          Tìm đoạn lặp lại <ArrowRight size={14} />
        </button>
      </>
    )
  } else if (step === 2 && analysis && result) {
    body = (
      <StepReview
        analysis={analysis}
        prompts={prompts}
        titles={titles}
        choices={choices}
        setChoices={setChoices}
        result={result}
        existingOn={existingOn}
        disableExisting={disableExisting}
        setDisableExisting={setDisableExisting}
        autoLink={autoLink}
        setAutoLink={setAutoLink}
        startOrder={sceneCount + 1}
      />
    )
    footer = (
      <>
        <span className="dg-foot-info">
          <b>{selected.length}</b> khối · tiết kiệm ~<b>{fmt(result.stats.savedPerScene)}</b> ký tự mỗi cảnh
        </span>
        <button className="btn" onClick={() => setStep(1)}>
          <ArrowLeft size={14} /> Quay lại
        </button>
        <button className="btn btn-primary" onClick={() => setStep(3)}>
          Tiếp tục <ArrowRight size={14} />
        </button>
      </>
    )
  } else if (result) {
    const first = sceneCode(sceneCount + 1)
    const last = sceneCode(sceneCount + result.scenes.length)
    const linkedScenes = refsByScene.filter((r) => r.length).length
    body = (
      <div className="dg-confirm">
        <div className="dg-confirm-summary">
          <h3>
            Sẽ thêm vào “{projectName}”
          </h3>
          <ul>
            <li>
              <b>{result.scenes.length}</b> cảnh mới ({first}
              {result.scenes.length > 1 ? ` → ${last}` : ''}), nối tiếp nhau, cấu hình theo preset “{draftPreset?.name ?? 'mặc định'}”.
            </li>
            <li>
              <b>{result.blocks.length}</b> khối prompt mới
              {result.blocks.length > 0 && (
                <span className="dg-chip-row">
                  {result.blocks.map((b) => (
                    <span key={b.id} className="dg-block-chip" style={{ borderColor: b.color + '88' }}>
                      <i style={{ background: b.color }} />
                      {b.title}
                      <small>{b.placement === 'before' ? 'trước' : 'sau'}</small>
                    </span>
                  ))}
                </span>
              )}
            </li>
            {disableExisting && existingOn.length > 0 && (
              <li>
                Tắt {existingOn.length} khối có sẵn cho các cảnh mới để prompt giữ đúng như cũ.
              </li>
            )}
            {autoLink && (
              <li>
                Tự nối @Tag có trong thư viện: <b>{linkedScenes}</b> cảnh.
              </li>
            )}
            {result.stats.imageTokenPrompts > 0 && (
              <li className="dg-warn-li">
                <TriangleAlert size={13} /> {result.stats.imageTokenPrompts} prompt còn token <code>@image_N</code> — được giữ nguyên, sau này có thể đổi thành @Tag
                của thư viện.
              </li>
            )}
            {result.stats.emptyScenes > 0 && (
              <li className="dg-warn-li">
                <TriangleAlert size={13} /> {result.stats.emptyScenes} cảnh chỉ còn khối, phần prompt riêng trống.
              </li>
            )}
          </ul>
          <p className="dg-note">Toàn bộ thao tác nhập là một bước — có thể hoàn tác bằng Ctrl+Z.</p>
        </div>
        <div className="dg-confirm-table">
          <div className="dg-ct-row dg-ct-head">
            <span>Cảnh</span>
            <span>Tên</span>
            <span className="r">Prompt riêng</span>
            <span className="r">Khối bật</span>
            <span>Nối</span>
          </div>
          {result.scenes.map((s, i) => {
            const on = result.blocks.filter((b) => s.blockOverrides[b.id] ?? b.defaultOn).length
            const refs = (refsByScene[i] ?? []).map((id) => assets.find((a) => a.id === id)).filter((a): a is Asset => !!a)
            return (
              <div key={s.id} className="dg-ct-row">
                <span className="mono dg-code">{sceneCode(sceneCount + i + 1)}</span>
                <span className={s.title ? 'dg-ellipsis' : 'faint'}>{s.title || 'Chưa đặt tên'}</span>
                <span className="r mono">
                  {fmt([...s.prompt].length)}
                  <span className="faint"> / {fmt([...prompts[i]].length)}</span>
                </span>
                <span className="r mono">
                  {on}/{result.blocks.length}
                </span>
                <span className="dg-ellipsis faint">
                  {refs.length ? refs.map((a) => '@' + a.tag).join(' ') : imageTokens(s.prompt).length ? imageTokens(s.prompt).join(' ') : '—'}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    )
    footer = (
      <>
        <span className="dg-foot-info">Cảnh mới sẽ được chọn sẵn trên canvas.</span>
        <button className="btn" onClick={() => setStep(2)}>
          <ArrowLeft size={14} /> Quay lại
        </button>
        <button className="btn btn-primary" onClick={confirm}>
          <Check size={14} /> Nhập {result.scenes.length} cảnh
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
    const read = await Promise.all(ok.map(async (f) => ({ name: f.name.replace(/\.[^.]+$/, ''), text: await f.text() })))
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

  const textCount = items.length - files.filter((f) => f.text.trim()).length

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
          placeholder={'Dán nhiều prompt, mỗi prompt cách nhau bằng một dòng ---\n\nPrompt 1 …\n\n---\n\nPrompt 2 …\n\nCó thể đặt tên cảnh bằng dòng: === S01: Tên cảnh ==='}
        />
      </div>

      <div className="dg-import-side">
        <div className="dg-drop" onClick={() => inputRef.current?.click()} role="button" tabIndex={0}>
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
            <small>3 prompt mẫu có đoạn phong cách, âm thanh và ràng buộc lặp lại</small>
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
            <li>Đoạn văn (cách nhau bằng dòng trống) lặp lại ở nhiều prompt sẽ được đề xuất thành khối prompt.</li>
          </ul>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

function StepReview({
  analysis,
  prompts,
  titles,
  choices,
  setChoices,
  result,
  existingOn,
  disableExisting,
  setDisableExisting,
  autoLink,
  setAutoLink,
  startOrder,
}: {
  analysis: PromptAnalysis
  prompts: string[]
  titles: string[]
  choices: Record<string, Choice>
  setChoices: (fn: (prev: Record<string, Choice>) => Record<string, Choice>) => void
  result: ReturnType<typeof applyImport>
  existingOn: string[]
  disableExisting: boolean
  setDisableExisting: (v: boolean) => void
  autoLink: boolean
  setAutoLink: (v: boolean) => void
  startOrder: number
}) {
  const [preview, setPreview] = useState(0)
  const n = prompts.length
  const cands = analysis.candidates
  const onCount = cands.filter((c) => choices[c.key]?.on).length
  const patch = (key: string, p: Partial<Choice>) => setChoices((prev) => ({ ...prev, [key]: { ...prev[key], ...p } }))
  const setAll = (on: boolean) => setChoices((prev) => Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, on }])))

  const idx = Math.min(preview, result.scenes.length - 1)
  const scene = result.scenes[idx]
  const sceneBlocks = result.blocks.filter((b) => scene.blockOverrides[b.id] ?? b.defaultOn)
  const before = sceneBlocks.filter((b) => b.placement === 'before')
  const after = sceneBlocks.filter((b) => b.placement === 'after')
  const { stats } = result

  return (
    <div className="dg-review">
      <div className="dg-review-main">
        <div className="dg-label-row">
          <span className="section-title">
            <Layers size={13} /> Đoạn lặp lại → khối prompt
          </span>
          {cands.length > 0 && (
            <span className="dg-review-bulk">
              <span className="faint">
                {onCount}/{cands.length} đã chọn
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => setAll(onCount !== cands.length)}>
                {onCount === cands.length ? 'Bỏ chọn hết' : 'Chọn hết'}
              </button>
            </span>
          )}
        </div>
        <p className="dg-help">
          Đoạn văn xuất hiện ở ít nhất {analysis.threshold} prompt được đề xuất. Khối được chèn vào mọi cảnh từng có đoạn đó — sửa một lần, áp dụng cho tất cả.
        </p>

        {cands.length === 0 ? (
          <div className="empty dg-review-empty">
            Không tìm thấy đoạn nào lặp lại ở ít nhất {analysis.threshold} prompt.
            <br />
            Vẫn có thể nhập {n} cảnh với nguyên văn prompt.
          </div>
        ) : (
          <div className="dg-cands">
            {cands.map((c) => (
              <CandidateCard key={c.key} c={c} total={n} choice={choices[c.key]} onPatch={(p) => patch(c.key, p)} />
            ))}
          </div>
        )}
      </div>

      <aside className="dg-review-side">
        <div className="dg-stats">
          <div>
            <b>{n}</b>
            <span>cảnh</span>
          </div>
          <div>
            <b>{result.blocks.length}</b>
            <span>khối mới</span>
          </div>
          <div>
            <b>−{fmt(stats.savedPerScene)}</b>
            <span>ký tự / cảnh</span>
          </div>
        </div>
        <div className="dg-bar-compare" title={`${fmt(stats.charsBefore)} → ${fmt(stats.charsAfter)} ký tự prompt riêng`}>
          <div className="dg-bar-label">
            <span>Prompt riêng</span>
            <span className="mono">
              {fmt(Math.round(stats.charsBefore / Math.max(1, n)))} → {fmt(Math.round(stats.charsAfter / Math.max(1, n)))} ký tự TB
            </span>
          </div>
          <div className="progress">
            <i style={{ width: `${stats.charsBefore ? Math.max(2, (stats.charsAfter / stats.charsBefore) * 100) : 100}%`, background: 'var(--ref)' }} />
          </div>
        </div>

        {stats.imageTokenPrompts > 0 && (
          <div className="dg-callout warn">
            <TriangleAlert size={14} />
            <span>
              {stats.imageTokenPrompts} prompt có token <code>@image_N</code>. Token được giữ nguyên; sau khi nhập có thể nối ảnh thư viện và đổi thành @Tag.
            </span>
          </div>
        )}

        <div className="dg-preview">
          <div className="dg-label-row">
            <span className="label">Xem trước</span>
            <select className="select dg-preview-select" value={idx} onChange={(e) => setPreview(Number(e.target.value))}>
              {result.scenes.map((s, i) => (
                <option key={s.id} value={i}>
                  {sceneCode(startOrder + i)}
                  {titles[i] ? ` · ${titles[i]}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="dg-preview-body">
            {before.map((b) => (
              <span key={b.id} className="dg-pv-block" style={{ borderColor: b.color }}>
                {b.title}
              </span>
            ))}
            <div className="dg-pv-prompt">{scene.prompt || <span className="faint">(prompt riêng trống)</span>}</div>
            {after.map((b) => (
              <span key={b.id} className="dg-pv-block" style={{ borderColor: b.color }}>
                {b.title}
              </span>
            ))}
          </div>
          <div className="dg-pv-foot faint">
            {fmt([...prompts[idx]].length)} → {fmt([...scene.prompt].length)} ký tự riêng · {sceneBlocks.length} khối bật
          </div>
        </div>

        <div className="dg-options">
          {existingOn.length > 0 && (
            <label className="checkbox">
              <input type="checkbox" checked={disableExisting} onChange={(e) => setDisableExisting(e.target.checked)} />
              <span>
                Tắt {existingOn.length} khối có sẵn của dự án cho các cảnh mới
                <small className="dg-opt-sub">{existingOn.slice(0, 4).join(', ') + (existingOn.length > 4 ? '…' : '')}</small>
              </span>
            </label>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={autoLink} onChange={(e) => setAutoLink(e.target.checked)} />
            <span>
              Tự nối @Tag đã có trong thư viện
              <small className="dg-opt-sub">Ví dụ @Elara trong prompt → nối nhân vật Elara vào cảnh</small>
            </span>
          </label>
        </div>
      </aside>
    </div>
  )
}

function CandidateCard({ c, total, choice, onPatch }: { c: ImportCandidate; total: number; choice: Choice | undefined; onPatch: (p: Partial<Choice>) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [showVariants, setShowVariants] = useState(false)
  if (!choice) return null
  const variants = c.variants.length
  const exact = c.variants[0]?.count ?? c.count
  return (
    <div className={`dg-cand ${choice.on ? 'on' : ''}`}>
      <div className="dg-cand-head">
        <input type="checkbox" className="dg-cand-check" checked={choice.on} onChange={(e) => onPatch({ on: e.target.checked })} aria-label="Dùng làm khối" />
        <input
          className="input dg-cand-title"
          value={choice.title}
          onChange={(e) => onPatch({ title: e.target.value })}
          placeholder="Tên khối"
          disabled={!choice.on}
          aria-label="Tên khối"
        />
        <div className="dg-seg" role="radiogroup" aria-label="Vị trí">
          {(['before', 'after'] as const).map((p) => (
            <button key={p} className={choice.placement === p ? 'active' : ''} disabled={!choice.on} onClick={() => onPatch({ placement: p })} role="radio" aria-checked={choice.placement === p}>
              {p === 'before' ? 'Trước prompt' : 'Sau prompt'}
            </button>
          ))}
        </div>
      </div>
      <div className="dg-cand-meta">
        <span className="dg-cand-count">
          xuất hiện ở <b>{c.count}</b>/{total} prompt
        </span>
        <span className="dg-cand-bar">
          <i style={{ width: `${(c.count / Math.max(1, total)) * 100}%` }} />
        </span>
        <span className="faint">{c.avgPosition < 0.35 ? 'thường ở đầu' : c.avgPosition > 0.65 ? 'thường ở cuối' : 'thường ở giữa'}</span>
        {variants > 1 && (
          <button className="dg-variants-btn" onClick={() => setShowVariants((v) => !v)}>
            {showVariants ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {variants} biến thể
          </button>
        )}
      </div>
      <div className={`dg-cand-text ${expanded ? 'expanded' : ''}`} onClick={() => setExpanded((e) => !e)} title={expanded ? 'Thu gọn' : 'Xem toàn bộ'}>
        {c.text}
      </div>
      {variants > 1 && showVariants && (
        <div className="dg-variants">
          <p>
            Văn bản khối lấy theo bản phổ biến nhất ({exact} prompt). Prompt có bản khác giữ nguyên đoạn đó và tắt khối này — trừ khi gộp.
          </p>
          {c.variants.slice(1).map((v) => (
            <div key={v.key} className="dg-variant">
              <span className="badge">{v.count}×</span>
              <span>{v.text}</span>
            </div>
          ))}
          <label className="checkbox">
            <input type="checkbox" checked={choice.mergeVariants} disabled={!choice.on} onChange={(e) => onPatch({ mergeVariants: e.target.checked })} />
            Gộp các biến thể vào khối (bỏ phần khác biệt)
          </label>
        </div>
      )}
    </div>
  )
}
