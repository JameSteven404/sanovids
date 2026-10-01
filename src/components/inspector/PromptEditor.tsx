// Scene prompt editor. The prompt is sent exactly as written; media are referenced with numbered tokens
// @image_N (scene.refs order) and @video_N (scene.videoRefs order).
// - The textarea is controlled by LOCAL state so typing in a 6k+ char prompt stays instant; the store is
//   updated through a short throttle (and immediately on blur / token insert / Ctrl shortcuts).
// - Tokens are highlighted INSIDE the textarea: the textarea text is transparent and a backdrop mirror layer
//   (same font metrics, scroll synced) draws the colored text behind it.
// - Typing "@" opens a caret-anchored popup: linked images, linked videos, library assets ("Nối & chèn").
// - Legend under the textarea: one chip per image / video; click inserts, hover highlights occurrences.
import { AtSign, Film, Image as ImageIcon, Link2, Maximize2, Minimize2, WandSparkles } from 'lucide-react'
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { ensureAssetToken } from '../../actions'
import { sceneCode } from '../../core/compile'
import type { Asset } from '../../core/types'
import { undoToastAction, useProject } from '../../store/project'
import { toast } from '../../store/ui'
import { AssetAvatar, MediaImg } from '../common/Media'
import { caretCoordinates } from './caret'
import { useTakeInfos } from './hooks'
import { findMention, sameToken, type MentionToken } from './mentions'
import { EMPTY_IDS, fmt, KIND_LABEL, usePref } from './shared'
import {
  imageOptsFor,
  insertAt,
  legacyAssets,
  mediaCountLabel,
  replaceLegacyTags,
  segmentPrompt,
  suggestionToken,
  suggestMedia,
  type ImageOpt,
  type LibraryOpt,
  type MediaSuggestion,
  type Seg,
  type VideoOpt,
} from './tokens'

const COMMIT_MS = 160
const FIELD_SIZING = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')

/** Flush functions of mounted editors, so other panels can commit pending text before changing refs. */
const flushers = new Map<string, () => void>()

/** Commit the text being typed in the prompt editor of `sceneId` (no-op when none is mounted). */
export function flushPromptEditor(sceneId: string) {
  flushers.get(sceneId)?.()
}

export type TokenHighlight = { kind: 'image' | 'video'; n: number } | null

/** Toast for assets auto-linked by legacy @Tag mentions (pasted text). "Hoàn tác" unlinks them and turns
 *  their @Tag mentions into plain names, in one undo step (otherwise the next edit would link them again). */
function announceLinked(sceneId: string, linked: string[]) {
  const { project } = useProject.getState()
  const scene = project.scenes.find((s) => s.id === sceneId)
  const names = linked.map((id) => project.assets.find((a) => a.id === id)).filter((a): a is Asset => !!a).map((a) => '@' + a.tag)
  if (!scene || !names.length) return
  toast(`Đã tự nối ${names.join(', ')} vào ${sceneCode(scene.order)}. Bấm “Đổi @Tên → @image_N” bên dưới ô prompt để dùng số.`, {
    tone: 'success',
    action: { label: 'Hoàn tác', run: () => undoAutoLink(sceneId, linked) },
  })
}

function undoAutoLink(sceneId: string, linked: string[]) {
  flushPromptEditor(sceneId)
  const st = useProject.getState()
  const scene = st.project.scenes.find((s) => s.id === sceneId)
  if (!scene) return
  const assets = linked.map((id) => st.project.assets.find((a) => a.id === id)).filter((a): a is Asset => !!a)
  const byTag = new Map(assets.map((a) => [a.tag.toLowerCase(), a.name]))
  const { text } = replaceLegacyTags(scene.prompt, byTag)
  st.restoreScene(sceneId, { prompt: text, refs: scene.refs.filter((r) => !linked.includes(r)), videoRefs: scene.videoRefs, settings: scene.settings })
  toast(`Đã bỏ nối ${assets.map((a) => '@' + a.tag).join(', ')} — giữ tên trong prompt.`, { action: undoToastAction() })
}

