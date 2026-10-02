// Scene prompt editor. The prompt is sent exactly as written; media are referenced with numbered tokens
// @image_N (scene.refs order) and @video_N (scene.videoRefs order).
// - The textarea is controlled by LOCAL state so typing in a 6k+ char prompt stays instant; the store is
//   updated through a short throttle (and immediately on blur / token insert / Ctrl shortcuts).
// - Tokens are highlighted INSIDE the textarea: the textarea text is transparent and a backdrop mirror layer
//   (same font metrics, scroll synced) draws the colored text behind it.
// - Typing "@" opens a caret-anchored popup: linked images, linked videos, library assets ("Nối & chèn").
// - Legend under the textarea: one chip per image / video; click inserts, hover highlights occurrences.
// - Library cards / generated videos dropped on the textarea are linked to the scene and their @image_N /
//   @video_N tokens inserted where they were dropped (plain text drops keep the browser's behavior).
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
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { takeLabel } from '../../actions'
import { assetByTag, sceneCode } from '../../core/compile'
import { MODELS, usesRefs, usesVideoRefs } from '../../core/models'
import type { Asset } from '../../core/types'
import { ASSETS_MIME, readIds, TAKES_MIME } from '../../lib/dnd'
import { undoToastAction, useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { toast } from '../../store/ui'
import { AssetAvatar, MediaImg } from '../common/Media'
import { caretCoordinates, offsetFromPoint } from './caret'
import { useTakeInfos } from './hooks'
import { useImagePreview } from './ImagePreview'
import { findMention, popupPlacement, sameToken, type MentionToken } from './mentions'
import { EMPTY_IDS, fmt, KIND_LABEL, usePref } from './shared'
import {
  imageOptsFor,
  insertAt,
  legacyAssets,
  legacyFixMessage,
  mediaCountLabel,
  planImageLinks,
  planVideoLinks,
  remapOffset,
  renumberImageTokens,
  replaceLegacyTags,
  segmentPrompt,
  snapToWordEnd,
  suggestionToken,
  suggestMedia,
  type ImageOpt,
  type LibraryOpt,
  type MediaSuggestion,
  type Seg,
  type VideoOpt,
} from './tokens'

const COMMIT_MS = 160
/** Longest pause during which an "@Tag" still being typed holds the commit (see schedule()). */
const HOLD_MAX_MS = 1500
const FIELD_SIZING = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')

/** Flush functions of mounted editors, so other panels can commit pending text before changing refs. */
const flushers = new Map<string, () => void>()

/** A whole word after "@" that is a legacy asset @Tag: picking a suggestion there replaces all of it (findMention). */
const isTagWord = (word: string) => !!assetByTag(useProject.getState().project.assets, word)

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
  const refs = scene.refs.filter((r) => !linked.includes(r))
  let { text } = replaceLegacyTags(scene.prompt, byTag)
  // Dropping refs moves the numbers after them (a token inserted meanwhile, or "Đổi @Tên → @image_N"): renumber
  // like every other refs change, in the same undo step.
  if (st.project.settings.autoRenumber) text = renumberImageTokens(text, st.project.assets, scene.refs, refs, scene.videoRefs)
  st.restoreScene(sceneId, { prompt: text, refs, videoRefs: scene.videoRefs, settings: scene.settings })
  toast(`Đã bỏ nối ${assets.map((a) => '@' + a.tag).join(', ')} — giữ tên trong prompt.`, { action: undoToastAction() })
}

// ---------------- media drops ----------------
type MediaDrag = 'assets' | 'takes'
interface DropCaret {
  left: number
  top: number
  height: number
}

/** Library cards / generated videos being dragged. Anything else (plain text, files) keeps the default behavior. */
function mediaDragKind(dt: DataTransfer | null): MediaDrag | null {
  if (!dt) return null
  const types = Array.from(dt.types)
  return types.includes(ASSETS_MIME) ? 'assets' : types.includes(TAKES_MIME) ? 'takes' : null
}

/** A drop effect the drag source allows (an effect outside `effectAllowed` cancels the drop). */
function allowedEffect(dt: DataTransfer): DataTransfer['dropEffect'] {
  const a = dt.effectAllowed
  if (a === 'link' || a === 'linkMove') return 'link'
  if (a === 'move') return 'move'
  return 'copy'
}

