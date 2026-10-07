import { describe, expect, it } from 'vitest'
import { snapRate } from '../../lib/playback'
import type { KeyEventLike } from '../keymap'
import {
  defaultDownloadChords,
  ESC_AFTER_EXIT_MS,
  escapeDecision,
  focusKind,
  FRAME_S,
  frameDelta,
  frameTarget,
  nextShuttle,
  nodeFullKey,
  playerKey,
  reverseStep,
  SHUTTLE_IDLE,
  shuttleOwnsRate,
  TRANSPORT_SUPPORT,
  transportKey,
  type Player,
  type Shuttle,
  type TransportOp,
} from '../transportKeys'

/** A key event as the browser sends it (code + key, modifiers). */
function k(code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  const key =
    code === 'Space'
      ? ' '
      : /^Key[A-Z]$/.test(code)
        ? code.slice(3).toLowerCase()
        : code === 'Backquote'
          ? '`'
          : code
  return { code, key, ...mods }
}
const at = (player: Player, e: KeyEventLike, mac = false) => transportKey(e, { player, mac })

describe('transport key table (one table for every player)', () => {
  it('maps the KP §3.5.1 table per player', () => {
    const table: [KeyEventLike, Partial<Record<Player, TransportOp | null>>][] = [
      [k('Space'), { viewer: 'toggle', 'node-full': 'toggle', film: 'toggle', canvas: null }],
      [k('KeyK'), { viewer: 'stop', 'node-full': 'stop', film: 'stop', canvas: 'stop' }],
      [k('KeyL'), { viewer: 'forward', 'node-full': 'forward', film: 'forward', canvas: 'forward' }],
      [k('KeyJ'), { viewer: 'reverse', 'node-full': 'reverse', film: 'reverse', canvas: 'reverse' }],
      [k('ArrowLeft'), { viewer: 'frame-back', 'node-full': 'frame-back', film: 'frame-back', canvas: null }],
      [k('ArrowRight'), { viewer: 'frame-fwd', 'node-full': 'frame-fwd', film: 'frame-fwd', canvas: null }],
      [k('ArrowLeft', { shiftKey: true }), { viewer: 'frame-back5', 'node-full': 'frame-back5', film: 'frame-back5', canvas: null }],
      [k('ArrowRight', { shiftKey: true }), { viewer: 'frame-fwd5', 'node-full': 'frame-fwd5', film: 'frame-fwd5', canvas: null }],
      [k('ArrowUp'), { viewer: 'clip-prev', 'node-full': 'volume-up', film: 'clip-prev', canvas: 'clip-prev' }],
      [k('ArrowDown'), { viewer: 'clip-next', 'node-full': 'volume-down', film: 'clip-next', canvas: 'clip-next' }],
      [k('Home'), { viewer: 'start', 'node-full': 'start', film: 'start', canvas: 'start' }],
      [k('End'), { viewer: 'end', 'node-full': 'end', film: 'end', canvas: 'end' }],
      [k('Backquote', { ctrlKey: true }), { viewer: 'fullscreen', 'node-full': 'fullscreen', film: 'fullscreen', canvas: null }],
      [k('Backquote'), { viewer: 'fullscreen', 'node-full': 'fullscreen', film: 'fullscreen', canvas: null }],
      [k('KeyF'), { viewer: null, 'node-full': 'exit', film: null, canvas: null }],
      [k('Escape'), { viewer: 'exit', 'node-full': 'exit', film: 'exit', canvas: null }],
      [k('KeyM'), { viewer: 'star', 'node-full': 'star', film: null, canvas: null }],
      [k('KeyM', { ctrlKey: true }), { viewer: 'download', 'node-full': null, film: null, canvas: null }],
    ]
    for (const [e, want] of table)
      for (const [player, op] of Object.entries(want) as [Player, TransportOp | null][]) expect(at(player, e), `${e.code} ${JSON.stringify(e)} @${player}`).toBe(op)
  })

  it('matches modifiers exactly (Shift+J is not J; Ctrl / Alt combinations are not transport keys)', () => {
    for (const player of ['viewer', 'node-full', 'film'] as Player[]) {
      expect(at(player, k('KeyJ', { shiftKey: true }))).toBeNull()
      expect(at(player, k('KeyL', { ctrlKey: true }))).toBeNull()
      expect(at(player, k('KeyK', { altKey: true }))).toBeNull()
      expect(at(player, k('Space', { shiftKey: true }))).toBeNull()
      expect(at(player, k('ArrowLeft', { ctrlKey: true }))).toBeNull()
      expect(at(player, k('ArrowUp', { shiftKey: true }))).toBeNull()
      expect(at(player, k('Escape', { shiftKey: true }))).toBeNull()
      // the Windows key never makes a chord
      expect(at(player, k('KeyL', { metaKey: true }))).toBeNull()
    }
  })

  it('never acts on a key an input method is composing, a dead key or a rewritten letter', () => {
    expect(at('viewer', { ...k('KeyJ'), isComposing: true })).toBeNull()
    expect(at('viewer', { ...k('KeyJ'), keyCode: 229 })).toBeNull()
    expect(at('viewer', { code: 'Backquote', key: 'Dead' })).toBeNull()
    expect(at('viewer', { code: 'KeyJ', key: 'ĵ' })).toBeNull()
  })

  it('Mac: ` alone toggles fullscreen (⌘` is macOS’ “next window”; ⌃ never makes a chord); ★ M; download ⌘E', () => {
    expect(at('viewer', k('Backquote'), true)).toBe('fullscreen')
    expect(at('viewer', k('Backquote', { metaKey: true }), true)).toBeNull()
    expect(at('viewer', k('Backquote', { ctrlKey: true }), true)).toBeNull()
    expect(at('viewer', k('KeyM'), true)).toBe('star')
    expect(at('viewer', k('KeyE', { metaKey: true }), true)).toBe('download')
    expect(at('viewer', k('KeyM', { metaKey: true }), true)).toBeNull()
    expect(defaultDownloadChords(true)).toEqual(['Ctrl+KeyE'])
    expect(defaultDownloadChords(false)).toEqual(['Ctrl+KeyM'])
  })

  it('★ / download follow the chords given by the keymap (take.star / take.download once they exist)', () => {
    const ctx = { player: 'viewer' as const, mac: false, starChords: ['Shift+KeyS'], downloadChords: ['Ctrl+KeyD'] }
    expect(transportKey(k('KeyS', { shiftKey: true }), ctx)).toBe('star')
    expect(transportKey(k('KeyM'), ctx)).toBeNull()
    expect(transportKey(k('KeyD', { ctrlKey: true }), ctx)).toBe('download')
    // the table wins over a registry chord that collides with it
    expect(transportKey(k('KeyK'), { ...ctx, starChords: ['KeyK'] })).toBe('stop')
  })

  it('TRANSPORT_SUPPORT lists what each player must implement', () => {
    expect(TRANSPORT_SUPPORT.viewer).toEqual(expect.arrayContaining(['toggle', 'stop', 'forward', 'reverse', 'frame-back', 'clip-prev', 'fullscreen', 'exit', 'star', 'download']))
    expect(TRANSPORT_SUPPORT['node-full']).toEqual(expect.arrayContaining(['volume-up', 'volume-down', 'exit', 'star']))
    expect(TRANSPORT_SUPPORT['node-full']).not.toContain('clip-prev')
    expect(TRANSPORT_SUPPORT['node-full']).not.toContain('download')
    expect(TRANSPORT_SUPPORT.film).not.toContain('star')
    expect(TRANSPORT_SUPPORT.film).not.toContain('download')
    expect(TRANSPORT_SUPPORT.canvas).toEqual(['stop', 'forward', 'reverse', 'clip-prev', 'clip-next', 'start', 'end'])
  })
})

