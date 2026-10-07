// Take node viewing (plan "node video", XT): the timeline lives UNDER the picture, nothing is drawn over a finished
// take, the custom name / rename input sit in a title line above the card's top-left (the settings stay in the
// footer), "Phóng to" puts the node's stage (picture + bar) fullscreen with every key owned by the player, and the
// players share one key table (core/transportKeys). The DOM is not available in these tests: the structure is read
// from the sources, like topbarLayout.test.ts.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TAKE_BAR_H } from '../canvasModel'
import { TITLE_LINE_EDIT_H, TITLE_LINE_GAP, TITLE_LINE_H } from '../takeNodeModel'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const takeCss = read('../takeNode.css')
const canvasCss = read('../canvas.css')
const savingCss = read('../saving.css')
const takeNode = read('../TakeNode.tsx')
const takePlayer = read('../TakePlayer.tsx')
const viewer = read('../../runs/TakeViewer.tsx')
const film = read('../../player/FilmPlayer.tsx')
const transportHook = read('../../../hooks/useTransport.ts')

// ---- a tiny cascade: which declaration wins on an element (top-level rules, descendant-only selectors) ----
interface CssRule {
  selectors: string[]
  decls: Record<string, string>
  order: number
}
/** Split at a separator outside parentheses. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === sep && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean)
}
/** The top-level style rules in source order (@media / @container / @keyframes blocks are left out). */
function topLevelRules(css: string): CssRule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: CssRule[] = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{', i)
    if (open < 0) break
    const prelude = src.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    for (; j < src.length && depth; j++) depth += src[j] === '{' ? 1 : src[j] === '}' ? -1 : 0
    const body = src.slice(open + 1, j - 1)
    if (!prelude.startsWith('@')) {
      const decls: Record<string, string> = {}
      for (const d of splitTop(body, ';')) {
        const c = d.indexOf(':')
        if (c > 0) decls[d.slice(0, c).trim()] = d.slice(c + 1).trim().replace(/\s+/g, ' ')
      }
      rules.push({ selectors: splitTop(prelude, ','), decls, order: rules.length })
    }
    i = j
  }
  return rules
}
interface El {
  tag: string
  classes: string[]
  pseudo?: string[]
}
const COMPOUND = /^([a-z][\w-]*|\*)?((?:[.:][\w-]+)*)$/i
/** Specificity [ids, classes + pseudo-classes, types] of a descendant-only selector; null for any other selector. */
function specificity(sel: string): [number, number, number] | null {
  if (/[>~+[(]|::/.test(sel)) return null
  let cls = 0
  let types = 0
  for (const part of sel.split(/\s+/)) {
    const m = COMPOUND.exec(part)
    if (!m) return null
    if (m[1] && m[1] !== '*') types++
    cls += (m[2].match(/[.:]/g) ?? []).length
  }
  return [0, cls, types]
}
function compoundMatches(part: string, el: El): boolean {
  const m = COMPOUND.exec(part)
  if (!m) return false
  if (m[1] && m[1] !== '*' && m[1].toLowerCase() !== el.tag) return false
  for (const t of m[2].match(/[.:][\w-]+/g) ?? []) {
    if (t[0] === '.' && !el.classes.includes(t.slice(1))) return false
    if (t[0] === ':' && !(el.pseudo ?? []).includes(t.slice(1))) return false
  }
  return true
}
/** Does a descendant-only selector match the last element of `chain` (root → element)? */
function matches(sel: string, chain: El[]): boolean {
  if (!specificity(sel)) return false
  const parts = sel.split(/\s+/)
  if (!compoundMatches(parts[parts.length - 1], chain[chain.length - 1])) return false
  let at = chain.length - 1
  for (let k = parts.length - 2; k >= 0; k--) {
    let found = -1
    for (let a = at - 1; a >= 0; a--)
      if (compoundMatches(parts[k], chain[a])) {
        found = a
        break
      }
    if (found < 0) return false
    at = found
  }
  return true
}
/** The value of `prop` that wins on the last element of `chain` (highest specificity, then the later rule). */
function winning(rules: CssRule[], chain: El[], prop: string): string | undefined {
  let best: { spec: [number, number, number]; order: number; value: string } | null = null
  for (const r of rules) {
    if (!(prop in r.decls)) continue
    for (const sel of r.selectors) {
      if (!matches(sel, chain)) continue
      const spec = specificity(sel)!
      const cmp = best ? spec[0] - best.spec[0] || spec[1] - best.spec[1] || spec[2] - best.spec[2] || r.order - best.order : 1
      if (cmp >= 0) best = { spec, order: r.order, value: r.decls[prop] }
    }
  }
  return best?.value
}

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(?:^|\\n|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css)
  if (!m) throw new Error(`no rule ${selector}`)
  return m[1]
}
/** The JSX between the opening tag carrying `cls` and the matching close of that element (div / span). */
function element(src: string, cls: string): string {
  const start = src.indexOf(`className="${cls}"`) >= 0 ? src.indexOf(`className="${cls}"`) : src.indexOf(`className={\`${cls}`)
  if (start < 0) throw new Error(`no element ${cls}`)
  const open = src.lastIndexOf('<', start)
  const tag = /^<(\w+)/.exec(src.slice(open))![1]
  let depth = 0
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, 'g')
  re.lastIndex = open
  for (let m = re.exec(src); m; m = re.exec(src)) {
    depth += m[0].startsWith('</') ? -1 : 1
    if (depth === 0) return src.slice(open, m.index)
  }
  throw new Error(`unclosed ${cls}`)
}