/**
 * Media to link to the scene together with the tokens inserted in the prompt: applied with the prompt in ONE store
 * step (see commitWithMedia), so one undo — or the toast's "Hoàn tác" — removes both.
 */
interface MediaPlan {
  /** Tokens to insert, in drop / pick order. */
  tokens: string[]
  /** New refs / videoRefs of the scene, or null when nothing new is linked. */
  media: { refs?: string[]; videoRefs?: string[] } | null
  /** Success message once applied (null: nothing was linked). */
  done: string | null
}

/** Link library assets (drop, "Nối & chèn"): their @image_N tokens; reports the ones that cannot be linked. */
function planAssets(sceneId: string, ids: string[]): MediaPlan | null {
  const { project } = useProject.getState()
  const scene = project.scenes.find((s) => s.id === sceneId)
  if (!scene) return null
  const plan = planImageLinks(project.assets, scene.refs, ids, MODELS[scene.settings.model].maxRefImages)
  if (plan.noImage) toast(`Bỏ qua ${plan.noImage} mục chưa có ảnh nên chưa có số @image. Thêm ảnh cho chúng trước.`, { tone: 'warning' })
  if (plan.overLimit) toast(`Không nối được${ids.length > 1 ? ` ${plan.overLimit} mục` : ''}: vượt giới hạn ảnh của model.`, { tone: 'warning' })
  const tokens = [...plan.tokens.values()]
  const names = plan.linked.map((id) => project.assets.find((a) => a.id === id)?.name ?? '')
  return {
    tokens,
    media: plan.linked.length ? { refs: plan.refs } : null,
    done: plan.linked.length ? `Đã nối ${names.join(', ')} vào ${sceneCode(scene.order)} → ${tokens.join(' ')}.` : null,
  }
}

/** Link dropped takes as reference videos (only finished ones, never the scene's own): their @video_N tokens. */
function planTakes(sceneId: string, ids: string[]): MediaPlan | null {
  const scene = useProject.getState().project.scenes.find((s) => s.id === sceneId)
  if (!scene) return null
  const limit = usesVideoRefs(scene.settings) ? MODELS[scene.settings.model].maxRefVideos : 0
  const plan = planVideoLinks(sceneId, scene.videoRefs, ids, useRuns.getState().takes, limit)
  if (plan.notReady) toast('Video chưa tạo xong nên chưa dùng làm tham chiếu được.', { tone: 'warning' })
  if (plan.own) toast('Không thể dùng video của chính cảnh này làm tham chiếu cho nó.', { tone: 'warning' })
  if (plan.overLimit) toast('Không nối được: model/chế độ của cảnh không nhận thêm video tham chiếu.', { tone: 'warning' })
  return {
    tokens: plan.tokens,
    media: plan.linked.length ? { videoRefs: plan.videoRefs } : null,
    done: plan.linked.length ? `Đã nối ${plan.linked.map(takeLabel).join(', ')} làm video tham chiếu của ${sceneCode(scene.order)} → ${plan.tokens.join(' ')}.` : null,
  }
}