export function PromptEditor({ sceneId }: { sceneId: string }) {
  const storePrompt = useProject((s) => s.project.scenes.find((x) => x.id === sceneId)?.prompt ?? '')
  const refs = useProject((s) => s.project.scenes.find((x) => x.id === sceneId)?.refs) ?? EMPTY_IDS
  const videoRefs = useProject((s) => s.project.scenes.find((x) => x.id === sceneId)?.videoRefs) ?? EMPTY_IDS
  const assets = useProject((s) => s.project.assets)
  const takeInfos = useTakeInfos(videoRefs)

  const imageOpts = useMemo(() => imageOptsFor(assets, refs), [assets, refs])
  const videoOpts = useMemo<VideoOpt[]>(
    () => takeInfos.map((t, i) => ({ n: i + 1, takeId: t.id, label: t.label, posterId: t.posterId, status: t.status ?? 'deleted' })),
    [takeInfos],
  )
  const libraryOpts = useMemo<LibraryOpt[]>(
    () => assets.filter((a) => a.imageIds.length && !refs.includes(a.id)).map((a) => ({ assetId: a.id, name: a.name, tag: a.tag, kind: a.kind })),
    [assets, refs],
  )

  const [text, setText] = useState(storePrompt)
  const textRef = useRef(storePrompt)
  const committedRef = useRef(storePrompt)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const backRef = useRef<HTMLDivElement>(null)
  const pendingSel = useRef<number | null>(null)
  /** Last selection, so legend chips insert at the caret even after the textarea lost focus. */
  const lastSel = useRef<{ start: number; end: number } | null>(null)
  const dismissedAt = useRef<number | null>(null)
  /** The "@xxx" currently being typed (mirrors `mention` state, readable from timers). */
  const mentionRef = useRef<MentionToken | null>(null)
  const [tall, setTall] = usePref('promptTall', false)
  const [hl, setHl] = useState<TokenHighlight>(null)

  // ---------- commit to the store ----------
  const commit = useCallback(
    (opts: { silent?: boolean } = {}): string[] => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const next = textRef.current
      if (next === committedRef.current) return []
      committedRef.current = next
      const linked = useProject.getState().setScenePrompt(sceneId, next)
      if (linked.length && !opts.silent) announceLinked(sceneId, linked)
      return linked
    },
    [sceneId],
  )
  const schedule = useCallback(() => {
    if (timerRef.current !== null) return
    const tick = () => {
      timerRef.current = null
      // Hold the commit while an "@xxx" is still being typed, so a half-typed legacy "@Lumi…" is not auto-linked.
      if (mentionRef.current) {
        timerRef.current = setTimeout(tick, COMMIT_MS)
        return
      }
      commit()
    }
    timerRef.current = setTimeout(tick, COMMIT_MS)
  }, [commit])

  useEffect(() => {
    const flush = () => void commit()
    flushers.set(sceneId, flush)
    return () => {
      flush()
      if (flushers.get(sceneId) === flush) flushers.delete(sceneId)
    }
  }, [sceneId, commit])

  // ---------- external changes (undo, renumbering, restore from take…) ----------
  // Layout effect: replace the text before paint so the old prompt never flashes.
  useLayoutEffect(() => {
    if (storePrompt === committedRef.current) return
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const prev = textRef.current
    committedRef.current = storePrompt
    textRef.current = storePrompt
    const ta = taRef.current
    if (ta && document.activeElement === ta) {
      // keep the caret roughly where it was
      const caret = ta.selectionStart
      let p = 0
      const lim = Math.min(prev.length, storePrompt.length)
      while (p < lim && prev.charCodeAt(p) === storePrompt.charCodeAt(p)) p++
      pendingSel.current = caret <= p ? caret : Math.max(p, caret + storePrompt.length - prev.length)
    }
    setText(storePrompt)
  }, [storePrompt])

  /** Keep the backdrop's text box identical to the textarea's (scrollbar width, scroll offset). */
  const syncBackdrop = useCallback(() => {
    const ta = taRef.current
    const back = backRef.current
    if (!ta || !back) return
    const cs = getComputedStyle(ta)
    const borders = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0)
    const scrollbar = Math.max(0, ta.offsetWidth - ta.clientWidth - borders)
    const pr = `${(parseFloat(cs.paddingRight) || 0) + scrollbar}px`
    if (back.style.paddingRight !== pr) back.style.paddingRight = pr
    back.scrollTop = ta.scrollTop
  }, [])

  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    if (pendingSel.current !== null) {
      const c = Math.min(pendingSel.current, ta.value.length)
      pendingSel.current = null
      ta.setSelectionRange(c, c)
    }
    if (!FIELD_SIZING) {
      ta.style.height = 'auto'
      ta.style.height = `${ta.scrollHeight + 2}px`
    }
    syncBackdrop()
  }, [text, tall, syncBackdrop])

  useEffect(() => {
    const ta = taRef.current
    if (!ta || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => syncBackdrop())
    ro.observe(ta)
    return () => ro.disconnect()
  }, [syncBackdrop])

  // ---------- "@" popup ----------
  const [mention, setMention] = useState<MentionToken | null>(null)
  const [active, setActive] = useState(0)

  const setToken = useCallback((m: MentionToken | null) => {
    const prev = mentionRef.current
    if (sameToken(prev, m)) return
    mentionRef.current = m
    if (!prev || !m || prev.query !== m.query) setActive(0)
    setMention(m)
  }, [])

  /** `typing`: called from onChange (may open the popup). Caret moves only update or close it. */
  const updateMention = useCallback(
    (value: string, selStart: number, selEnd: number, typing: boolean) => {
      lastSel.current = { start: selStart, end: selEnd }
      const raw = selStart === selEnd ? findMention(value, selStart) : null
      if (!typing && raw && raw.start !== mentionRef.current?.start) {
        setToken(null)
        return
      }
      if (raw && raw.start === dismissedAt.current) {
        setToken(null) // closed with Esc (or just inserted): stay closed while the caret is on this token
        return
      }
      dismissedAt.current = null
      setToken(raw)
    },
    [setToken],
  )

  const suggestions = useMemo<MediaSuggestion[]>(
    () => (mention ? suggestMedia(mention.query, imageOpts, videoOpts, libraryOpts) : []),
    [mention, imageOpts, videoOpts, libraryOpts],
  )

  /** Replace text[start, end) with `token` (+ spacing) through the native undo stack, then commit. */
  const replaceRange = useCallback(
    (start: number, end: number, token: string) => {
      const ta = taRef.current
      const value = textRef.current
      if (!ta) return
      const { insert, next, caret } = insertAt(value, start, end, token)
      // Caret target is applied by the layout effect after the re-render (set first: the render may happen inside execCommand).
      pendingSel.current = caret
      ta.focus()
      ta.setSelectionRange(start, end)
      // execCommand keeps the textarea's native undo stack (Ctrl+Z) working; it fires onChange.
      let ok = false
      try {
        ok = document.execCommand('insertText', false, insert)
      } catch {
        ok = false
      }
      if (!ok || textRef.current === value) {
        textRef.current = next
        setText(next)
      }
      commit()
    },
    [commit],
  )

  const pick = useCallback(
    (s: MediaSuggestion) => {
      const ta = taRef.current
      const tok = (ta && findMention(textRef.current, ta.selectionStart)) || mentionRef.current
      if (!tok) return
      setToken(null)
      // If the caret ends right after the token (e.g. before "."), don't reopen the popup for it.
      dismissedAt.current = tok.start
      let token = suggestionToken(s)
      if (s.type === 'link') {
        token = ensureAssetToken(sceneId, s.assetId)
        if (!token) return
        toast(`Đã nối ${s.name} vào cảnh → ${token}.`, { tone: 'success' })
      }
      if (token) replaceRange(tok.start, tok.end, token)
    },
    [replaceRange, sceneId, setToken],
  )

  /** Legend chip: insert a token at the caret (or the last caret position). */
  const insertAtCaret = useCallback(
    (token: string) => {
      const ta = taRef.current
      if (!ta) return
      const focused = document.activeElement === ta
      const len = textRef.current.length
      const sel = focused ? { start: ta.selectionStart, end: ta.selectionEnd } : (lastSel.current ?? { start: len, end: len })
      replaceRange(Math.min(sel.start, len), Math.min(sel.end, len), token)
    },
    [replaceRange],
  )

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (mention && suggestions.length) {
      const n = suggestions.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => (a + 1) % n)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (a - 1 + n) % n)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault()
        const s = suggestions[Math.min(active, n - 1)]
        if (s) pick(s)
        return
      }
    }
    if (mention && e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      e.nativeEvent.stopImmediatePropagation()
      dismissedAt.current = mention.start
      setToken(null)
      return
    }
    // Global shortcuts (Ctrl+Enter run, Ctrl+S save…) must see the latest text.
    if (e.ctrlKey || e.metaKey) commit()
  }

  // ---------- highlight + derived ----------
  const legacyTags = useMemo(() => new Set(assets.map((a) => a.tag.toLowerCase())), [assets])
  // The backdrop must follow the textarea synchronously (its text is the only visible copy).
  const segs = useMemo(() => segmentPrompt(text, imageOpts.length, videoRefs.length, legacyTags), [text, imageOpts.length, videoRefs.length, legacyTags])
  // Everything else may lag behind fast typing.
  const deferredText = useDeferredValue(text)
  const charCount = useMemo(() => [...deferredText].length, [deferredText])
  const legacy = useMemo(() => legacyAssets(deferredText, assets), [deferredText, assets])

  const fixLegacy = useCallback(() => {
    commit({ silent: true })
    const tokens = new Map<string, string>()
    let noImage = 0
    for (const a of legacyAssets(textRef.current, useProject.getState().project.assets)) {
      const tok = a.imageIds.length ? ensureAssetToken(sceneId, a.id) : null
      if (tok) tokens.set(a.tag.toLowerCase(), tok)
      else noImage++
    }
    const scene = useProject.getState().project.scenes.find((s) => s.id === sceneId)
    if (!scene) return
    const { text: next, replaced } = replaceLegacyTags(scene.prompt, tokens)
    if (replaced) useProject.getState().updateScene(sceneId, { prompt: next })
    if (replaced) {
      toast(`Đã đổi ${replaced} @Tên thành @image_N${noImage ? ` (bỏ qua ${noImage} mục chưa có ảnh)` : ''}.`, { tone: 'success', action: undoToastAction() })
    } else if (noImage) {
      toast('Các mục được nhắc chưa có ảnh nên chưa có số @image. Thêm ảnh cho chúng trước.', { tone: 'warning' })
    }
  }, [commit, sceneId])

  return (
    <div className="in-pe">
      <div className="in-pe-wrap">
        <Backdrop backRef={backRef} segs={segs} hl={hl} />
        <textarea
          ref={taRef}
          className={`textarea in-pe-ta ${tall ? 'is-tall' : ''} ${FIELD_SIZING ? 'auto-size' : ''}`}
          value={text}
          spellCheck={false}
          rows={8}
          placeholder={'Mô tả cảnh… Gõ @ để chèn ảnh (@image_1) hoặc video (@video_1) tham chiếu.\nVí dụ: At dusk @image_1 climbs the last rocky slope above @image_2…'}
          onChange={(e) => {
            const v = e.target.value
            textRef.current = v
            setText(v)
            schedule()
            updateMention(v, e.target.selectionStart, e.target.selectionEnd, true)
          }}
          onSelect={(e) => {
            const ta = e.currentTarget
            updateMention(ta.value, ta.selectionStart, ta.selectionEnd, false)
          }}
          onScroll={syncBackdrop}
          onKeyDown={onKeyDown}
          onBlur={(e) => {
            lastSel.current = { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd }
            commit()
            setToken(null)
          }}
          aria-label="Prompt của cảnh"
          aria-autocomplete="list"
          aria-expanded={!!mention && suggestions.length > 0}
        />
        <button
          type="button"
          className="icon-btn in-pe-expand"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setTall(!tall)}
          title={tall ? 'Thu gọn ô prompt' : 'Mở rộng ô prompt'}
        >
          {tall ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>
      {mention && suggestions.length > 0 && (
        <MentionPopup
          taRef={taRef}
          anchor={mention.start}
          query={mention.query}
          items={suggestions}
          active={Math.min(active, suggestions.length - 1)}
          onHover={setActive}
          onPick={pick}
        />
      )}
      <div className="in-pe-meta">
        <span className="in-pe-hint">
          <AtSign size={12} />
          Gõ <span className="kbd">@</span> để chèn ảnh / video tham chiếu
        </span>
        <span className="mono faint" title="Số ký tự của prompt (được gửi đúng như viết)">
          {fmt(charCount)} ký tự
        </span>
      </div>
      {legacy.length > 0 && <LegacyFix assets={legacy} imageOpts={imageOpts} onFix={fixLegacy} />}
      <TokenLegend images={imageOpts} videos={videoOpts} onInsert={insertAtCaret} onHover={setHl} />
    </div>
  )
}

