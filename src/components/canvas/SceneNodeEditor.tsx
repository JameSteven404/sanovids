// The live prompt field of a scene node (approved design E0 v3). Every node draws its prompt as STATIC text
// (PromptText: same box, insets, pre-wrap and token marks as this field); only the node in useSceneEditor.sceneId
// mounts this editor, so 100+ nodes stay cheap and the text never jumps when a click turns it into a field.
// - Local text state, committed to the store through a short throttle (and on blur, Esc, Ctrl shortcuts, structural
//   changes via lib/promptDrafts) — the same engine rules as the right panel's PromptEditor.
// - Tokens are coloured by the backdrop mirror behind the transparent textarea, through the shared helpers of
//   components/inspector/tokens.ts (segmentForScene: red placeholders, labels that do not fit, missing / unsent numbers,
//   retired @video text, each with its invalidTokenTitle) — never a token regex of its own.
// - "@" opens a caret-anchored list (linked images, library assets "Nối & chèn"); positions follow the canvas zoom.
// - Library cards / image tiles / image files dropped on the text: linked and their @image_N inserted where dropped,
//   in one undo step. Keys stay inside (Delete, Backspace, arrows, N / C / F never reach the canvas); Esc leaves the
//   field (the node stays selected), Ctrl+Enter runs this scene (the cost confirmation), Ctrl+S commits then saves.
// Class `nodrag nowheel nokey`: dragging selects text, the wheel scrolls the text, React Flow ignores the keys.
import { useStore } from '@xyflow/react'
import { AtSign, Image as ImageIcon, Link2 } from 'lucide-react'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { canvasEvents, createAssetsFromFiles, linkAssets, requestRun } from '../../actions'
import { assetByTag, sceneCode } from '../../core/compile'
import { MODELS } from '../../core/models'
import { groupAtOffset, placeholderGroups } from '../../core/placeholders'
import { fillPlaceholderAction } from '../../placeholderActions'
import type { Asset, Scene } from '../../core/types'
import { ASSETS_MIME, readIds } from '../../lib/dnd'
import { flushScenes, register as registerDraft } from '../../lib/promptDrafts'
import { canvasObstacles, oneUndoStep, undoToastAction, useProject } from '../../store/project'
import { markPromptFocused, promptFocusedSeqNow, useSceneEditor } from '../../store/sceneEditor'
import { toast } from '../../store/ui'
import { MediaImg, AssetAvatar } from '../common/Media'
import { caretCoordinates, offsetFromPoint } from '../inspector/caret'
import { findMention, popupPlacement, sameToken, type MentionToken } from '../inspector/mentions'
import {
  imageOptsFor,
  insertAt,
  invalidTokenTitle,
  planImageLinks,
  remapOffset,
  segmentForScene,
  snapToWordEnd,
  suggestionToken,
  suggestMedia,
  type LibraryOpt,
  type MediaSuggestion,
  type Seg,
} from '../inspector/tokens'
import { imageFiles, legacyTypingChord, sceneRowImageSpots, TYPE_EVENT } from './canvasModel'
import { caretFromExcerptHit, nodeEditorKeyBubbles } from './sceneEditorModel'
import '../inspector/inspector.css'

const COMMIT_MS = 160
/** Longest pause during which an "@Tag" still being typed holds the commit (a half-typed legacy tag would auto-link). */
const HOLD_MAX_MS = 1500
const isTagWord = (word: string) => !!assetByTag(useProject.getState().project.assets, word)

// ---------------------------------------------------------------------------------------------
/** Token marks of a prompt (static text and the field's backdrop): exactly the field's metrics, never bold or padded. */
export const PromptSegments = memo(function PromptSegments({ segs }: { segs: Seg[] }) {
  return (
    <>
      {segs.map((s, i) =>
        s.kind === 'text' ? (
          s.text
        ) : (
          <mark key={i} className={`in-tk is-${s.kind}${s.invalid ? ' is-invalid' : ''}`} title={s.invalid ? invalidTokenTitle(s) : undefined}>
            {s.text}
          </mark>
        ),
      )}
    </>
  )
})