export function PromptEditor({ sceneId }: { sceneId: string }) {
  const storePrompt = useProject((s) => s.project.scenes.find((x) => x.id === sceneId)?.prompt ?? '')
  const refs = useProject((s) => s.project.scenes.find((x) => x.id === sceneId)?.refs) ?? EMPTY_IDS
  const videoRefs = useProject((s) => s.project.scenes.find((x) => x.id === sceneId)?.videoRefs) ?? EMPTY_IDS
  const assets = useProject((s) => s.project.assets)
  const settings = useProject((s) => s.project.scenes.find((x) => x.id === sceneId)?.settings)
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
  /** Commit the text together with newly linked media (MediaPlan.media): one store step, one undo. */
  const commitWithMedia = useCallback(
    (media: { refs?: string[]; videoRefs?: string[] }) => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const st = useProject.getState()
      const scene = st.project.scenes.find((s) => s.id === sceneId)
      if (!scene) return
      committedRef.current = textRef.current
      // New refs / videoRefs are appended, so the existing @image_N / @video_N numbers do not move.
      st.restoreScene(sceneId, {
        prompt: textRef.current,
        refs: media.refs ?? scene.refs,
        videoRefs: media.videoRefs ?? scene.videoRefs,
        settings: scene.settings,
      })
    },
    [sceneId],
  )
  /** Time of the last keystroke (onChange), for the commit hold below. */
  const lastInputAt = useRef(0)
  const schedule = useCallback(() => {
    lastInputAt.current = Date.now()
    if (timerRef.current !== null) return
    const tick = () => {
      timerRef.current = null
      // Hold the commit while the "@xxx" being typed is an asset tag (committing links it), so a half-typed legacy
      // "@Lumi…" is not auto-linked on the way to "@Lumina". Other words ("@image_1", "@foo") link nothing. Never
      // hold past a pause: the store (preview, scene card, autosave) must not wait for a blur.
      const m = mentionRef.current
      if (
        m &&
        Date.now() - lastInputAt.current < HOLD_MAX_MS &&
        assetByTag(useProject.getState().project.assets, textRef.current.slice(m.start + 1, m.end))
      ) {
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
    // Closing the window / app or hiding the tab does not blur the textarea: commit before the autosave flushes
    // (capture phase on window runs before persist.ts' own pagehide / visibilitychange listeners).
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush, true)
    window.addEventListener('visibilitychange', onHidden, true)
    return () => {
      window.removeEventListener('pagehide', flush, true)
      window.removeEventListener('visibilitychange', onHidden, true)
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
    // keep the caret roughly where it was
    if (ta && document.activeElement === ta) pendingSel.current = remapOffset(prev, storePrompt, ta.selectionStart)
    // …and the remembered one too (legend chips insert there while the textarea is blurred, e.g. after a ref was
    // removed from the list below and the prompt renumbered).
    const sel = lastSel.current
    if (sel) lastSel.current = { start: remapOffset(prev, storePrompt, sel.start), end: remapOffset(prev, storePrompt, sel.end) }
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
      const raw = selStart === selEnd ? findMention(value, selStart, isTagWord) : null
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

  /**
   * Replace text[start, end) with `token` (+ spacing) through the native undo stack, then commit — with `media`
   * (refs / videoRefs linked for these tokens) in the same store step.
   */
  const replaceRange = useCallback(
    (start: number, end: number, token: string, media?: MediaPlan['media']) => {
      const ta = taRef.current
      const value = textRef.current
      if (!ta) return
      const { insert, next, caret, last } = insertAt(value, start, end, token)
      // Caret target is applied by the layout effect after the re-render (set first: the render may happen inside execCommand).
      pendingSel.current = caret
      // Don't open the "@" popup for the inserted token when the caret ends right after it (inserted before a ".").
      dismissedAt.current = last
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
      if (media) commitWithMedia(media)
      else commit()
    },
    [commit, commitWithMedia],
  )

  const pick = useCallback(
    (s: MediaSuggestion) => {
      const ta = taRef.current
      const tok = (ta && findMention(textRef.current, ta.selectionStart, isTagWord)) || mentionRef.current
      if (!tok) return
      setToken(null)
      // Stay closed on this token even when linking fails below (replaceRange moves this to the inserted token).
      dismissedAt.current = tok.start
      if (s.type === 'link') {
        // Link + insert in one undo step; the toast's "Hoàn tác" undoes both.
        const plan = planAssets(sceneId, [s.assetId])
        const token = plan?.tokens[0]
        if (!plan || !token) return
        replaceRange(tok.start, tok.end, token, plan.media)
        toast(`Đã nối ${s.name} vào cảnh → ${token}.`, { tone: 'success', action: undoToastAction() })
        return
      }
      const token = suggestionToken(s)
      if (token) replaceRange(tok.start, tok.end, token)
    },
    [replaceRange, sceneId, setToken],
  )

  /** Legend chip: insert a token at the caret (or the last caret position), never inside a word. */
  const insertAtCaret = useCallback(
    (token: string) => {
      const ta = taRef.current
      if (!ta) return
      const value = textRef.current
      const len = value.length
      const focused = document.activeElement === ta
      const sel = focused ? { start: ta.selectionStart, end: ta.selectionEnd } : (lastSel.current ?? { start: len, end: len })
      const start = Math.min(sel.start, len)
      const end = Math.min(sel.end, len)
      if (start !== end) replaceRange(start, end, token)
      else {
        const at = snapToWordEnd(value, start)
        replaceRange(at, at, token)
      }
    },
    [replaceRange],
  )

  // ---------- drops: library cards (@image_N) and generated videos (@video_N) ----------
  const [drop, setDrop] = useState<{ kind: MediaDrag; caret: DropCaret | null } | null>(null)
  /** Last dragover point and the text offset it maps to (dragover fires continuously while still). */
  const dropPoint = useRef<{ x: number; y: number; at: number } | null>(null)

  /** Text offset where tokens dropped at (x, y) go: under the pointer, else the current / last selection. */
  const dropOffset = useCallback((x: number, y: number): number => {
    const ta = taRef.current
    const value = textRef.current
    if (!ta) return value.length
    const cached = dropPoint.current
    if (cached && cached.x === x && cached.y === y) return cached.at
    let at = offsetFromPoint(ta, backRef.current, x, y)
    if (at === null) {
      const sel = document.activeElement === ta ? { start: ta.selectionStart, end: ta.selectionEnd } : lastSel.current
      at = sel ? sel.end : value.length
    }
    at = snapToWordEnd(value, Math.min(at, value.length))
    dropPoint.current = { x, y, at }
    return at
  }, [])

  const endDrop = useCallback(() => {
    dropPoint.current = null
    setDrop(null)
  }, [])

  const onDragOver = (e: ReactDragEvent<HTMLTextAreaElement>) => {
    const kind = mediaDragKind(e.dataTransfer)
    if (!kind) return
    e.preventDefault()
    e.dataTransfer.dropEffect = allowedEffect(e.dataTransfer)
    const ta = e.currentTarget
    const prevAt = dropPoint.current?.at
    const at = dropOffset(e.clientX, e.clientY)
    if (drop?.kind === kind && drop.caret && prevAt === at) return
    // Draw our own insertion caret at the (word-snapped) drop position: browsers drop their native drag caret
    // once the page handles the drag.
    const c = caretCoordinates(ta, at)
    const top = c.top - ta.scrollTop
    const caret = top + c.height > 0 && top < ta.offsetHeight ? { left: c.left - ta.scrollLeft, top, height: c.height } : null
    setDrop({ kind, caret })
  }

  const onDrop = (e: ReactDragEvent<HTMLTextAreaElement>) => {
    const kind = mediaDragKind(e.dataTransfer)
    if (!kind) {
      endDrop()
      return // plain text: the browser inserts it (onChange follows)
    }
    e.preventDefault()
    const ids = readIds(e.dataTransfer, kind === 'assets' ? ASSETS_MIME : TAKES_MIME)
    const at = dropOffset(e.clientX, e.clientY)
    endDrop()
    if (!ids.length) return
    commit()
    // Appending refs / videoRefs never renumbers existing tokens, so `at` stays valid.
    const plan = kind === 'assets' ? planAssets(sceneId, ids) : planTakes(sceneId, ids)
    if (!plan?.tokens.length) return
    const pos = Math.min(at, textRef.current.length)
    // replaceRange keeps the "@" popup closed for the last token when the caret ends right after it. The new links
    // and the tokens are one undo step, so the toast's "Hoàn tác" removes both.
    replaceRange(pos, pos, plan.tokens.join(' '), plan.media)
    if (plan.done) toast(plan.done, { tone: 'success', action: undoToastAction() })
  }

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
    // Only while the popup is shown: otherwise Esc leaves the textarea (global shortcut) as usual.
    if (mention && suggestions.length > 0 && e.key === 'Escape') {
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
  // What the request really carries: a token past the model's limit (or in a mode without references) is shown
  // invalid, like a missing one — the model would never see that picture.
  const sentImages = settings && usesRefs(settings) ? Math.min(imageOpts.length, MODELS[settings.model].maxRefImages) : 0
  const sentVideos = settings && usesVideoRefs(settings) ? Math.min(videoRefs.length, MODELS[settings.model].maxRefVideos) : 0
  const segs = useMemo(
    () => segmentPrompt(text, imageOpts.length, videoRefs.length, legacyTags, { images: sentImages, videos: sentVideos }),
    [text, imageOpts.length, videoRefs.length, legacyTags, sentImages, sentVideos],
  )
  // Everything else may lag behind fast typing.
  const deferredText = useDeferredValue(text)
  const charCount = useMemo(() => [...deferredText].length, [deferredText])
  const legacy = useMemo(() => legacyAssets(deferredText, assets), [deferredText, assets])

  const fixLegacy = useCallback(() => {
    commit({ silent: true })
    const st = useProject.getState()
    const scene = st.project.scenes.find((s) => s.id === sceneId)
    if (!scene) return
    const legacy = legacyAssets(scene.prompt, st.project.assets)
    const plan = planImageLinks(st.project.assets, scene.refs, legacy.map((a) => a.id), MODELS[scene.settings.model].maxRefImages)
    const tokens = new Map<string, string>()
    for (const a of legacy) {
      const tok = plan.tokens.get(a.id)
      if (tok) tokens.set(a.tag.toLowerCase(), tok)
    }
    const { text: next, replaced } = replaceLegacyTags(scene.prompt, tokens)
    // Links + renamed mentions in one undo step (the toast's "Hoàn tác" undoes both).
    if (replaced) st.restoreScene(sceneId, { prompt: next, refs: plan.refs, videoRefs: scene.videoRefs, settings: scene.settings })
    else if (plan.overLimit) toast('Không nối được: vượt giới hạn ảnh của model.', { tone: 'warning' })
    const msg = legacyFixMessage(replaced, plan.noImage, plan.overLimit)
    if (msg) toast(msg.text, { tone: msg.tone, ...(replaced ? { action: undoToastAction() } : {}) })
  }, [commit, sceneId])

  return (
    <div className="in-pe">
      <div className={`in-pe-wrap ${drop ? `is-drop is-drop-${drop.kind}` : ''}`}>
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
          onDragEnter={onDragOver}
          onDragOver={onDragOver}
          onDragLeave={endDrop}
          onDrop={onDrop}
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
        {drop?.caret && <span className="in-pe-dropcaret" style={{ left: drop.caret.left, top: drop.caret.top, height: drop.caret.height }} aria-hidden="true" />}
        {drop && (
          <div className="in-pe-drophint" aria-hidden="true">
            {drop.kind === 'assets' ? (
              <>
                <ImageIcon size={12} /> Thả để nối & chèn <b>@image_N</b> tại đây
              </>
            ) : (
              <>
                <Film size={12} /> Thả để dùng làm <b>@video_N</b> tại đây
              </>
            )}
          </div>
        )}
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
          Gõ <span className="kbd">@</span> hoặc kéo nhân vật / video vào ô để chèn tham chiếu
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
  // Hovering an @image chip shows the whole picture (the chip's thumbnail is a tiny square crop).
  const preview = useImagePreview()
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
          onMouseDown={(e) => {
            keep(e)
            preview.hide()
          }}
          onClick={() => onInsert(`@image_${o.n}`)}
          onMouseEnter={(e) => {
            onHover({ kind: 'image', n: o.n })
            preview.show(e.currentTarget, o.imageId, `@image_${o.n} · ${o.name}${o.imageTotal > 1 ? ` (ảnh ${o.imageIndex + 1}/${o.imageTotal})` : ''}`)
          }}
          onMouseLeave={preview.hide}
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
      {preview.preview}
    </div>
  )
})

// ---------------- popup ----------------
const POP_W = 312
type PopPos = { left: number; top?: number; bottom?: number; maxHeight: number }

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
      const next: PopPos = { left, ...popupPlacement(yTop, c.height, estH, window.innerHeight) }
      setPos((p) =>
        p && p.left === next.left && p.top === next.top && p.bottom === next.bottom && p.maxHeight === next.maxHeight ? p : next,
      )
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

  // Hover follows real pointer moves only: arrow keys scroll rows under a resting pointer, which fires mouseenter
  // (and may fire a mousemove at the same point) on the row now under it — that must not steal the highlight.
  const lastPoint = useRef<{ x: number; y: number } | null>(null)
  const onListMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    const pt = lastPoint.current
    if (pt && pt.x === e.clientX && pt.y === e.clientY) return
    lastPoint.current = { x: e.clientX, y: e.clientY }
    const row = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-idx]') : null
    const idx = row ? Number(row.dataset.idx) : NaN
    if (Number.isInteger(idx) && idx !== active) onHover(idx)
  }

  if (!pos) return null
  return createPortal(
    <div
      ref={popRef}
      className="in-mention"
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight, width: POP_W }}
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
      <div className="in-mention-list" ref={listRef} onMouseMove={onListMove}>
        {items.map((s, i) => (
          <MentionRow
            key={s.type === 'image' ? 'i' + s.n : s.type === 'video' ? 'v' + s.n : 'l' + s.assetId}
            s={s}
            idx={i}
            group={!query && (i === 0 || items[i - 1].type !== s.type) ? GROUP_LABEL[s.type] : null}
            active={i === active}
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
  onPick,
}: {
  s: MediaSuggestion
  idx: number
  group: string | null
  active: boolean
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