describe('J / K / L shuttle', () => {
  it('L / J start at 1×, double up to 4×, the other direction starts over, K and Space leave it', () => {
    let s: Shuttle = SHUTTLE_IDLE
    s = nextShuttle(s, 'forward')
    expect(s).toEqual({ dir: 1, rate: 1 })
    s = nextShuttle(s, 'forward')
    expect(s).toEqual({ dir: 1, rate: 2 })
    s = nextShuttle(s, 'forward')
    expect(s).toEqual({ dir: 1, rate: 4 })
    s = nextShuttle(s, 'forward')
    expect(s).toEqual({ dir: 1, rate: 4 })
    s = nextShuttle(s, 'reverse')
    expect(s).toEqual({ dir: -1, rate: 1 })
    s = nextShuttle(s, 'reverse')
    expect(s).toEqual({ dir: -1, rate: 2 })
    expect(nextShuttle(s, 'stop')).toEqual(SHUTTLE_IDLE)
    expect(nextShuttle(s, 'toggle')).toEqual(SHUTTLE_IDLE)
  })

  it('after L, L, K the stored speed is untouched: the shuttle rates are never taken for the user’s', () => {
    const userRate = 1.25
    let stored = userRate
    // a player's 'ratechange' handler: skip the shuttle's own rate, else store the snapped rate if it differs
    const onRateChange = (s: Shuttle, elementRate: number) => {
      if (shuttleOwnsRate(s, elementRate)) return
      if (stored !== snapRate(elementRate)) stored = snapRate(elementRate)
    }
    let s = nextShuttle(SHUTTLE_IDLE, 'forward') // L: element at 1×
    onRateChange(s, 1)
    s = nextShuttle(s, 'forward') // L: element at 2×
    onRateChange(s, 2)
    s = nextShuttle(s, 'stop') // K: the user's speed is back on the element before any late event is handled
    onRateChange(s, userRate)
    onRateChange(s, userRate)
    expect(stored).toBe(userRate)
    // 4× is never stored either (setRate would clamp it to 2×)
    expect(shuttleOwnsRate({ dir: 1, rate: 4 }, 4)).toBe(true)
    // backwards: the element keeps the user's rate, nothing to skip
    expect(shuttleOwnsRate({ dir: -1, rate: 2 }, 2)).toBe(false)
  })

  it('backwards moves the picture by hand and stops at 0; big frame gaps are capped', () => {
    expect(reverseStep(2, 1, 500)).toEqual({ time: 1.75, done: false })
    expect(reverseStep(2, 4, 100)).toEqual({ time: 1.6, done: false })
    expect(reverseStep(0.05, 2, 100)).toEqual({ time: 0, done: true })
    expect(reverseStep(1, 1, Number.NaN)).toEqual({ time: 1, done: false })
  })
})