// ---------------- backdrop (token highlighting inside the textarea) ----------------
const Backdrop = memo(function Backdrop({ backRef, segs, hl }: { backRef: RefObject<HTMLDivElement | null>; segs: Seg[]; hl: TokenHighlight }) {
  return (
    <div ref={backRef} className={`in-pe-back ${hl ? 'has-hl' : ''}`} aria-hidden="true">
      {segs.map((s, i) => {
        if (s.kind === 'text') return s.text
        const isHl = !!hl && hl.kind === s.kind && hl.n === s.n
        return (
          <mark key={i} className={`in-tk is-${s.kind} ${s.invalid ? 'is-invalid' : ''} ${isHl ? 'is-hl' : ''}`}>
            {s.text}
          </mark>
        )
      })}
      {/* A trailing newline needs something after it to take up a line, like it does in the textarea. */}
      {'​'}
    </div>
  )
})

// ---------------- legacy @Tag quick fix ----------------
const LegacyFix = memo(function LegacyFix({ assets, imageOpts, onFix }: { assets: Asset[]; imageOpts: ImageOpt[]; onFix: () => void }) {
  const first = assets[0]
  const slot = imageOpts.find((o) => o.assetId === first.id)
  const label = assets.length === 1 ? `Đổi @${first.tag} → ${slot ? `@image_${slot.n}` : '@image_N'}` : `Đổi ${assets.length} @Tên → @image_N`
  return (
    <div className="in-pe-chips">
      <span className="in-hint-chip is-legacy" title="Prompt đang dùng @Tên kiểu cũ. Vẫn chạy được (tự đổi khi gửi), nhưng @image_N rõ ràng hơn.">
        <WandSparkles size={12} />
        <span>
          Có {assets.map((a) => '@' + a.tag).slice(0, 3).join(', ')}
          {assets.length > 3 ? '…' : ''} kiểu cũ
        </span>
        <button type="button" className="in-hint-btn" onMouseDown={(e) => e.preventDefault()} onClick={onFix}>
          {label}
        </button>
      </span>
    </div>
  )
})

