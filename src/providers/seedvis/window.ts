// The arrival-time gate for same-key re-sends to seedvis (plan §7.3 step 6, money rule M5) and the pacing helpers of
// the seedvis adapter (deferral back-off §6.5, poll 404 back-off §6.9). Pure: no clock, no storage, no I/O.
//
// Why a gate: seedvis returns the existing job for a re-sent Idempotency-Key only while it remembers that key, and
// seedvis has not said how long that is (SEEDVIS_KEY_MEMORY_MS stays null until it confirms in writing). A re-send
// whose body arrives after seedvis forgot the key creates (and bills) a SECOND job. So every same-key POST must provably
// arrive inside the window:
//
//   memory       = SEEDVIS_KEY_MEMORY_MS                                  null → no same-key POST at all
//   start        = sent.firstLastByteAt ?? sent.at                        never later than seedvis stored the key
//   estMs        = bodyBytes / max(16 KiB/s, sent.uploadBps / 1.5) + 2 s  a pessimistic upload time
//   allowed      = now + estMs + margin (20 s) ≤ start + memory
//   mustFinishBy = start + memory − margin                                main aborts an upload not done by then
//
// `start` uses the client's own clock: the client sends its last byte no later than seedvis receives it, so the window
// is measured from a moment that is never later than the real one. A clock that went backwards (now < sent.at) closes
// the gate: nothing measured against it can be trusted.
import { SEEDVIS_KEY_MEMORY_MS, SEEDVIS_RESEND_SCHEDULE_MS, SEEDVIS_SAME_KEY_MARGIN_MS } from './contract'

/** Slowest upload rate the estimate assumes, whatever was measured (bytes / s). */
export const MIN_UPLOAD_BPS = 16 * 1024
/** The measured first-attempt rate is divided by this (a re-send may be slower). */
export const UPLOAD_RATE_SAFETY = 1.5
/** Fixed allowance on top of the transfer time (connection, TLS, headers). */
export const UPLOAD_FIXED_MS = 2_000
/**
 * Defensive cap on the key memory the gate will ever use, whatever the constant says (plan §14: a confirmed memory is
 * used as min(confirmed − 60 s, 15 min)).
 */
export const KEY_MEMORY_CAP_MS = 15 * 60_000

/** What the gate needs of a ledger `sent` record. */
export interface GateRecord {
  /** Local time the first POST of the key started (never overwritten). */
  at: number
  /** Local time the first attempt's last body byte was sent; null when no progress was reported. */
  firstLastByteAt: number | null
  /** Upload rate measured on the first attempt (bytes / s); null = unknown. */
  uploadBps: number | null
  /** Size of the body on the wire (JSON + base64 images). */
  bodyBytes: number
}

export type GateReason = 'ok' | 'disabled' | 'expired' | 'no-record' | 'clock'