/**
 * Text of the static prompt `el` from its start to the screen point (x, y), or null when the point is not on its text.
 * caretFromExcerptHit maps it to the prompt's offset. Hit-testing a `user-select: none` node (React Flow sets it on
 * every node) may refuse a text position: the static text accepts selection only for this one query.
 */
export function staticTextBefore(el: HTMLElement, x: number, y: number): string | null {
  const d = document as unknown as {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const style = el.style
  const prev = style.userSelect
  style.userSelect = 'text'
  try {
    let node: Node | null = null
    let offset = 0
    if (typeof d.caretPositionFromPoint === 'function') {
      const p = d.caretPositionFromPoint(x, y)
      if (p) ({ offsetNode: node, offset } = p)
    } else if (typeof d.caretRangeFromPoint === 'function') {
      const r = d.caretRangeFromPoint(x, y)
      if (r) {
        node = r.startContainer
        offset = r.startOffset
      }
    }
    if (!node || !el.contains(node)) return null
    const range = document.createRange()
    range.setStart(el, 0)
    range.setEnd(node, offset)
    return range.toString()
  } catch {
    return null
  } finally {
    style.userSelect = prev
  }
}

// ---------------------------------------------------------------------------------------------
interface LinkPlan {
  tokens: string[]
  refs: string[] | null
  done: string | null
}

/** Link `ids` to the scene (appended: existing numbers never move) and the @image_N to insert, reporting refusals. */
export function planNodeLinks(sceneId: string, ids: string[]): LinkPlan | null {
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
    refs: plan.linked.length ? plan.refs : null,
    done: plan.linked.length ? `Đã nối ${names.join(', ')} → ${sceneCode(scene.order)} (${tokens.join(' ')}). Ctrl+Z để bỏ nối.` : null,
  }
}

/**
 * Image files dropped on a scene node (choice 4A): tiles in the image column next to its row, and `link(ids)` (wire
 * them to the scene, insert their tags) in the SAME undo step — one "Hoàn tác" takes back tiles and link. The prompts
 * being typed in `flush` are committed first, as their own step. Returns the new ids.
 */
