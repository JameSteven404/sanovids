// Deterministic random numbers for the stress tester (no dependency): mulberry32 + 8-hex seeds + labelled forks, so
// every subsystem (actions, server, text corpus…) draws from its own stream and a failure replays exactly.

/** A seed as shown to the user: 8 lowercase hex digits ("7f3a91c2"). */
export type Seed = string

const SEED_RE = /^[0-9a-f]{8}$/

/** "7F3A91C2 " → "7f3a91c2"; anything else → null. */
export function parseSeed(raw: unknown): Seed | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  return SEED_RE.test(s) ? s : null
}

/** A fresh seed (Math.random / crypto only to pick it; the run itself is deterministic). */
export function randomSeed(): Seed {
  const n = globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0] : Math.floor(Math.random() * 2 ** 32)
  return (n >>> 0).toString(16).padStart(8, '0')
}

/** FNV-1a 32-bit hash of a string (seed + label → sub-seed). */
export function hash32(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export interface Rng {
  /** The seed this stream started from (forks: seed + '/' + label). */
  readonly label: string
  /** [0, 1) */
  next(): number
  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number
  /** A raw 31-bit integer (stored in action args, resolved later with `% list.length`). */
  raw(): number
  chance(p: number): boolean
  pick<T>(list: readonly T[]): T
  /** Index chosen by weight (weights ≤ 0 never chosen); -1 when all weights are ≤ 0. */
  weighted(weights: readonly number[]): number
  /** An independent stream for a subsystem ("server", "corpus"…). Same seed + label = same stream. */
  fork(label: string): Rng
}

function mulberry32(a: number): () => number {
  let s = a >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createRng(seed: string, label = seed): Rng {
  const next = mulberry32(hash32(label))
  const rng: Rng = {
    label,
    next,
    int: (min, max) => (max <= min ? min : min + Math.floor(next() * (max - min + 1))),
    raw: () => Math.floor(next() * 0x7fffffff),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
    weighted: (weights) => {
      let total = 0
      for (const w of weights) if (w > 0) total += w
      if (total <= 0) return -1
      let r = next() * total
      for (let i = 0; i < weights.length; i++) {
        const w = weights[i]
        if (w <= 0) continue
        if (r < w) return i
        r -= w
      }
      for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i
      return -1
    },
    fork: (sub) => createRng(seed, `${label}/${sub}`),
  }
  return rng
}

/** `list[r % length]` (a stored raw pick against today's list); undefined for an empty list. */
export function at<T>(list: readonly T[], r: number): T | undefined {
  return list.length ? list[Math.abs(Math.trunc(r)) % list.length] : undefined
}

/**
 * RFC 4122-shaped ids from a stream: tests swap `crypto.randomUUID` for this so ids (and therefore every replay) are
 * the same for the same seed. Never used in the app (it would change real ids).
 */
export function seededUuid(rng: Rng): () => `${string}-${string}-${string}-${string}-${string}` {
  const hex = (n: number) => {
    let out = ''
    for (let i = 0; i < n; i++) out += Math.floor(rng.next() * 16).toString(16)
    return out
  }
  return () => `${hex(8)}-${hex(4)}-4${hex(3)}-${((8 + Math.floor(rng.next() * 4)) as number).toString(16)}${hex(3)}-${hex(12)}`
}