// ---------------- legend ----------------
const TokenLegend = memo(function TokenLegend({
  images,
  videos,
  onInsert,
  onHover,
}: {
  images: ImageOpt[]
  videos: VideoOpt[]
  onInsert: (token: string) => void
  onHover: (h: TokenHighlight) => void
}) {
  if (!images.length && !videos.length) {
    return <div className="in-legend-empty faint">Chưa có ảnh / video tham chiếu — gõ @ để nối từ thư viện, hoặc kéo nhân vật / video vào cảnh.</div>
  }
  const keep = (e: { preventDefault: () => void }) => e.preventDefault() // keep the caret in the textarea
  return (
    <div className="in-legend" onMouseLeave={() => onHover(null)}>
      <span className="in-legend-count">{mediaCountLabel(images.length, videos.length)}</span>
      {images.map((o) => (
        <button
          type="button"
          key={'i' + o.n}
          className="in-legend-chip is-image"
          onMouseDown={keep}
          onClick={() => onInsert(`@image_${o.n}`)}
          onMouseEnter={() => onHover({ kind: 'image', n: o.n })}
          onFocus={() => onHover({ kind: 'image', n: o.n })}
          onBlur={() => onHover(null)}
          title={`Chèn @image_${o.n} (${o.name}${o.imageTotal > 1 ? `, ảnh ${o.imageIndex + 1}/${o.imageTotal}` : ''})`}
        >
          <MediaImg id={o.imageId} className="in-legend-thumb" />
          <span className="in-legend-tok">@image_{o.n}</span>
          <span className="in-legend-name">
            · {o.name}
            {o.imageTotal > 1 ? ` (${o.imageIndex + 1})` : ''}
          </span>
        </button>
      ))}
      {videos.map((v) => (
        <button
          type="button"
          key={'v' + v.n}
          className={`in-legend-chip is-video ${v.status === 'completed' ? '' : 'is-off'}`}
          onMouseDown={keep}
          onClick={() => onInsert(`@video_${v.n}`)}
          onMouseEnter={() => onHover({ kind: 'video', n: v.n })}
          onFocus={() => onHover({ kind: 'video', n: v.n })}
          onBlur={() => onHover(null)}
          title={`Chèn @video_${v.n} (${v.label})`}
        >
          {v.posterId ? <MediaImg id={v.posterId} className="in-legend-thumb is-wide" /> : <Film size={12} className="in-legend-icon" />}
          <span className="in-legend-tok">@video_{v.n}</span>
          <span className="in-legend-name">· {v.label}</span>
        </button>
      ))}
    </div>
  )
})