describe('frames', () => {
  it('one frame is 1/24 s; Shift moves 5; inside the clip', () => {
    expect(frameDelta('frame-back')).toBe(-1)
    expect(frameDelta('frame-fwd5')).toBe(5)
    expect(frameDelta('toggle')).toBe(0)
    expect(frameTarget(1, 1, 5)).toBeCloseTo(1 + FRAME_S, 9)
    expect(frameTarget(1, -5, 5)).toBeCloseTo(1 - 5 * FRAME_S, 9)
    expect(frameTarget(0.01, -1, 5)).toBe(0)
    expect(frameTarget(4.99, 5, 5)).toBe(5)
    // unknown length: only 0 bounds it
    expect(frameTarget(3, 24, 0)).toBeCloseTo(4, 9)
    expect(frameTarget(Number.NaN, 1, 5)).toBeCloseTo(FRAME_S, 9)
  })
})

describe('Escape and fullscreen', () => {
  it('leaves fullscreen first; the Escape that just ended it never closes the dialog too', () => {
    expect(escapeDecision({ fullscreen: true, exitedAt: -Infinity, now: 1000 })).toBe('exit-fullscreen')
    expect(escapeDecision({ fullscreen: false, exitedAt: 1000, now: 1100 })).toBe('swallow')
    expect(escapeDecision({ fullscreen: false, exitedAt: 1000, now: 1000 + ESC_AFTER_EXIT_MS + 150 })).toBe('normal')
    expect(escapeDecision({ fullscreen: false, exitedAt: -Infinity, now: 5 })).toBe('normal')
  })
})

