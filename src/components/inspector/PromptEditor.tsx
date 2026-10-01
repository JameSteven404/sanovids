// Scene prompt editor with @mentions.
// - The textarea is controlled by LOCAL state so typing in a 6k+ char prompt stays instant; the store is
//   updated through a short throttle (and immediately on blur / mention insert / Ctrl shortcuts).
// - `project.setScenePrompt` auto-links newly @mentioned assets → toast with "Hoàn tác".
// - Typing "@" opens a caret-anchored popup (mirror-div caret coordinates) with keyboard navigation.
import { AtSign, ChevronDown, Link2, Maximize2, Minimize2, Plus, Unlink, UserPlus, X } from 'lucide-react'
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
import { linkAssets } from '../../actions'
import { assetByTag, extractMentions, MENTION_RE, sceneCode } from '../../core/compile'
import { usesRefs } from '../../core/models'
import type { Asset, AssetKind } from '../../core/types'
import { useProject } from '../../store/project'
import { toast, useUI } from '../../store/ui'
import { AssetAvatar } from '../common/Media'
import { undoToastAction } from '../sidebar/shared'
import { caretCoordinates } from './caret'
import { findMention, insertion, rankAssets, sameToken, type MentionToken } from './mentions'
import { EMPTY_IDS, fmt, KIND_ICON, KIND_LABEL, KINDS, useDismiss, usePref } from './shared'

const COMMIT_MS = 160
const VALID_TAG = /^[\p{L}\p{N}_]+$/u
const FIELD_SIZING = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')

/** Flush functions of mounted editors, so toast actions can commit pending text first. */
const flushers = new Map<string, () => void>()

type Suggestion = { type: 'asset'; asset: Asset; linked: boolean } | { type: 'create'; tag: string }

/** Toast for auto-linked assets. "Hoàn tác" unlinks them and turns their @mentions into plain names
 *  (otherwise the next keystroke would link them again). */
function announceLinked(sceneId: string, linked: string[]) {
  const { project } = useProject.getState()
  const scene = project.scenes.find((s) => s.id === sceneId)
  const tags = linked.map((id) => project.assets.find((a) => a.id === id)).filter((a): a is Asset => !!a).map((a) => '@' + a.tag)
  if (!scene || !tags.length) return
  toast(`Đã tự nối ${tags.join(', ')} vào ${sceneCode(scene.order)}`, {
    tone: 'success',
    action: { label: 'Hoàn tác', run: () => undoAutoLink(sceneId, linked) },
  })
}

function undoAutoLink(sceneId: string, linked: string[]) {
  flushers.get(sceneId)?.()
  const st = useProject.getState()
  const scene = st.project.scenes.find((s) => s.id === sceneId)
  if (!scene) return
  const assets = linked.map((id) => st.project.assets.find((a) => a.id === id)).filter((a): a is Asset => !!a)
  const byTag = new Map(assets.map((a) => [a.tag.toLowerCase(), a]))
  const prompt = scene.prompt.replace(MENTION_RE, (whole, tag: string) => byTag.get(tag.toLowerCase())?.name ?? whole)
  st.updateScene(sceneId, { prompt, refs: scene.refs.filter((r) => !linked.includes(r)) })
  toast(`Đã bỏ nối ${assets.map((a) => '@' + a.tag).join(', ')} — giữ tên trong prompt.`, { action: undoToastAction() })
}

