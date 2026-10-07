// Take node viewing (plan "node video", XT): the timeline lives UNDER the picture, nothing is drawn over a finished
// take, the custom name / rename input sit in a title line above the card's top-left (the settings stay in the
// footer), "Phóng to" puts the node's stage (picture + bar) fullscreen with every key owned by the player, and the
// players share one key table (core/transportKeys). The DOM is not available in these tests: the structure is read
// from the sources, like topbarLayout.test.ts.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TAKE_BAR_H } from '../canvasModel'
import { TITLE_LINE_GAP, TITLE_LINE_H } from '../takeNodeModel'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const takeCss = read('../takeNode.css')
const canvasCss = read('../canvas.css')
const savingCss = read('../saving.css')
const takeNode = read('../TakeNode.tsx')
const takePlayer = read('../TakePlayer.tsx')
const viewer = read('../../runs/TakeViewer.tsx')
const film = read('../../player/FilmPlayer.tsx')

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
  it('shuttle speeds never reach the stored speed (ownsRate filter)', () => {
    expect(viewer).toContain('ownsRate(e.currentTarget.playbackRate)')
  })
  it('no beforeunload anywhere in the players (it cancels quitAndInstall)', () => {
    for (const src of [takeNode, takePlayer, viewer, film]) expect(src).not.toContain('beforeunload')
  })
})