// ---------------- popup ----------------
const POP_W = 312
type PopPos = { left: number; top?: number; bottom?: number }

const GROUP_LABEL: Record<MediaSuggestion['type'], string> = {
  image: 'Ảnh đã nối',
  video: 'Video đã nối',
  link: 'Thư viện — nối & chèn',
}

const MentionPopup = memo(function MentionPopup({
  taRef,
  anchor,
  query,
  items,
  active,
  onHover,
  onPick,
}: {
  taRef: RefObject<HTMLTextAreaElement | null>
  anchor: number
  query: string
  items: MediaSuggestion[]
  active: number
  onHover: (i: number) => void
  onPick: (s: MediaSuggestion) => void
}) {
  const [pos, setPos] = useState<PopPos | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const count = items.length

  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    const compute = () => {
      const c = caretCoordinates(ta, anchor)
      const r = ta.getBoundingClientRect()
      const x = r.left + c.left - ta.scrollLeft
      const yTop = r.top + c.top - ta.scrollTop
      const estH = Math.min(400, 72 + count * 40)
      const left = Math.round(Math.max(8, Math.min(x - 12, window.innerWidth - POP_W - 8)))
      const below = yTop + c.height + 6
      const next: PopPos =
        below + estH > window.innerHeight - 8 && yTop - estH - 6 > 8
          ? { left, bottom: Math.round(window.innerHeight - yTop + 4) }
          : { left, top: Math.round(Math.min(below, window.innerHeight - 60)) }
      setPos((p) => (p && p.left === next.left && p.top === next.top && p.bottom === next.bottom ? p : next))
    }
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && popRef.current?.contains(e.target)) return
      compute()
    }
    compute()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', compute)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', compute)
    }
    // `query`: typing the token can wrap it (and its "@") onto the next line, so re-measure on every keystroke.
  }, [taRef, anchor, count, query])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!pos) return null
  return createPortal(
    <div
      ref={popRef}
      className="in-mention"
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: POP_W }}
      onMouseDown={(e) => e.preventDefault() /* keep focus in the textarea */}
      role="listbox"
    >
      <div className="in-mention-head">
        <AtSign size={11} />
        {query ? (
          <span>
            Tìm <b>@{query}</b>…
          </span>
        ) : (
          <span>Chèn ảnh / video tham chiếu</span>
        )}
      </div>
      <div className="in-mention-list" ref={listRef}>
        {items.map((s, i) => (
          <MentionRow
            key={s.type === 'image' ? 'i' + s.n : s.type === 'video' ? 'v' + s.n : 'l' + s.assetId}
            s={s}
            idx={i}
            group={!query && (i === 0 || items[i - 1].type !== s.type) ? GROUP_LABEL[s.type] : null}
            active={i === active}
            onHover={onHover}
            onPick={onPick}
          />
        ))}
      </div>
      <div className="in-mention-foot">
        <span>
          <span className="kbd">↑</span>
          <span className="kbd">↓</span> chọn
        </span>
        <span>
          <span className="kbd">Enter</span>/<span className="kbd">Tab</span> chèn
        </span>
        <span>
          <span className="kbd">Esc</span> đóng
        </span>
      </div>
    </div>,
    document.body,
  )
})

