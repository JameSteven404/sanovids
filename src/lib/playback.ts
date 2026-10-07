// Playback preferences of the in-app video players (canvas take player, take viewer, storyboard "Phát liền"):
// sound on/off, volume and speed, remembered on this device. Browsers may refuse to start a video WITH sound before
// the user has interacted with the page (autoplay policy); playWithSound() then falls back to muted playback so the
// picture still shows.
//
// Also the canvas' transient player state (not persisted): which take node keeps its player open after the mouse
// leaves (`pinned`), which completed take node is hovered for a preview (`hoverId`), which one is fullscreen
// ("Phóng to", `fullscreenId`), a play request waiting for a card player to mount (`playRequest`), and where each
// take's player was left (resume position) and how long its video is (known length).
import { create } from 'zustand'

const SOUND_KEY = 'bdp:pref:videoSound'
const VOLUME_KEY = 'bdp:pref:videoVolume'
const RATE_KEY = 'bdp:pref:videoRate'

/** Speeds offered by the canvas player (the take viewer's native menu may pick others: they are snapped). */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

/** Stored volume → 0..1 (default 1; garbage, empty or non-finite → 1; out of range → clamped). */
export function parseVolume(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === '') return 1
  const n = Number(raw)
  if (!Number.isFinite(n)) return 1
  return Math.min(1, Math.max(0, n))
}

/** Stored speed → one of PLAYBACK_RATES (anything else → 1). */
export function parseRate(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === '') return 1
  const n = Number(raw)
  return (PLAYBACK_RATES as readonly number[]).includes(n) ? n : 1
}

/** The allowed speed nearest to `rate` (ties → the slower one); non-finite / ≤ 0 → 1. */
export function snapRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 1
  let best: number = PLAYBACK_RATES[0]
  for (const r of PLAYBACK_RATES) if (Math.abs(r - rate) < Math.abs(best - rate) - 1e-9) best = r
  return best
}

/** Lowest level a speaker button brings the sound back to from volume 0 (a remembered 5 % sounds like off). */
export const MIN_UNMUTE_VOLUME = 0.25

/**
 * A speaker button was pressed. `on`: the player is audible now (sound on and not muted). Turning the sound on from a
 * volume of 0 also lifts the volume back to `remembered` (at least MIN_UNMUTE_VOLUME; unknown → full) — otherwise the
 * button would "turn the sound on" and stay silent.
 */
export function toggleSound(on: boolean, volume: number, remembered = 1): { sound: boolean; volume: number } {
  if (on && volume > 0) return { sound: false, volume }
  if (volume > 0) return { sound: true, volume }
  const back = Number.isFinite(remembered) && remembered > 0 ? Math.min(1, Math.max(MIN_UNMUTE_VOLUME, remembered)) : 1
  return { sound: true, volume: back }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable: the choice lasts for this session */
  }
}

interface PlaybackState {
  /** Play with sound (default on). */
  sound: boolean
  /** 0..1 (default 1). */
  volume: number
  /** One of PLAYBACK_RATES (default 1). */
  rate: number
  /** Take whose canvas player stays open (and playing) after the mouse leaves its node. Not persisted. */
  pinned: string | null
  /** Completed take node currently hovered for a preview. Not persisted. */
  hoverId: string | null
  /** Take whose canvas player is fullscreen ("Phóng to"); key handlers behind it stay quiet. Not persisted. */
  fullscreenId: string | null
  /** A play request for a take's card player, which may mount only after it (see requestPlay). Not persisted. */
  playRequest: PlayRequest | null
  setSound: (sound: boolean) => void
  setVolume: (volume: number) => void
  setRate: (rate: number) => void
  /** Keep this take's player open; any other pinned player closes. */
  pin: (takeId: string) => void
  /** Unpin `takeId` (only if it is the pinned one), or whatever is pinned when called without an id. */
  unpin: (takeId?: string) => void
  setHoverId: (takeId: string | null) => void
  /** The pointer left `takeId`: clears the hover only if it is still that take (enter B can come before leave A). */
  clearHoverId: (takeId: string) => void
  /** `takeId`'s player entered (takeId) or left (null) fullscreen; leaving only clears it for that take. */
  setFullscreen: (takeId: string | null, of?: string) => void
  /**
   * Play `takeId` on its card: pins it (the card mounts its player) and leaves the operation for the player, which
   * takes it when it mounts or at once when it is already mounted (consumePlayRequest). Expires after PLAY_REQUEST_TTL_MS.
   */
  requestPlay: (takeId: string, op: PlayOp, opts?: { focus?: boolean; at?: number }) => void
  /** The live request for `takeId` (then gone), or null: none, another take's, or expired. */
  consumePlayRequest: (takeId: string, now?: number) => PlayRequest | null
}

/** What a play request asks of a card player (the J / K / L / Space operations of core/transportKeys). */
export type PlayOp = 'toggle' | 'forward' | 'reverse' | 'stop'
export interface PlayRequest {
  takeId: string
  op: PlayOp
  /** Date.now() of the request. */
  at: number
  /** Asked from the keyboard: the player's play button takes the focus. */
  focus: boolean
}
/** A request nobody took after this long is dropped (the card was off-screen, zoomed out or hidden). */
export const PLAY_REQUEST_TTL_MS = 1000