export function PromptEditor({ sceneId }: { sceneId: string }) {
  const storePrompt = useProject((s) => s.project.scenes.find((x) => x.id === sceneId)?.prompt ?? '')
  const refs = useProject((s) => s.project.scenes.find((x) => x.id === sceneId)?.refs) ?? EMPTY_IDS
  const sendsRefs = useProject((s) => {
    const sc = s.project.scenes.find((x) => x.id === sceneId)
    return sc ? usesRefs(sc.settings) : true
  })
  const assets = useProject((s) => s.project.assets)

  const [text, setText] = useState(storePrompt)
  const textRef = useRef(storePrompt)
  const committedRef = useRef(storePrompt)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const pendingSel = useRef<number | null>(null)
  const dismissedAt = useRef<number | null>(null)
  /** The @token currently being typed (mirrors `mention` state, readable from timers). */
  const mentionRef = useRef<MentionToken | null>(null)
  const [tall, setTall] = usePref('promptTall', false)

  // ---------- commit to the store ----------
  const commit = useCallback(
    (opts: { silent?: boolean; force?: boolean } = {}): string[] => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const next = textRef.current
      if (!opts.force && next === committedRef.current) return []
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
      // Hold the commit while an @token is still being typed, so "@Lumi…" on the way to "@Luminara"
      // is not auto-linked. Blur, picking, Esc or a space end the token and let it through.
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

  // ---------- external changes (undo, restore from take, import…) ----------
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
  }, [text])

  // ---------- mention popup ----------
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

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!mention) return []
    const list: Suggestion[] = rankAssets(assets, mention.query, refs).map((asset) => ({ type: 'asset', asset, linked: refs.includes(asset.id) }))
    const q = mention.query
    if (q && VALID_TAG.test(q) && !assetByTag(assets, q)) list.push({ type: 'create', tag: q })
    return list
  }, [mention, assets, refs])

  const insertTag = useCallback(
    (tag: string, opts: { createdId?: string } = {}) => {
      const ta = taRef.current
      const value = textRef.current
      const tok = (ta && findMention(value, ta.selectionStart)) || mentionRef.current
      if (!ta || !tok) return
      const { insert, next, caret } = insertion(value, tok, tag)
      setToken(null)
      // If the caret ends right after the tag (e.g. before "."), don't reopen the popup for it.
      dismissedAt.current = tok.start
      // Caret target is applied by the layout effect after the re-render (set first: the render may happen inside execCommand).
      pendingSel.current = caret
      ta.focus()
      ta.setSelectionRange(tok.start, tok.end)
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
      // Commit now: auto-link immediately instead of after the typing throttle.
      const linked = commit({ silent: !!opts.createdId })
      if (opts.createdId) {
        const { project } = useProject.getState()
        const scene = project.scenes.find((s) => s.id === sceneId)
        const asset = project.assets.find((a) => a.id === opts.createdId)
        if (asset && scene) {
          toast(`Đã tạo @${asset.tag} trong thư viện${linked.includes(asset.id) ? ` và nối vào ${sceneCode(scene.order)}` : ''}. Thêm ảnh để dùng làm tham chiếu.`, {
            tone: 'success',
            action: { label: 'Thêm ảnh', run: () => useUI.getState().openDialog({ kind: 'asset', assetId: asset.id }) },
          })
        }
      }
    },
    [commit, sceneId, setToken],
  )

  const pick = useCallback(
    (s: Suggestion) => {
      if (s.type === 'asset') insertTag(s.asset.tag)
      else {
        const id = useProject.getState().addAsset({ name: s.tag, tag: s.tag, kind: 'character' })
        const tag = useProject.getState().project.assets.find((a) => a.id === id)?.tag ?? s.tag
        insertTag(tag, { createdId: id })
      }
    },
    [insertTag],
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

  // ---------- derived (deferred so long prompts don't slow typing) ----------
  const deferredText = useDeferredValue(text)
  const charCount = useMemo(() => [...deferredText].length, [deferredText])
  const mentionedTags = useMemo(() => extractMentions(deferredText), [deferredText])
  const mentionedIds = useMemo(() => {
    const set = new Set<string>()
    for (const t of mentionedTags) {
      const a = assetByTag(assets, t)
      if (a) set.add(a.id)
    }
    return set
  }, [mentionedTags, assets])

  // "Bỏ nối @X?" — the last mention of a linked asset was removed. Never auto-unlink.
  const prevMentioned = useRef<Set<string> | null>(null)
  const [unlinkHints, setUnlinkHints] = useState<string[]>([])
  useEffect(() => {
    const prev = prevMentioned.current
    prevMentioned.current = mentionedIds
    setUnlinkHints((h) => {
      let next = h.filter((id) => refs.includes(id) && !mentionedIds.has(id))
      if (prev) for (const id of prev) if (!mentionedIds.has(id) && refs.includes(id) && !next.includes(id)) next = [...next, id]
      return next.length === h.length && next.every((x, i) => x === h[i]) ? h : next
    })
  }, [mentionedIds, refs])

  const activeQuery = mention?.query.toLowerCase() ?? null
  const unknownTags = useMemo(
    () => mentionedTags.filter((t) => !assetByTag(assets, t) && t.toLowerCase() !== activeQuery),
    [mentionedTags, assets, activeQuery],
  )
  // Mentioned (committed text) but not linked — e.g. over the model's image limit, or unlinked by hand.
  const notLinked = useMemo(() => {
    if (!sendsRefs) return []
    const out: Asset[] = []
    for (const t of extractMentions(storePrompt)) {
      const a = assetByTag(assets, t)
      if (a && !refs.includes(a.id)) out.push(a)
    }
    return out
  }, [storePrompt, assets, refs, sendsRefs])

  const relink = useCallback(() => {
    textRef.current = taRef.current?.value ?? textRef.current
    return commit({ force: true, silent: true })
  }, [commit])

  const onCreateUnknown = useCallback(
    (tag: string, kind: AssetKind) => {
      const id = useProject.getState().addAsset({ name: tag, tag, kind })
      const linked = relink()
      const { project } = useProject.getState()
      const scene = project.scenes.find((s) => s.id === sceneId)
      const asset = project.assets.find((a) => a.id === id)
      if (!asset) return
      toast(
        `Đã tạo ${KIND_LABEL[kind].toLowerCase()} @${asset.tag}${linked.includes(id) && scene ? ` và nối vào ${sceneCode(scene.order)}` : ''}.`,
        { tone: 'success', action: { label: 'Thêm ảnh', run: () => useUI.getState().openDialog({ kind: 'asset', assetId: id }) } },
      )
    },
    [relink, sceneId],
  )

  const onUnlink = useCallback(
    (assetId: string) => {
      const a = useProject.getState().project.assets.find((x) => x.id === assetId)
      useProject.getState().removeRef(sceneId, assetId)
      setUnlinkHints((h) => h.filter((x) => x !== assetId))
      if (a) toast(`Đã bỏ nối @${a.tag}.`, { action: undoToastAction() })
    },
    [sceneId],
  )
  const onDismissHint = useCallback((assetId: string) => setUnlinkHints((h) => h.filter((x) => x !== assetId)), [])
  const onLink = useCallback((assetId: string) => linkAssets([sceneId], [assetId]), [sceneId])

  return (
    <div className="in-pe">
      <div className="in-pe-wrap">
        <textarea
          ref={taRef}
          className={`textarea in-pe-ta ${tall ? 'is-tall' : ''} ${FIELD_SIZING ? 'auto-size' : ''}`}
          value={text}
          spellCheck={false}
          rows={8}
          placeholder={'Mô tả cảnh… Gõ @ để chèn nhân vật / bối cảnh từ thư viện.\nVí dụ: At dusk @Elara climbs the last rocky slope above @LangNui…'}
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
          onKeyDown={onKeyDown}
          onBlur={() => {
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
        <span className="in-pe-legend">
          <AtSign size={12} />
          Gõ <span className="kbd">@</span> để chèn nhân vật — tự nối vào cảnh
        </span>
        <span className="mono faint" title="Số ký tự của riêng prompt cảnh (chưa gồm khối prompt)">
          {fmt(charCount)} ký tự
        </span>
      </div>
      <MentionChips
        unknownTags={unknownTags}
        unlinkHints={unlinkHints}
        notLinked={notLinked}
        assets={assets}
        onCreate={onCreateUnknown}
        onUnlink={onUnlink}
        onDismissHint={onDismissHint}
        onLink={onLink}
      />
    </div>
  )
}

// ---------------- popup ----------------
const POP_W = 296
type PopPos = { left: number; top?: number; bottom?: number }

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
  items: Suggestion[]
  active: number
  onHover: (i: number) => void
  onPick: (s: Suggestion) => void
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
      const estH = Math.min(380, 64 + count * 38)
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
            Chèn <b>@{query}</b>…
          </span>
        ) : (
          <span>Chèn tham chiếu</span>
        )}
      </div>
      <div className="in-mention-list" ref={listRef}>
        {items.map((s, i) =>
          s.type === 'asset' ? (
            <MentionItem key={s.asset.id} s={s} idx={i} active={i === active} onHover={onHover} onPick={onPick} />
          ) : (
            <button
              type="button"
              key="__create"
              data-idx={i}
              role="option"
              aria-selected={i === active}
              className={`in-mention-item is-create ${i === active ? 'active' : ''}`}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(s)}
            >
              <span className="in-mention-plus">
                <UserPlus size={13} />
              </span>
              <span className="in-mention-text">
                <span className="in-mention-name">Tạo nhân vật @{s.tag}</span>
                <span className="in-mention-tag">Thêm vào thư viện, ảnh bổ sung sau</span>
              </span>
            </button>
          ),
        )}
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