describe('what the focused element keeps', () => {
  it('classifies the focused element', () => {
    expect(focusKind(null)).toBe('none')
    expect(focusKind({ tag: 'DIV' })).toBe('none')
    expect(focusKind({ tag: 'INPUT', type: 'text' })).toBe('typing')
    expect(focusKind({ tag: 'INPUT' })).toBe('typing')
    expect(focusKind({ tag: 'TEXTAREA' })).toBe('typing')
    expect(focusKind({ tag: 'DIV', editable: true })).toBe('typing')
    expect(focusKind({ tag: 'INPUT', type: 'range' })).toBe('slider')
    expect(focusKind({ tag: 'DIV', role: 'slider' })).toBe('slider')
    expect(focusKind({ tag: 'SPAN', role: 'slider', focusVisible: true })).toBe('slider')
    expect(focusKind({ tag: 'BUTTON', focusVisible: true })).toBe('control-key')
    expect(focusKind({ tag: 'BUTTON' })).toBe('control-mouse')
    expect(focusKind({ tag: 'INPUT', type: 'checkbox' })).toBe('control-mouse')
    expect(focusKind({ tag: 'VIDEO' })).toBe('none')
  })

  it('viewer / film: typing keeps every key, a slider its arrows, a Tab-focused control its Space / Enter', () => {
    const ctx = { player: 'viewer' as const, mac: false }
    expect(playerKey(k('Space'), 'typing', ctx)).toBeNull()
    expect(playerKey(k('KeyJ'), 'typing', ctx)).toBeNull()
    expect(playerKey(k('ArrowLeft'), 'slider', ctx)).toBeNull()
    expect(playerKey(k('Home'), 'slider', ctx)).toBeNull()
    expect(playerKey(k('Space'), 'slider', ctx)).toBe('toggle')
    expect(playerKey(k('Space'), 'control-key', ctx)).toBeNull()
    expect(playerKey(k('Enter'), 'control-key', ctx)).toBeNull()
    expect(playerKey(k('KeyL'), 'control-key', ctx)).toBe('forward')
    // "Xoá take" clicked once with the mouse, then Space: play / pause — never a second click on the button
    expect(playerKey(k('Space'), 'control-mouse', ctx)).toBe('toggle')
    expect(playerKey(k('ArrowRight'), 'none', ctx)).toBe('frame-fwd')
  })

  it('node fullscreen: Tab cycles, a slider keeps its keys, Enter presses, transport keys run, the rest is swallowed', () => {
    const ctx = { mac: false }
    expect(nodeFullKey(k('Tab'), 'none', ctx)).toEqual({ kind: 'tab' })
    expect(nodeFullKey(k('Tab', { shiftKey: true }), 'control-key', ctx)).toEqual({ kind: 'tab' })
    expect(nodeFullKey(k('ArrowLeft'), 'slider', ctx)).toEqual({ kind: 'slider' })
    expect(nodeFullKey(k('ArrowUp', { shiftKey: true }), 'slider', ctx)).toEqual({ kind: 'slider' })
    expect(nodeFullKey(k('ArrowLeft'), 'none', ctx)).toEqual({ kind: 'op', op: 'frame-back' })
    expect(nodeFullKey(k('ArrowUp'), 'control-mouse', ctx)).toEqual({ kind: 'op', op: 'volume-up' })
    expect(nodeFullKey(k('Enter'), 'control-key', ctx)).toEqual({ kind: 'default' })
    expect(nodeFullKey(k('Enter'), 'none', ctx)).toEqual({ kind: 'block' })
    expect(nodeFullKey(k('Space'), 'control-key', ctx)).toEqual({ kind: 'op', op: 'toggle' })
    expect(nodeFullKey(k('KeyF'), 'none', ctx)).toEqual({ kind: 'op', op: 'exit' })
    expect(nodeFullKey(k('Escape'), 'none', ctx)).toEqual({ kind: 'op', op: 'exit' })
    expect(nodeFullKey(k('Backquote', { ctrlKey: true }), 'none', ctx)).toEqual({ kind: 'op', op: 'fullscreen' })
    // app shortcuts never run behind the fullscreen video
    for (const e of [k('Delete'), k('KeyN'), k('KeyZ', { ctrlKey: true }), k('KeyS', { ctrlKey: true }), k('KeyC'), k('Digit1'), k('KeyM', { ctrlKey: true })])
      expect(nodeFullKey(e, 'none', ctx), e.code).toEqual({ kind: 'block' })
  })
})