/** Pure: `req` if it is `takeId`'s and still fresh at `now`. */
export function livePlayRequest(req: PlayRequest | null, takeId: string, now: number): PlayRequest | null {
  if (!req || req.takeId !== takeId) return null
  const age = now - req.at
  return age >= 0 && age <= PLAY_REQUEST_TTL_MS ? req : null
}

export const usePlayback = create<PlaybackState>()((set, get) => ({
  sound: read(SOUND_KEY) !== 'false',
  volume: parseVolume(read(VOLUME_KEY)),
  rate: parseRate(read(RATE_KEY)),
  pinned: null,
  hoverId: null,
  fullscreenId: null,
  playRequest: null,
  setSound: (sound) => {
    write(SOUND_KEY, String(sound))
    set({ sound })
  },
  setVolume: (volume) => {
    if (!Number.isFinite(volume)) return
    const v = Math.min(1, Math.max(0, volume))
    if (v === get().volume) return
    write(VOLUME_KEY, String(v))
    set({ volume: v })
  },
  setRate: (rate) => {
    const r = snapRate(rate)
    if (r === get().rate) return
    write(RATE_KEY, String(r))
    set({ rate: r })
  },
  pin: (takeId) => {
    if (get().pinned !== takeId) set({ pinned: takeId })
  },
  unpin: (takeId) => {
    const { pinned } = get()
    if (pinned !== null && (takeId === undefined || pinned === takeId)) set({ pinned: null })
  },
  setHoverId: (takeId) => {
    if (get().hoverId !== takeId) set({ hoverId: takeId })
  },
  clearHoverId: (takeId) => {
    if (get().hoverId === takeId) set({ hoverId: null })
  },
  setFullscreen: (takeId, of) => {
    const cur = get().fullscreenId
    if (takeId === null) {
      if (cur !== null && (of === undefined || cur === of)) set({ fullscreenId: null })
    } else if (cur !== takeId) set({ fullscreenId: takeId })
  },
  requestPlay: (takeId, op, opts) => {
    set({ pinned: takeId, playRequest: { takeId, op, at: opts?.at ?? Date.now(), focus: !!opts?.focus } })
  },
  consumePlayRequest: (takeId, now = Date.now()) => {
    const req = get().playRequest
    if (!req || req.takeId !== takeId) return null
    set({ playRequest: null })
    return livePlayRequest(req, takeId, now)
  },
}))

// ---------------- resume position per take (this session only) ----------------
const positions = new Map<string, number>()
/** Enough for every take a session touches; the oldest entries go first. */
const MAX_POSITIONS = 500
/** Closer than this to the end, a player starts over instead of resuming. */
export const RESUME_END_MARGIN = 0.5

/** Remember where `takeId`'s player was left (seconds). */
export function savePosition(takeId: string, seconds: number) {
  positions.delete(takeId)
  if (!Number.isFinite(seconds) || seconds <= 0) return
  positions.set(takeId, seconds)
  if (positions.size > MAX_POSITIONS) {
    const oldest = positions.keys().next().value
    if (oldest !== undefined) positions.delete(oldest)
  }
}

export function savedPosition(takeId: string): number | undefined {
  return positions.get(takeId)
}

// ---------------- known length per take (this session only) ----------------
const lengths = new Map<string, number>()

/** Remember the measured length of `takeId`'s video (seconds): the card's resting bar shows it. */
export function saveLength(takeId: string, seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return
  lengths.delete(takeId)
  lengths.set(takeId, seconds)
  if (lengths.size > MAX_POSITIONS) {
    const oldest = lengths.keys().next().value
    if (oldest !== undefined) lengths.delete(oldest)
  }
}

/** The measured length of `takeId`'s video, once a player has loaded it this session (never the requested duration). */
export function knownLength(takeId: string): number | undefined {
  return lengths.get(takeId)
}

/** Where to start a video of `duration` s that was left at `saved` s: there, or 0 near / past the end or unknown. */
export function resumePoint(saved: number | undefined, duration: number): number {
  if (saved === undefined || !Number.isFinite(saved) || saved <= 0) return 0
  if (Number.isFinite(duration) && duration > 0 && saved >= duration - RESUME_END_MARGIN) return 0
  return saved
}

/**
 * Start `video` with sound when `sound` is on. When the browser blocks unmuted autoplay (NotAllowedError: no user
 * gesture yet), it plays muted instead. Resolves whether the video is left unmuted (= audible once it plays).
 */
export async function playWithSound(video: HTMLVideoElement, sound: boolean): Promise<boolean> {
  video.muted = !sound
  try {
    await video.play()
  } catch (e) {
    // AbortError etc. (paused / new source / hidden page saving power): nothing to fix, it keeps its sound setting.
    if (sound && (e as DOMException)?.name === 'NotAllowedError') {
      video.muted = true
      try {
        await video.play()
      } catch {
        /* still refused: the poster stays visible */
      }
    }
  }
  return !video.muted
}