function MentionItem({
  s,
  idx,
  active,
  onHover,
  onPick,
}: {
  s: Extract<Suggestion, { type: 'asset' }>
  idx: number
  active: boolean
  onHover: (i: number) => void
  onPick: (s: Suggestion) => void
}) {
  const Icon = KIND_ICON[s.asset.kind]
  return (
    <button
      type="button"
      data-idx={idx}
      role="option"
      aria-selected={active}
      className={`in-mention-item ${active ? 'active' : ''}`}
      onMouseEnter={() => onHover(idx)}
      onClick={() => onPick(s)}
    >
      <AssetAvatar asset={s.asset} size={26} />
      <span className="in-mention-text">
        <span className="in-mention-name">{s.asset.name}</span>
        <span className="in-mention-tag">@{s.asset.tag}</span>
      </span>
      {s.linked && (
        <span className="in-mention-linked" title="Đã nối vào cảnh">
          <Link2 size={11} />
        </span>
      )}
      <span className="in-mention-kind" title={KIND_LABEL[s.asset.kind]}>
        <Icon size={11} />
        {KIND_LABEL[s.asset.kind]}
      </span>
    </button>
  )
}

// ---------------- chips under the editor ----------------
const MentionChips = memo(function MentionChips({
  unknownTags,
  unlinkHints,
  notLinked,
  assets,
  onCreate,
  onUnlink,
  onDismissHint,
  onLink,
}: {
  unknownTags: string[]
  unlinkHints: string[]
  notLinked: Asset[]
  assets: Asset[]
  onCreate: (tag: string, kind: AssetKind) => void
  onUnlink: (assetId: string) => void
  onDismissHint: (assetId: string) => void
  onLink: (assetId: string) => void
}) {
  const hintAssets = unlinkHints.map((id) => assets.find((a) => a.id === id)).filter((a): a is Asset => !!a)
  if (!unknownTags.length && !hintAssets.length && !notLinked.length) return null
  return (
    <div className="in-pe-chips">
      {hintAssets.map((a) => (
        <span key={'u' + a.id} className="in-hint-chip is-unlink">
          <AssetAvatar asset={a} size={18} />
          <span>
            Bỏ nối <b>@{a.tag}</b>?
          </span>
          <button type="button" className="in-hint-btn" onClick={() => onUnlink(a.id)} title="Không còn nhắc trong prompt — bỏ khỏi tham chiếu của cảnh">
            <Unlink size={11} /> Bỏ nối
          </button>
          <button type="button" className="in-hint-x" onClick={() => onDismissHint(a.id)} aria-label="Giữ nối" title="Giữ nối">
            <X size={11} />
          </button>
        </span>
      ))}
      {notLinked.map((a) => (
        <span key={'n' + a.id} className="in-hint-chip is-notlinked" title={`@${a.tag} có trong prompt nhưng chưa được nối — sẽ được thay bằng tên "${a.name}"`}>
          <AssetAvatar asset={a} size={18} />
          <span>
            <b>@{a.tag}</b> chưa nối
          </span>
          <button type="button" className="in-hint-btn" onClick={() => onLink(a.id)}>
            <Link2 size={11} /> Nối
          </button>
        </span>
      ))}
      {unknownTags.map((t) => (
        <UnknownChip key={'x' + t} tag={t} onCreate={onCreate} />
      ))}
    </div>
  )
})