export interface GateVerdict {
  allowed: boolean
  reason: GateReason
  /** start + memory − margin: main aborts a re-send whose last byte is not sent by then. Null when disabled / no record. */
  mustFinishBy: number | null
  /** Latest moment a re-send may START and still arrive in time (mustFinishBy − estMs). Null when disabled / no record. */
  safeUntil: number | null
  /** The upload estimate used (ms). */
  estMs: number | null
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The key memory the gate uses: null (disabled) unless a positive finite number, capped at KEY_MEMORY_CAP_MS. */
export function effectiveMemoryMs(memoryMs: number | null | undefined): number | null {
  if (!finite(memoryMs) || memoryMs <= 0) return null
  return Math.min(memoryMs, KEY_MEMORY_CAP_MS)
}

/** Pessimistic upload time of `bodyBytes` given the rate measured on the first attempt (null / bad = unknown). */
export function estUploadMs(bodyBytes: number, uploadBps: number | null): number {
  const bytes = finite(bodyBytes) && bodyBytes > 0 ? bodyBytes : 0
  const measured = finite(uploadBps) && uploadBps > 0 ? uploadBps / UPLOAD_RATE_SAFETY : 0
  const rate = Math.max(MIN_UPLOAD_BPS, measured)
  return Math.ceil((bytes / rate) * 1000) + UPLOAD_FIXED_MS
}

/** The moment the window is measured from: the first attempt's last byte, else the start of the first POST. */
export function gateStart(rec: Pick<GateRecord, 'at' | 'firstLastByteAt'>): number {
  return finite(rec.firstLastByteAt) ? rec.firstLastByteAt : rec.at
}

/** start + memory − margin, or null when same-key re-sends are disabled / the record is unusable. */
export function sameKeyDeadline(
  rec: Pick<GateRecord, 'at' | 'firstLastByteAt'> | null | undefined,
  memoryMs: number | null = SEEDVIS_KEY_MEMORY_MS,
  marginMs: number = SEEDVIS_SAME_KEY_MARGIN_MS,
): number | null {
  const memory = effectiveMemoryMs(memoryMs)
  if (memory === null || !rec || !finite(rec.at)) return null
  return gateStart(rec) + memory - Math.max(0, finite(marginMs) ? marginMs : SEEDVIS_SAME_KEY_MARGIN_MS)
}

/**
 * May a POST of this key start now? Every same-key POST passes here: the automatic re-sends after a lost answer, an
 * explicit "Chạy lại", the engine's immediate dispatch and any later dispatch of the same key.
 */
export function sameKeyGate(
  rec: GateRecord | null | undefined,
  now: number,
  memoryMs: number | null = SEEDVIS_KEY_MEMORY_MS,
  marginMs: number = SEEDVIS_SAME_KEY_MARGIN_MS,
): GateVerdict {
  const memory = effectiveMemoryMs(memoryMs)
  if (memory === null) return { allowed: false, reason: 'disabled', mustFinishBy: null, safeUntil: null, estMs: null }
  if (!rec || !finite(rec.at) || !finite(rec.bodyBytes) || rec.bodyBytes < 0) {
    return { allowed: false, reason: 'no-record', mustFinishBy: null, safeUntil: null, estMs: null }
  }
  const mustFinishBy = sameKeyDeadline(rec, memory, marginMs)!
  const estMs = estUploadMs(rec.bodyBytes, rec.uploadBps)
  const safeUntil = mustFinishBy - estMs
  // The clock went backwards since the first POST (or the record is from the future): nothing measured against this
  // clock can be trusted — closed.
  if (!finite(now) || now < rec.at || now < gateStart(rec)) return { allowed: false, reason: 'clock', mustFinishBy, safeUntil, estMs }
  const allowed = now <= safeUntil
  return { allowed, reason: allowed ? 'ok' : 'expired', mustFinishBy, safeUntil, estMs }
}

/** Absolute times of the automatic same-key re-sends after a lost answer at `lostAt` (+15 s, +45 s, +90 s). */
export function resendSchedule(lostAt: number, schedule: readonly number[] = SEEDVIS_RESEND_SCHEDULE_MS): number[] {
  return schedule.filter((ms) => finite(ms) && ms >= 0).map((ms) => lostAt + ms)
}

// ---- deferral back-off (§6.5) ----

/** Pause after the n-th consecutive deferred submit: 15 s → 30 → 60 → 120 → 300 s (cap). */
export const DEFER_STEPS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const
/** A Retry-After longer than this is not believed (main clamps to 1–300 s anyway). */
export const DEFER_RETRY_AFTER_CAP_MS = 30 * 60_000
/**
 * A deferred take whose body is bigger than this is not re-uploaded just because the pause ended (the engine waits for
 * a slot signal or the 300 s cap, §6.5).
 */
export const DEFER_BIG_BODY_BYTES = 2 * 1024 * 1024

export function deferDelayMs(consecutiveDeferrals: number, retryAfterMs?: number | null): number {
  const n = finite(consecutiveDeferrals) ? Math.max(1, Math.floor(consecutiveDeferrals)) : 1
  const step = DEFER_STEPS_MS[Math.min(n, DEFER_STEPS_MS.length) - 1]
  const after = finite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, DEFER_RETRY_AFTER_CAP_MS) : 0
  return Math.max(step, after)
}

// ---- poll 404 back-off and the "job is gone" rule (§6.9) ----

/** Wait before the next poll after the n-th 404 in a row: 15 s × 4, then 1 min, 5 min, 30 min, 2 h, then every 6 h. */
export const NOT_FOUND_STEPS_MS = [15_000, 15_000, 15_000, 15_000, 60_000, 300_000, 1_800_000, 7_200_000] as const
export const NOT_FOUND_LONG_MS = 6 * 3_600_000

export function notFoundDelayMs(misses: number): number {
  const n = finite(misses) ? Math.max(1, Math.floor(misses)) : 1
  return n <= NOT_FOUND_STEPS_MS.length ? NOT_FOUND_STEPS_MS[n - 1] : NOT_FOUND_LONG_MS
}

/** A take ends "not found" only after this many JSON not-found answers… */
export const NOT_FOUND_MIN_COUNT = 3
/** …spread over at least this long, all made with the key that sent the job. */
export const NOT_FOUND_MIN_SPAN_MS = 30 * 60_000

export interface NotFoundStreak {
  /** Every 404 in a row (HTML, empty, JSON alike): drives the back-off. */
  misses: number
  /** JSON not-found answers made with the job's own key (the only ones that count as evidence). */
  count: number
  /** Time of the first / last of those (null until one). */
  first: number | null
  last: number | null
}

export const NO_STREAK: NotFoundStreak = Object.freeze({ misses: 0, count: 0, first: null, last: null })

/**
 * The streak after one more 404 at `now`. `evidence` = a JSON body naming the job as not found, polled with the key
 * that sent the job (an HTML page, an empty body, a model_* code or an unknown key never count, but they never reset).
 */
export function nextStreak(prev: NotFoundStreak | null | undefined, now: number, evidence: boolean): NotFoundStreak {
  const p = prev ?? NO_STREAK
  const misses = (finite(p.misses) ? p.misses : 0) + 1
  if (!evidence) return { misses, count: p.count, first: p.first, last: p.last }
  return { misses, count: (finite(p.count) ? p.count : 0) + 1, first: finite(p.first) ? p.first : now, last: now }
}

/** True once the evidence is enough to end a paid take as "not found" (≥ 3 answers over ≥ 30 min). */
export function notFoundEnds(streak: NotFoundStreak | null | undefined): boolean {
  if (!streak || !finite(streak.first) || !finite(streak.last)) return false
  return streak.count >= NOT_FOUND_MIN_COUNT && streak.last - streak.first >= NOT_FOUND_MIN_SPAN_MS
}