function MentionRow({
  s,
  idx,
  group,
  active,
  onHover,
  onPick,
}: {
  s: MediaSuggestion
  idx: number
  group: string | null
  active: boolean
  onHover: (i: number) => void
  onPick: (s: MediaSuggestion) => void
}) {
  return (
    <>
      {group && <div className="in-mention-group">{group}</div>}
      <button
        type="button"
        data-idx={idx}
        role="option"
        aria-selected={active}
        className={`in-mention-item is-${s.type} ${active ? 'active' : ''}`}
        onMouseEnter={() => onHover(idx)}
        onClick={() => onPick(s)}
      >
        {s.type === 'image' && (
          <>
            <MediaImg id={s.imageId} className="in-mention-thumb" />
            <span className="in-mention-text">
              <span className="in-mention-name">
                <span className="in-mention-tok">@image_{s.n}</span> · {s.name}
              </span>
              <span className="in-mention-tag">
                {KIND_LABEL[s.kind]}
                {s.imageTotal > 1 ? ` · ảnh ${s.imageIndex + 1}/${s.imageTotal}` : ''}
              </span>
            </span>
            <ImageIcon size={12} className="in-mention-kindicon" />
          </>
        )}
        {s.type === 'video' && (
          <>
            {s.posterId ? <MediaImg id={s.posterId} className="in-mention-thumb is-wide" /> : <span className="in-mention-thumb is-wide in-mention-nothumb"><Film size={12} /></span>}
            <span className="in-mention-text">
              <span className="in-mention-name">
                <span className="in-mention-tok">@video_{s.n}</span> · {s.label}
              </span>
              <span className="in-mention-tag">{s.status === 'completed' ? 'Video tham chiếu' : 'Video chưa sẵn sàng'}</span>
            </span>
            <Film size={12} className="in-mention-kindicon" />
          </>
        )}
        {s.type === 'link' && <LibraryRow s={s} />}
      </button>
    </>
  )
}

function LibraryRow({ s }: { s: Extract<MediaSuggestion, { type: 'link' }> }) {
  const asset = useProject((st) => st.project.assets.find((a) => a.id === s.assetId))
  return (
    <>
      {asset ? <AssetAvatar asset={asset} size={26} /> : <span className="in-mention-thumb" />}
      <span className="in-mention-text">
        <span className="in-mention-name">{s.name}</span>
        <span className="in-mention-tag">
          @{s.tag} · {KIND_LABEL[s.kind]}
        </span>
      </span>
      <span className="in-mention-link" title="Nối vào cảnh rồi chèn số @image_N">
        <Link2 size={11} /> Nối & chèn
      </span>
    </>
  )
}