function UnknownChip({ tag, onCreate }: { tag: string; onCreate: (tag: string, kind: AssetKind) => void }) {
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  return (
    <span className="in-hint-chip is-unknown" title={`@${tag} không có trong thư viện — sẽ giữ nguyên chữ khi gửi`}>
      <span className="in-unknown-at">@{tag}</span>
      <button type="button" className="in-hint-btn" onClick={() => onCreate(tag, 'character')}>
        <Plus size={11} /> Tạo nhân vật @{tag}
      </button>
      <button ref={btnRef} type="button" className="in-hint-x" onClick={() => setMenu((m) => !m)} aria-label="Chọn loại" title="Tạo loại khác…">
        <ChevronDown size={11} />
      </button>
      {menu && <KindMenu menuRef={menuRef} ignoreRef={btnRef} onClose={() => setMenu(false)} onPick={(k) => onCreate(tag, k)} />}
    </span>
  )
}

function KindMenu({
  menuRef,
  ignoreRef,
  onClose,
  onPick,
}: {
  menuRef: RefObject<HTMLDivElement | null>
  ignoreRef: RefObject<HTMLElement | null>
  onClose: () => void
  onPick: (k: AssetKind) => void
}) {
  useDismiss(menuRef, onClose, ignoreRef)
  return (
    <div ref={menuRef} className="in-menu">
      {KINDS.map((k) => {
        const Icon = KIND_ICON[k]
        return (
          <button
            type="button"
            key={k}
            onClick={() => {
              onClose()
              onPick(k)
            }}
          >
            <Icon size={13} /> {KIND_LABEL[k]}
          </button>
        )
      })}
    </div>
  )
}