export async function filesToSceneTiles(sceneId: string, files: File[], link: (ids: string[]) => void, flush: readonly string[] = [sceneId]): Promise<string[]> {
  const images = files.filter((f) => /^image\//.test(f.type))
  if (!images.length) return createAssetsFromFiles(files)
  const project = useProject.getState().project
  const scene = project.scenes.find((s) => s.id === sceneId)
  const spots = scene ? sceneRowImageSpots(scene, images.length, project.scenes, canvasObstacles(project)) : undefined
  return createAssetsFromFiles(images, { spots, select: false, quiet: true, flush, inSameStep: link })
}

/**
 * Wire new tiles (image files dropped on a node) to the target scenes and say what happened; call it inside the tiles'
 * undo step (filesToSceneTiles), so "Hoàn tác" takes back both. Over the model's image limit the tiles stay on the
 * canvas unwired (the files are not lost) and the toast says so.
 */
export function linkNewTiles(sceneIds: string[], ids: string[]): void {
  const st = useProject.getState()
  const res = st.addRefs(sceneIds, ids)
  const scenes = st.project.scenes.filter((s) => sceneIds.includes(s.id))
  const where = scenes.length === 1 ? sceneCode(scenes[0].order) : `${res.scenes} cảnh`
  if (res.added) {
    toast(`Đã thêm ${ids.length} ô ảnh và nối vào ${where}${res.skipped ? ` (bỏ qua ${res.skipped} vì vượt giới hạn ảnh)` : ''}.`, { tone: 'success', action: undoToastAction() })
  } else {
    toast(`Đã thêm ${ids.length} ô ảnh lên canvas nhưng chưa nối được: vượt giới hạn ảnh của model.`, { tone: 'warning', action: undoToastAction() })
  }
}

/**
 * Choice 4A for library cards: the dropped images now linked to `targets` that have no tile on the canvas yet get one
 * in the image column next to the row of `sceneId` (an image already on the canvas only got its wire). Call it inside
 * the link's undo step. Returns the ids placed.
 */
export function placeLinkedTiles(sceneId: string, ids: readonly string[], targets: readonly string[] = [sceneId]): string[] {
  const project = useProject.getState().project
  const scene = project.scenes.find((s) => s.id === sceneId)
  if (!scene) return []
  const linked = new Set(project.scenes.filter((s) => targets.includes(s.id)).flatMap((s) => s.refs))
  const byId = new Map(project.assets.map((a) => [a.id, a]))
  const fresh = [...new Set(ids)].filter((id) => linked.has(id) && byId.has(id) && !byId.get(id)!.position)
  if (!fresh.length) return []
  const spots = sceneRowImageSpots(scene, fresh.length, project.scenes, canvasObstacles(project))
  useProject.getState().setAssetsOnCanvas(Object.fromEntries(fresh.map((id, i) => [id, spots[i]])))
  return fresh
}

/** Library cards / tiles dropped on a node (not on its text): linked to `targets`, cards without a tile get one — one undo step. */
export function linkCardsToNode(sceneId: string, targets: string[], ids: string[]): void {
  linkAssets(targets, ids, () => placeLinkedTiles(sceneId, ids, targets))
}

/**
 * One library card / image tile dropped on a node's "Chữ đỏ chờ ảnh" strip: it fills the group `groupKey` (the chip
 * it landed on; null = the strip's only group) through GT1's explicit fill path (placeholderActions
 * fillPlaceholderAction: linked when it was not, numbers kept, a refusal says why) — and a card with no tile on the
 * canvas gets one (4A) — in ONE undo step; the prompt being typed is committed first, as its own step. false = no
 * group to fill (several groups and no chip under the pointer): the caller links the picture like any drop.
 */
export function fillFromDrop(sceneId: string, groupKey: string | null, assetId: string): boolean {
  flushScenes([sceneId])
  const { project } = useProject.getState()
  const scene = project.scenes.find((s) => s.id === sceneId)
  if (!scene) return false
  const groups = placeholderGroups(scene.prompt, project.assets, scene.refs)
  const key = groupKey && groups.some((g) => g.key === groupKey) ? groupKey : groups.length === 1 ? groups[0].key : null
  if (!key) return false
  // The tile goes in the fill's own undo step, before its toast: that toast's "Hoàn tác" takes back both.
  fillPlaceholderAction(sceneId, key, assetId, () => placeLinkedTiles(sceneId, [assetId]))
  return true
}

/**
 * ONE library card / tile dropped right on red text (offset `at` strictly inside a placeholder or a label that does not
 * fit: core/placeholders groupAtOffset) fills that group like a drop on its chip (fillFromDrop). false = not on red
 * text, or several pictures: the caller inserts (never inside the red text: snapToWordEnd).
 */
export function fillAtOffset(sceneId: string, at: number, ids: readonly string[]): boolean {
  if (ids.length !== 1) return false
  const { project } = useProject.getState()
  const scene = project.scenes.find((s) => s.id === sceneId)
  const group = scene && groupAtOffset(scene.prompt, project.assets, scene.refs, at)
  return !!group && fillFromDrop(sceneId, group.key, ids[0])
}

/**
 * Library cards / tiles dropped on the STATIC prompt text of a node: link them and insert their @image_N where they
 * were dropped (`textBefore` = the static text up to the drop point: staticTextBefore) — the link, the tags and the
 * tiles of cards not on the canvas yet in ONE undo step. One card dropped on red text fills it instead (fillAtOffset).
 * false = the point is not on the text (the caller links only).
 */
export function insertLinksAtExcerpt(sceneId: string, textBefore: string | null, ids: string[]): boolean {
  const before = useProject.getState().project.scenes.find((s) => s.id === sceneId)
  const at0 = before ? caretFromExcerptHit(before.prompt, textBefore) : null
  if (at0 === null) return false
  flushScenes([sceneId])
  if (fillAtOffset(sceneId, at0, ids)) return true
  const plan = planNodeLinks(sceneId, ids)
  const cur = useProject.getState().project.scenes.find((s) => s.id === sceneId)
  if (!plan || !cur || !plan.tokens.length) return true
  const at = snapToWordEnd(cur.prompt, Math.min(at0, cur.prompt.length))
  const { next } = insertAt(cur.prompt, at, at, plan.tokens.join(' '))
  oneUndoStep(() => {
    useProject.getState().setPromptAndRefs(sceneId, next, plan.refs ?? cur.refs)
    placeLinkedTiles(sceneId, ids)
  })
  toast(plan.done ?? `Đã chèn ${plan.tokens.join(' ')} vào ${sceneCode(cur.order)}.`, { tone: 'success', action: undoToastAction() })
  return true
}

/**
 * Type in a scene's prompt on its node from anywhere (the right panel's "Gõ trên node", Enter on a far node): the
 * canvas first brings the node on screen and near (canvasModel typingViewport) — the field only exists there — then
 * the field opens with the caret at `caret` (null = the end).
 */
export function typeOnNode(sceneId: string, caret: number | null = null): void {
  canvasEvents.dispatchEvent(new CustomEvent(TYPE_EVENT, { detail: [sceneId] }))
  useSceneEditor.getState().open(sceneId, 'prompt', caret)
}

/**
 * The draft contract of a mounted node field: its commit is registered for structural changes (lib/promptDrafts), runs
 * when the window is hidden or closed (capture phase: before persist.ts writes the project on the same events), and
 * once more when the field goes away — unmounted by the far view, culling, or another node opening. Returns the disposer.
 */
export function bindNodeDraft(
  sceneId: string,
  commit: () => void,
  win: EventTarget = window,
  doc: EventTarget & { visibilityState: string } = document,
): () => void {
  const unregister = registerDraft(sceneId, commit)
  const onHidden = () => {
    if (doc.visibilityState === 'hidden') commit()
  }
  win.addEventListener('pagehide', commit, true)
  win.addEventListener('visibilitychange', onHidden, true)
  return () => {
    win.removeEventListener('pagehide', commit, true)
    win.removeEventListener('visibilitychange', onHidden, true)
    commit()
    unregister()
  }
}

// ---------------------------------------------------------------------------------------------
export interface NodePromptFieldProps {
  scene: Scene
  /** Inputs of the scene's compile (refs, frames, legacy tags): useProject(useShallow(sceneAssetsOf)). */
  assets: Asset[]
  /** Images the request really carries (compileScene: model limit, mode): tokens past them are shown invalid. */
  sentImages: number
  /** Placeholder of an empty prompt. */
  placeholder: string
}

export const NodePromptField = memo(function NodePromptField({ scene, assets, sentImages, placeholder }: NodePromptFieldProps) {
  const sceneId = scene.id
  const storePrompt = scene.prompt
  const focusReq = useSceneEditor((s) => (s.sceneId === sceneId ? s.focus : null))
  const caretReq = useSceneEditor((s) => (s.sceneId === sceneId ? s.caret : null))
  const seq = useSceneEditor((s) => s.seq)

  const [text, setText] = useState(storePrompt)
  const textRef = useRef(storePrompt)
  const committedRef = useRef(storePrompt)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const backRef = useRef<HTMLDivElement>(null)
  const pendingSel = useRef<number | null>(null)
  const lastSel = useRef<{ start: number; end: number } | null>(null)
  const dismissedAt = useRef<number | null>(null)
  const mentionRef = useRef<MentionToken | null>(null)
  const lastInputAt = useRef(0)

  // ---------- commit ----------
  const commit = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const next = textRef.current
    if (next === committedRef.current) return
    committedRef.current = next
    const linked = useProject.getState().setScenePrompt(sceneId, next)
    if (linked.length) {
      const project = useProject.getState().project
      const names = linked.map((id) => project.assets.find((a) => a.id === id)?.tag).filter(Boolean)
      toast(`Đã tự nối @${names.join(', @')} theo @Tên trong prompt.`, { tone: 'success', action: undoToastAction() })
    }
  }, [sceneId])

  /** The text together with newly linked refs: one store step, one undo. */
  const commitWithRefs = useCallback(
    (refs: string[]) => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const st = useProject.getState()
      const cur = st.project.scenes.find((s) => s.id === sceneId)
      if (!cur) return
      committedRef.current = textRef.current
      st.setPromptAndRefs(sceneId, textRef.current, refs)
    },
    [sceneId],
  )

  const schedule = useCallback(() => {
    lastInputAt.current = Date.now()
    if (timerRef.current !== null) return
    const tick = () => {
      timerRef.current = null
      const m = mentionRef.current
      if (m && Date.now() - lastInputAt.current < HOLD_MAX_MS && assetByTag(useProject.getState().project.assets, textRef.current.slice(m.start + 1, m.end))) {
        timerRef.current = setTimeout(tick, COMMIT_MS)
        return
      }
      commit()
    }
    timerRef.current = setTimeout(tick, COMMIT_MS)
  }, [commit])

  // Structural changes, closing the window / hiding the app (no blur) and unmounting commit the text (bindNodeDraft).
  useEffect(() => bindNodeDraft(sceneId, () => commit()), [sceneId, commit])

  // ---------- external changes (undo, renumbering…) ----------
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
    if (ta && document.activeElement === ta) pendingSel.current = remapOffset(prev, storePrompt, ta.selectionStart)
    const sel = lastSel.current
    if (sel) lastSel.current = { start: remapOffset(prev, storePrompt, sel.start), end: remapOffset(prev, storePrompt, sel.end) }
    setText(storePrompt)
  }, [storePrompt])

  /** Keep the backdrop's scroll offset on the field's. */
  const syncBackdrop = useCallback(() => {
    const ta = taRef.current
    const back = backRef.current
    if (ta && back) back.scrollTop = ta.scrollTop
  }, [])

  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    if (pendingSel.current !== null) {
      const c = Math.min(pendingSel.current, ta.value.length)
      pendingSel.current = null
      ta.setSelectionRange(c, c)
    }
    syncBackdrop()
  }, [text, syncBackdrop])

  // ---------- focus requests (click on the static text, Enter, double-click when zoomed out) ----------
  useLayoutEffect(() => {
    const ta = taRef.current
    // A remount (culled / zoomed out and back) must not pull the focus back: only a new request does (store/sceneEditor).
    if (!ta || focusReq !== 'prompt' || seq === promptFocusedSeqNow()) return
    markPromptFocused(seq)
    // preventScroll: focusing inside the canvas must never scroll React Flow's pane.
    ta.focus({ preventScroll: true })
    const c = caretReq ?? ta.value.length
    ta.setSelectionRange(c, c)
    lastSel.current = { start: c, end: c }
    syncBackdrop()
    // seq: the same request twice (Enter again) focuses again.
  }, [focusReq, caretReq, seq, syncBackdrop])

  // ---------- "@" list ----------
  const [mention, setMention] = useState<MentionToken | null>(null)
  const [active, setActive] = useState(0)
  const setToken = useCallback((m: MentionToken | null) => {
    const prev = mentionRef.current
    if (sameToken(prev, m)) return
    mentionRef.current = m
    if (!prev || !m || prev.query !== m.query) setActive(0)
    setMention(m)
  }, [])
  const updateMention = useCallback(
    (value: string, selStart: number, selEnd: number, typing: boolean) => {
      lastSel.current = { start: selStart, end: selEnd }
      const raw = selStart === selEnd ? findMention(value, selStart, isTagWord) : null
      if (!typing && raw && raw.start !== mentionRef.current?.start) {
        setToken(null)
        return
      }
      if (raw && raw.start === dismissedAt.current) {
        setToken(null)
        return
      }
      dismissedAt.current = null
      setToken(raw)
    },
    [setToken],
  )
  const imageOpts = useMemo(() => imageOptsFor(assets, scene.refs), [assets, scene.refs])
  const suggestions = useMemo<MediaSuggestion[]>(() => {
    if (!mention) return []
    // The library is read when the list is open (no subscription of every node editor to all assets).
    const library: LibraryOpt[] = useProject
      .getState()
      .project.assets.filter((a) => a.imageIds.length && !scene.refs.includes(a.id))
      .map((a) => ({ assetId: a.id, name: a.name, tag: a.tag, kind: a.kind }))
    return suggestMedia(mention.query, imageOpts, library)
  }, [mention, imageOpts, scene.refs])

  /** Replace text[start, end) with `token` through the native undo stack, then commit (with `refs` in one step). */
  const replaceRange = useCallback(
    (start: number, end: number, token: string, refs?: string[] | null) => {
      const ta = taRef.current
      const value = textRef.current
      if (!ta) return
      const { insert, next, caret, last } = insertAt(value, start, end, token)
      pendingSel.current = caret
      dismissedAt.current = last
      ta.focus({ preventScroll: true })
      ta.setSelectionRange(start, end)
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
      if (refs) commitWithRefs(refs)
      else commit()
    },
    [commit, commitWithRefs],
  )

  const pick = useCallback(
    (s: MediaSuggestion) => {
      const ta = taRef.current
      const tok = (ta && findMention(textRef.current, ta.selectionStart, isTagWord)) || mentionRef.current
      if (!tok) return
      setToken(null)
      dismissedAt.current = tok.start
      if (s.type === 'link') {
        const plan = planNodeLinks(sceneId, [s.assetId])
        const token = plan?.tokens[0]
        if (!plan || !token) return
        replaceRange(tok.start, tok.end, token, plan.refs)
        if (plan.done) toast(plan.done, { tone: 'success', action: undoToastAction() })
        return
      }
      const token = suggestionToken(s)
      if (token) replaceRange(tok.start, tok.end, token)
    },
    [replaceRange, sceneId, setToken],
  )

  // ---------- drops: library cards / image tiles (@image_N) and image files ----------
  const [drop, setDrop] = useState<{ left: number; top: number; height: number } | null>(null)
  /** Offset of the text under (x, y) (else the last selection's end), not snapped. */
  const pointOffset = useCallback((x: number, y: number): number => {
    const ta = taRef.current
    const value = textRef.current
    if (!ta) return value.length
    const at = offsetFromPoint(ta, backRef.current, x, y) ?? lastSel.current?.end ?? value.length
    return Math.min(at, value.length)
  }, [])
  const dropOffset = useCallback((x: number, y: number): number => snapToWordEnd(textRef.current, pointOffset(x, y)), [pointOffset])
  const accepts = (dt: DataTransfer) => Array.from(dt.types).some((t) => t === ASSETS_MIME || t === 'Files')
  const onDragOver = (e: ReactDragEvent<HTMLTextAreaElement>) => {
    if (!accepts(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = Array.from(e.dataTransfer.types).includes('Files') ? 'copy' : 'link'
    const ta = e.currentTarget
    const at = dropOffset(e.clientX, e.clientY)
    const c = caretCoordinates(ta, at)
    const top = c.top - ta.scrollTop
    setDrop(top + c.height > 0 && top < ta.offsetHeight ? { left: c.left - ta.scrollLeft, top, height: c.height } : null)
  }
  const onDrop = (e: ReactDragEvent<HTMLTextAreaElement>) => {
    if (!accepts(e.dataTransfer)) {
      setDrop(null)
      return // plain text: the browser inserts it (onChange follows)
    }
    e.preventDefault()
    e.stopPropagation()
    setDrop(null)
    const point = pointOffset(e.clientX, e.clientY)
    const at = snapToWordEnd(textRef.current, point)
    commit()
    // Link + insert the tags where dropped, and a tile for each card not on the canvas yet: one undo step.
    const insertLinks = (ids: string[]) => {
      const plan = planNodeLinks(sceneId, ids)
      if (!plan?.tokens.length) return
      const pos = Math.min(at, textRef.current.length)
      oneUndoStep(() => {
        replaceRange(pos, pos, plan.tokens.join(' '), plan.refs)
        placeLinkedTiles(sceneId, ids)
      })
      if (plan.done) toast(plan.done, { tone: 'success', action: undoToastAction() })
    }
    const ids = readIds(e.dataTransfer, ASSETS_MIME)
    if (ids.length) {
      // One card right on red text fills it (the strip's fill path); otherwise insert, never inside the red text.
      if (!fillAtOffset(sceneId, point, ids)) insertLinks(ids)
      return
    }
    const files = imageFiles(e.dataTransfer)
    if (files.length) {
      // New tiles + (still the field of this scene) link and insert where dropped, else link only (the field was
      // closed meanwhile) — all in the tiles' undo step.
      void filesToSceneTiles(sceneId, files, (created) => (taRef.current ? insertLinks(created) : linkNewTiles([sceneId], created)))
    }
  }

  // ---------- keys ----------
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const native = e.nativeEvent
    if (native.isComposing || native.keyCode === 229) {
      e.stopPropagation()
      return
    }
    if (mention && suggestions.length) {
      const n = suggestions.length
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault()
        e.stopPropagation()
        const s = suggestions[Math.min(active, n - 1)]
        if (s) pick(s)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        dismissedAt.current = mention.start
        setToken(null)
        return
      }
    }
    if (e.key === 'Escape') {
      // Leave the field: the text is committed, the node stays selected (Esc again clears the selection).
      e.preventDefault()
      e.stopPropagation()
      commit()
      taRef.current?.blur()
      useSceneEditor.getState().close()
      return
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === 'Enter') {
      // Ctrl+Enter = this node's Run button: one place only (useShortcuts skips handled events).
      e.preventDefault()
      e.stopPropagation()
      commit()
      requestRun([sceneId])
      return
    }
    // Global shortcuts that run while typing (Ctrl+S…) must see the latest text; every other key stays in here.
    if (e.ctrlKey || e.metaKey) commit()
    if (!nodeEditorKeyBubbles(native, legacyTypingChord)) e.stopPropagation()
  }

  // The shared highlighter (tokens.ts segmentForScene): the same red marks and titles as the static text and the panel.
  const segs = useMemo(
    () => segmentForScene(text, assets, scene.refs, { sentImages, legacyTags: legacyTagsOf(assets) }),
    [text, assets, scene.refs, sentImages],
  )

  return (
    <>
      <div ref={backRef} className="cv-sn-back" aria-hidden="true">
        <PromptSegments segs={segs} />
        {/* A trailing newline needs something after it to take up a line, like it does in the textarea. */}
        {'​'}
      </div>
      <textarea
        ref={taRef}
        className="cv-sn-ta nodrag nowheel nokey nopan"
        value={text}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={`Prompt cảnh ${sceneCode(scene.order)}`}
        aria-autocomplete="list"
        aria-haspopup="listbox"
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
        onDragLeave={() => setDrop(null)}
        onDrop={onDrop}
        // Clicks in the text place the caret / select text: never a node (de)selection by React Flow.
        onClick={(e) => e.stopPropagation()}
        onBlur={(e) => {
          lastSel.current = { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd }
          commit()
          setToken(null)
        }}
      />
      {drop && <span className="cv-sn-dropcaret" style={{ left: drop.left, top: drop.top, height: drop.height }} aria-hidden="true" />}
      {mention && suggestions.length > 0 && (
        <NodeMentionList taRef={taRef} anchor={mention.start} query={mention.query} items={suggestions} active={Math.min(active, suggestions.length - 1)} onHover={setActive} onPick={pick} />
      )}
    </>
  )
})

