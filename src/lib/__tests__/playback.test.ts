import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_UNMUTE_VOLUME,
  parseRate,
  parseVolume,
  PLAYBACK_RATES,
  playWithSound,
  resumePoint,
  savedPosition,
  savePosition,
  snapRate,
  toggleSound,
  usePlayback,
} from '../playback'

/** Minimal stand-in for an HTMLVideoElement: play() answers from a script of outcomes. */
function fakeVideo(outcomes: (null | string)[]) {
  const calls: boolean[] = []
  const v = {
    muted: true,
    play() {
      calls.push(v.muted)
      const err = outcomes.shift() ?? null
      return err ? Promise.reject(Object.assign(new Error(err), { name: err })) : Promise.resolve()
    },
  }
  return { v: v as unknown as HTMLVideoElement, calls }
}

/** In-memory localStorage (the tests run in Node, where there is none). */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size
    },
  }
}

describe('playWithSound', () => {
  it('plays with sound when allowed', async () => {
    const { v, calls } = fakeVideo([null])
    expect(await playWithSound(v, true)).toBe(true)
    expect(v.muted).toBe(false)
    expect(calls).toEqual([false])
  })
  it('falls back to muted playback when the browser refuses sound (no click yet)', async () => {
    const { v, calls } = fakeVideo(['NotAllowedError', null])
    expect(await playWithSound(v, true)).toBe(false)
    expect(v.muted).toBe(true)
    expect(calls).toEqual([false, true])
  })
  it('plays muted when the speaker switch is off', async () => {
    const { v, calls } = fakeVideo([null])
    expect(await playWithSound(v, false)).toBe(false)
    expect(calls).toEqual([true])
  })
  it('an interrupted play (paused, new source, hidden page) keeps the sound setting and is not retried', async () => {
    const { v, calls } = fakeVideo(['AbortError'])
    expect(await playWithSound(v, true)).toBe(true)
    expect(v.muted).toBe(false)
    expect(calls).toEqual([false])
  })
})

describe('toggleSound (speaker buttons)', () => {
  it('audible → off, the volume is kept', () => {
    expect(toggleSound(true, 0.6)).toEqual({ sound: false, volume: 0.6 })
  })
  it('off → on at the same volume', () => {
    expect(toggleSound(false, 0.6, 0.9)).toEqual({ sound: true, volume: 0.6 })
  })
  it('at volume 0 the switch turns the sound on AND brings the volume back (never "on" but silent)', () => {
    // Sound pref on but volume 0 = silent: the press means "turn it on".
    expect(toggleSound(true, 0)).toEqual({ sound: true, volume: 1 })
    expect(toggleSound(false, 0, 0.7)).toEqual({ sound: true, volume: 0.7 })
  })
  it('a remembered near-silent level comes back at least at MIN_UNMUTE_VOLUME; unknown → full', () => {
    expect(toggleSound(false, 0, 0.05)).toEqual({ sound: true, volume: MIN_UNMUTE_VOLUME })
    expect(toggleSound(false, 0, 0)).toEqual({ sound: true, volume: 1 })
    expect(toggleSound(false, 0, Number.NaN)).toEqual({ sound: true, volume: 1 })
    expect(toggleSound(false, 0, 3)).toEqual({ sound: true, volume: 1 })
  })
})

describe('stored volume / speed are validated', () => {
  it('volume: 0..1, default 1, clamped, garbage → 1', () => {
    expect(parseVolume(null)).toBe(1)
    expect(parseVolume(undefined)).toBe(1)
    expect(parseVolume('')).toBe(1)
    expect(parseVolume('  ')).toBe(1)
    expect(parseVolume('0.4')).toBe(0.4)
    expect(parseVolume('0')).toBe(0)
    expect(parseVolume('1')).toBe(1)
    expect(parseVolume('7')).toBe(1)
    expect(parseVolume('-2')).toBe(0)
    expect(parseVolume('abc')).toBe(1)
    expect(parseVolume('NaN')).toBe(1)
    expect(parseVolume('Infinity')).toBe(1)
  })
  it('speed: one of the offered speeds, anything else → 1', () => {
    for (const r of PLAYBACK_RATES) expect(parseRate(String(r))).toBe(r)
    expect(parseRate(null)).toBe(1)
    expect(parseRate('')).toBe(1)
    expect(parseRate('1.75')).toBe(1)
    expect(parseRate('16')).toBe(1)
    expect(parseRate('fast')).toBe(1)
    expect(parseRate('-1')).toBe(1)
  })
  it('snapRate: nearest offered speed (ties → slower), nonsense → 1', () => {
    expect(snapRate(1.25)).toBe(1.25)
    expect(snapRate(0.25)).toBe(0.5)
    expect(snapRate(1.75)).toBe(1.5)
    expect(snapRate(1.8)).toBe(2)
    expect(snapRate(16)).toBe(2)
    expect(snapRate(0)).toBe(1)
    expect(snapRate(Number.NaN)).toBe(1)
  })
})