describe('take card geometry (CSS)', () => {
  it('the player bar is TAKE_BAR_H tall, under the picture; footer 30px; big button 34 + 8', () => {
    expect(rule(takeCss, '.cv-take-pbar')).toContain(`height: ${TAKE_BAR_H}px;`)
    expect(rule(takeCss, '.cv-take-foot')).toContain('height: 30px;')
    expect(rule(takeCss, '.cv-take-main')).toContain('height: 34px;')
    expect(rule(takeCss, '.cv-take-main-wrap')).toContain('padding: 0 8px 8px;')
  })
  it('the controls sit inside the bar, not absolutely at the bottom of the poster over a fade', () => {
    const tp = rule(takeCss, '.cv-tp')
    expect(tp).toContain('inset: 0;')
    expect(tp).not.toMatch(/bottom:\s*0/)
    expect(tp).not.toContain('linear-gradient')
    // the time tip goes below the rail, never over the picture
    expect(rule(takeCss, '.cv-tp-tip')).toContain('top: 100%;')
  })
  it('the title line is 13px, 4px above the card, outside it', () => {
    const label = rule(takeCss, '.cv-take-label')
    expect(label).toContain(`height: ${TITLE_LINE_H}px;`)
    expect(label).toContain(`bottom: calc(100% + ${TITLE_LINE_GAP}px);`)
    expect(label).toContain('position: absolute;')
    expect(label).toContain('pointer-events: none;')
  })
  it('the whole frame shows (letterboxed), on the media background', () => {
    const media = rule(takeCss, '.cv-take-poster,\n.cv-take-video')
    expect(media).toContain('object-fit: contain;')
    expect(media).toContain('background: var(--media-bg);')
  })
  it('while playing, the dots and resize handles step back; nothing hides the provider over the picture any more', () => {
    expect(takeCss).toMatch(/\.cv-take\.is-playing \.react-flow__handle[^{]*\{\s*opacity: 0\.35;/)
    expect(takeCss).toContain('.cv-take.is-playing ~ .react-flow__resize-control.handle')
    expect(takeCss).not.toContain('.cv-take.is-playing .cv-take-provider')
    expect(takeCss).not.toContain('.cv-take-media:has(.cv-take-provider)')
  })
  it('fullscreen keeps the node’s place and shows picture + bar on the media background', () => {
    expect(rule(takeCss, '.cv-take.is-full::before')).toContain('height: var(--stage-h);')
    expect(rule(takeCss, '.cv-take-stage:fullscreen')).toContain('background: var(--media-bg);')
    expect(rule(takeCss, '.cv-take-stage:fullscreen .cv-take-pbar')).toContain('height: 56px;')
  })
  it('"Phóng to" on a RESIZED take still fills the screen with the picture (its media box never collapses to 0px)', () => {
    const rules = topLevelRules(takeCss)
    const card = (sized: boolean, full: boolean): El => ({
      tag: 'div',
      classes: ['cv-take', 'st-completed', 'is-playing', ...(sized ? ['is-sized'] : []), ...(full ? ['is-full'] : [])],
    })
    const stage = (full: boolean): El => ({
      tag: 'div',
      classes: ['cv-take-stage', ...(full ? ['is-full', 'nowheel', 'nodrag', 'nopan', 'nokey'] : [])],
      pseudo: full ? ['fullscreen'] : [],
    })
    const media: El = { tag: 'div', classes: ['cv-take-media'] }
    const chain = (sized: boolean, full: boolean) => [card(sized, full), stage(full), media]
    // While full, TakeNode drops the media box's inline size and every child of it is absolute: only flex-grow gives
    // it a height. A resized node's `flex: none` must not win here (it did: same specificity, later in the file).
    for (const sized of [false, true]) {
      const c = chain(sized, true)
      const what = sized ? 'resized' : 'default size'
      expect(winning(rules, c, 'flex'), what).toBe('1 1 auto')
      expect(winning(rules, c, 'min-height'), what).toBe('0')
      expect(winning(rules, c, 'aspect-ratio'), what).toBe('auto')
      expect(winning(rules, c, 'width'), what).toBe('100%')
      expect(winning(rules, [card(sized, true), stage(true)], 'display'), what).toBe('flex')
      expect(winning(rules, [card(sized, true), stage(true)], 'flex-direction'), what).toBe('column')
    }
    // outside fullscreen the cards keep their own layout (and the helper does see the resized rule)
    expect(winning(rules, chain(true, false), 'flex')).toBe('none')
    expect(winning(rules, chain(false, false), 'aspect-ratio')).toBe('16 / 9')
    expect(takeNode).toContain('style={media && !full ? { width: media.w, height: media.h } : undefined}')
  })
  it('the rename input stays short with its focus ring inside (an old 248px row leaves ~19px above the card)', () => {
    expect(rule(takeCss, '.cv-take-label.is-renaming')).toContain(`height: ${TITLE_LINE_EDIT_H}px;`)
    const input = rule(takeCss, '.cv-take-name-input')
    expect(input).toContain(`height: ${TITLE_LINE_EDIT_H}px;`)
    expect(input).not.toContain('var(--focus-ring)')
    const shadow = /box-shadow:\s*([^;]*);/.exec(input)?.[1].trim()
    if (shadow) expect(shadow === 'none' || shadow.startsWith('inset ')).toBe(true)
  })
  it('canvas.css / saving.css no longer carry take rules (one place: takeNode.css)', () => {
    // (.cv-take-line is the scene card's take row; `.cv-take.is-sized,` the resize rule shared by every node)
    expect(canvasCss).not.toMatch(/^\.cv-take(?!-line)(?!\.is-sized,\n)[\w-]*[\s.:,{]/m)
    expect(canvasCss).not.toMatch(/^\.cv-tp[\w-]*[\s.:,{]/m)
    expect(savingCss).not.toContain('.cv-take-settings.is-name')
    expect(savingCss).not.toContain('.cv-take-name-input {')
    // the spinner stays shared (folder node)
    expect(canvasCss).toContain('.cv-spin {')
  })
  it('every color is a token (theme-safe)', () => {
    const colors = takeCss.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? []
    expect(colors).toEqual([])
  })
})

describe('take node structure (TakeNode.tsx)', () => {
  it('nothing over the near picture: no star, provider, title line or rename input in the picture box', () => {
    const media = element(takeNode, 'cv-take-media')
    expect(media).not.toContain('cv-take-star')
    expect(media).not.toContain('cv-take-provider')
    expect(media).not.toContain('TakeTitle')
    expect(media).not.toContain('TakeNameInput')
    expect(media).not.toContain('cv-take-bar')
    // the code chip / "+N" on the poster only for the far card
    expect(media).toMatch(/\{far && <span className="cv-take-code">/)
    expect(media).toMatch(/\{far && hidden > 0 &&/)
  })
  it('the rename input lives in the title line, never in the footer; the footer always renders the settings', () => {
    const foot = element(takeNode, 'cv-take-foot')
    expect(foot).not.toContain('TakeNameInput')
    expect(foot).not.toContain('take.fileName ??')
    expect(foot).toMatch(/className="cv-take-settings"[\s\S]*?\{takeSettingsText\(take\)\}/)
    const title = takeNode.slice(takeNode.indexOf('const TakeTitle = memo('), takeNode.indexOf('function TakeNodeView('))
    expect(title).toContain('<TakeNameInput')
    expect(title).toContain('cv-take-label')
  })
  it('the <video> sits in the picture box, the controls in the bar under it (shared ref)', () => {
    const media = element(takeNode, 'cv-take-media')
    expect(media).toMatch(/<video ref=\{videoRef\}/)
    const stage = takeNode.slice(takeNode.indexOf('className={`cv-take-stage'), takeNode.indexOf('{box && <div className="cv-take-fill" />}'))
    expect(stage).toContain('className="cv-take-pbar"')
    expect(stage).toContain('<TakePlayer takeId={id} url={videoUrl} videoRef={videoRef} stageRef={stageRef}')
    expect(stage).toContain('<TakeBarRest')
    expect(takePlayer).not.toMatch(/<video\s[^>]*src=/)
  })
  it('the hover preview ignores the title line; RENAME_TAKE_EVENT opens the rename input', () => {
    expect(takeNode).toContain('onMouseOver={(e) => setHover(!(e.target as Element).closest?.(TITLE_LINE_SELECTOR))}')
    expect(takeNode).toMatch(/canvasEvents\.addEventListener\(RENAME_TAKE_EVENT/)
    expect(takeNode).toMatch(/canvasEvents\.removeEventListener\(RENAME_TAKE_EVENT/)
    expect(takeNode).toContain('takePendingRename(id)')
  })
  it('fullscreen drops the canvas gestures on the stage', () => {
    expect(takeNode).toContain("' is-full nowheel nodrag nopan nokey'")
  })
  it('the rename input only lets keymap typing chords reach the global shortcuts', () => {
    expect(takeNode).toContain('inlineKeyBubbles(e, (ev) => isTypingChord(ev.nativeEvent))')
    expect(takeNode).not.toContain('inlineEditKeyBubbles')
  })
})

describe('fullscreen player (TakePlayer.tsx)', () => {
  it('owns keydown, keyup and keypress in the capture phase while fullscreen, and removes them', () => {
    for (const t of ['keydown', 'keyup', 'keypress']) expect(takePlayer).toContain(`'${t}'`)
    expect(takePlayer).toContain('for (const t of types) window.addEventListener(t, onKey, true)')
    expect(takePlayer).toContain('for (const t of types) window.removeEventListener(t, onKey, true)')
    expect(takePlayer).toContain('e.stopImmediatePropagation()')
    expect(takePlayer).toContain('nodeFullKey(')
  })
  it('fullscreens the stage ref, exits on unmount, on a dialog, on a window blur / hidden page and on a dev sheet', () => {
    expect(takePlayer).toContain('stage.requestFullscreen(')
    expect(takePlayer).toContain('document.exitFullscreen()')
    expect(takePlayer).toMatch(/if \(full && blocked\) exitFull\(\)/)
    expect(takePlayer).toContain("window.addEventListener('blur', onBlur)")
    expect(takePlayer).toContain("document.addEventListener('visibilitychange', onVisible)")
    expect(takePlayer).toContain('useDevPrompts.subscribe(')
    expect(takePlayer).toContain('usePlayback.getState().setFullscreen(')
  })
  it('a refused / unsupported fullscreen opens the take viewer instead', () => {
    expect(takePlayer).toMatch(/requestFullscreen\(\{ navigationUI: 'hide' \}\)\.catch\(\(\) => openViewer\(takeId\)\)/)
  })
})

describe('one key table for every player', () => {
  it('the viewer, the node’s fullscreen player and "Phát liền" ask core/transportKeys', () => {
    expect(viewer).toMatch(/playerKey\(eventLike\(e\)/)
    expect(takePlayer).toMatch(/nodeFullKey\(eventLike\(native\)/)
    expect(film).toMatch(/transportKey\(eventLike\(e\), \{ player: 'film'/)
    // no player keeps its own arrow table any more
    expect(viewer).not.toMatch(/e\.key === 'ArrowLeft' && prev/)
    expect(film).not.toMatch(/e\.key === 'ArrowLeft'\) prev\(\)/)
  })
  it('nothing is drawn over the viewer’s picture: "★ Take đã chọn" is in its header', () => {
    expect(viewer).not.toContain('rq-stage-star')
    expect(viewer).toContain('<span className="rq-tv-star">★ Take đã chọn</span>')
  })
  it('the viewer’s Escape listener is added before Modal’s (layout effect), so Esc in fullscreen keeps the dialog', () => {
    expect(viewer).toContain('useLayoutEffect(() => {\n    const onKey = (e: KeyboardEvent) => keyRef.current(e)')
    expect(viewer).toContain('escapeDecision(')
  })
  it('End / → never seek to the very end of a looping video (it would restart at 0)', () => {
    expect(transportHook).toMatch(/leave\(\)\n\s*seekEdge\(v, where\)/)
    expect(transportHook).toMatch(/leave\(\)\n\s*stepFrames\(v, frames\)/)
    expect(takePlayer).toContain('v.currentTime = Math.min(f * d, lastFrameTime(d))')
  })
  it('the viewer tells a Tab into its <video controls> from a click on the picture (↑ / ↓ there = native volume)', () => {
    expect(viewer).toContain("if (e.key === 'Tab') tabbed.current = true")
    expect(viewer).toContain("window.addEventListener('pointerdown', onPointer, true)")
    expect(viewer).toContain("window.removeEventListener('pointerdown', onPointer, true)")
    expect(viewer).toContain('describeFocus(e.target instanceof Element ? e.target : null, { keyboard: tabbed.current })')
    expect(transportHook).toContain("const mediaControls = (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') && (el as HTMLMediaElement).controls")
  })
  it('shuttle speeds never reach the stored speed (ownsRate filter)', () => {
    expect(viewer).toContain('ownsRate(e.currentTarget.playbackRate)')
  })
  it('no beforeunload anywhere in the players (it cancels quitAndInstall)', () => {
    for (const src of [takeNode, takePlayer, viewer, film]) expect(src).not.toContain('beforeunload')
  })
})