const legacyTagCache = new WeakMap<Asset[], ReadonlySet<string>>()
/** Lower-cased tags of the scene's compile inputs (legacy @Tag highlight), cached per array. */
export function legacyTagsOf(assets: Asset[]): ReadonlySet<string> {
  let set = legacyTagCache.get(assets)
  if (!set) legacyTagCache.set(assets, (set = new Set(assets.map((a) => a.tag.toLowerCase()))))
  return set
}

// ---------------------------------------------------------------------------------------------
const POP_W = 300
const GROUP: Record<MediaSuggestion['type'], string> = { image: 'Ảnh đã nối', link: 'Thư viện — nối & chèn' }

/** The "@" list, at screen size next to the caret; follows the canvas while it pans / zooms. */
function NodeMentionList({
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
  // Re-placed on every pan / zoom frame while open (only one list exists).
  const transform = useStore((s) => s.transform)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const count = items.length
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    const compute = () => {
      const c = caretCoordinates(ta, anchor)
      const r = ta.getBoundingClientRect()
      // The field is scaled by the canvas zoom: local caret px → screen px.
      const k = ta.offsetWidth ? r.width / ta.offsetWidth : 1
      const x = r.left + (c.left - ta.scrollLeft) * k
      const yTop = r.top + (c.top - ta.scrollTop) * k
      const left = Math.round(Math.max(8, Math.min(x - 12, window.innerWidth - POP_W - 8)))
      setPos({ left, ...popupPlacement(yTop, c.height * k, Math.min(400, 72 + count * 40), window.innerHeight) })
    }
    compute()
    window.addEventListener('resize', compute)
    return () => window.removeEventListener('resize', compute)
  }, [taRef, anchor, count, query, transform])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])
  if (!pos) return null
  return createPortal(
    <div
      className="in-mention cv-sn-mention"
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight, width: POP_W }}
      onMouseDown={(e) => e.preventDefault() /* keep the caret in the field */}
      role="listbox"
      aria-label="Ảnh tham chiếu để chèn vào prompt"
    >
      <div className="in-mention-head">
        <AtSign size={11} />
        {query ? (
          <span>
            Tìm <b>@{query}</b>…
          </span>
        ) : (
          <span>Chèn ảnh tham chiếu</span>
        )}
      </div>
      <div className="in-mention-list" ref={listRef}>
        {items.map((s, i) => (
          <MentionRow key={s.type === 'image' ? 'i' + s.n : 'l' + s.assetId} s={s} idx={i} group={!query && (i === 0 || items[i - 1].type !== s.type) ? GROUP[s.type] : null} active={i === active} onHover={onHover} onPick={onPick} />
        ))}
      </div>
      <div className="in-mention-foot">
        <span>
          <span className="kbd">↑</span>
          <span className="kbd">↓</span> chọn
        </span>
        <span>
          <span className="kbd">Enter</span> chèn
        </span>
        <span>
          <span className="kbd">Esc</span> đóng
        </span>
      </div>
    </div>,
    document.body,
  )
}

function MentionRow({ s, idx, group, active, onHover, onPick }: { s: MediaSuggestion; idx: number; group: string | null; active: boolean; onHover: (i: number) => void; onPick: (s: MediaSuggestion) => void }) {
  return (
    <>
      {group && <div className="in-mention-group">{group}</div>}
      <button type="button" data-idx={idx} role="option" aria-selected={active} className={`in-mention-item is-${s.type} ${active ? 'active' : ''}`} onMouseMove={() => !active && onHover(idx)} onClick={() => onPick(s)}>
        {s.type === 'image' && (
          <>
            <MediaImg id={s.imageId} className="in-mention-thumb" />
            <span className="in-mention-text">
              <span className="in-mention-name">
                <span className="in-mention-tok">@image_{s.n}</span> · {s.name}
              </span>
              {s.imageTotal > 1 && <span className="in-mention-tag">ảnh {s.imageIndex + 1}/{s.imageTotal}</span>}
            </span>
            <ImageIcon size={12} className="in-mention-kindicon" />
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
        <span className="in-mention-tag">@{s.tag}</span>
      </span>
      <span className="in-mention-link" title="Nối vào cảnh rồi chèn số @image_N">
        <Link2 size={11} /> Nối & chèn
      </span>
    </>
  )
}