describe('playback prefs (store + localStorage)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('reads and validates what this device stored', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'bdp:pref:videoSound': 'false', 'bdp:pref:videoVolume': '0.35', 'bdp:pref:videoRate': '1.5' }))
    vi.resetModules()
    const { usePlayback: fresh } = await import('../playback')
    const s = fresh.getState()
    expect(s.sound).toBe(false)
    expect(s.volume).toBe(0.35)
    expect(s.rate).toBe(1.5)
    expect(s.pinned).toBeNull()
    expect(s.hoverId).toBeNull()
  })

  it('broken stored values fall back to the defaults', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'bdp:pref:videoVolume': 'loud', 'bdp:pref:videoRate': '3' }))
    vi.resetModules()
    const { usePlayback: fresh } = await import('../playback')
    expect(fresh.getState().sound).toBe(true)
    expect(fresh.getState().volume).toBe(1)
    expect(fresh.getState().rate).toBe(1)
  })

  it('no storage at all (blocked / private): defaults, and setters still work for the session', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    vi.resetModules()
    const { usePlayback: fresh } = await import('../playback')
    expect(fresh.getState().volume).toBe(1)
    fresh.getState().setVolume(0.2)
    expect(fresh.getState().volume).toBe(0.2)
  })

  it('setters clamp / snap and persist', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    vi.resetModules()
    const { usePlayback: fresh } = await import('../playback')
    const p = () => fresh.getState()
    p().setVolume(0.6)
    expect(p().volume).toBe(0.6)
    expect(storage.data.get('bdp:pref:videoVolume')).toBe('0.6')
    p().setVolume(4)
    expect(p().volume).toBe(1)
    p().setVolume(-1)
    expect(p().volume).toBe(0)
    p().setVolume(Number.NaN)
    expect(p().volume).toBe(0)
    p().setRate(1.25)
    expect(p().rate).toBe(1.25)
    expect(storage.data.get('bdp:pref:videoRate')).toBe('1.25')
    p().setRate(0.25)
    expect(p().rate).toBe(0.5)
    p().setSound(false)
    expect(storage.data.get('bdp:pref:videoSound')).toBe('false')
  })
})

describe('pinned player and hover preview', () => {
  beforeEach(() => usePlayback.setState({ pinned: null, hoverId: null }))

  it('pinning another take replaces the pinned one', () => {
    const p = () => usePlayback.getState()
    p().pin('t1')
    expect(p().pinned).toBe('t1')
    p().pin('t2')
    expect(p().pinned).toBe('t2')
  })
  it('unpin(id) only unpins that take; unpin() unpins whatever is pinned (click on empty canvas)', () => {
    const p = () => usePlayback.getState()
    p().pin('t1')
    p().unpin('t2')
    expect(p().pinned).toBe('t1')
    p().unpin('t1')
    expect(p().pinned).toBeNull()
    p().pin('t3')
    p().unpin()
    expect(p().pinned).toBeNull()
  })
  it('leaving a node clears the hover only if it is still that node (enter B may come before leave A)', () => {
    const p = () => usePlayback.getState()
    p().setHoverId('a')
    p().setHoverId('b')
    p().clearHoverId('a')
    expect(p().hoverId).toBe('b')
    p().clearHoverId('b')
    expect(p().hoverId).toBeNull()
  })
  it('no store update when nothing changes (no re-render of the players)', () => {
    const seen: unknown[] = []
    const off = usePlayback.subscribe((s) => seen.push(s))
    usePlayback.getState().unpin()
    usePlayback.getState().clearHoverId('x')
    usePlayback.getState().pin('t1')
    usePlayback.getState().pin('t1')
    usePlayback.getState().setHoverId('t1')
    usePlayback.getState().setHoverId('t1')
    off()
    expect(seen).toHaveLength(2)
  })
})

describe('resume position', () => {
  it('resumes where the player was left', () => {
    savePosition('take-a', 4.2)
    expect(savedPosition('take-a')).toBe(4.2)
    expect(resumePoint(savedPosition('take-a'), 10)).toBe(4.2)
  })
  it('starts over near the end, at 0 or when nothing is known', () => {
    expect(resumePoint(9.6, 10)).toBe(0)
    expect(resumePoint(10, 10)).toBe(0)
    expect(resumePoint(12, 10)).toBe(0)
    expect(resumePoint(undefined, 10)).toBe(0)
    expect(resumePoint(0, 10)).toBe(0)
    expect(resumePoint(Number.NaN, 10)).toBe(0)
  })
  it('an unknown length (WebM without duration yet) still resumes', () => {
    expect(resumePoint(2, Infinity)).toBe(2)
    expect(resumePoint(2, 0)).toBe(2)
  })
  it('a position at the start forgets the take', () => {
    savePosition('take-b', 3)
    savePosition('take-b', 0)
    expect(savedPosition('take-b')).toBeUndefined()
  })
})
