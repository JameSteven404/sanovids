// The arrival-time gate of same-key re-sends (plan §7.3 step 6, M5) and the pacing helpers — pure truth tables.
import { describe, expect, it } from 'vitest'
import { SEEDVIS_KEY_MEMORY_MS, SEEDVIS_SAME_KEY_MARGIN_MS } from '../contract'
import {
  DEFER_STEPS_MS,
  deferDelayMs,
  effectiveMemoryMs,
  estUploadMs,
  gateStart,
  KEY_MEMORY_CAP_MS,
  MIN_UPLOAD_BPS,
  nextStreak,
  NO_STREAK,
  notFoundDelayMs,
  notFoundEnds,
  resendSchedule,
  sameKeyDeadline,
  sameKeyGate,
  UPLOAD_FIXED_MS,
  type GateRecord,
} from '../window'

const MEM = 120_000 // the simulation's key memory (plan §7.3 tests)
const MiB = 1024 * 1024
const T0 = 1_800_000_000_000
/** 2 Mbps in bytes / s. */
const MBPS2 = 2_000_000 / 8

const rec = (over: Partial<GateRecord> = {}): GateRecord => ({ at: T0, firstLastByteAt: null, uploadBps: null, bodyBytes: 10_000, ...over })

describe('seedvis arrival gate — disabled until seedvis confirms its key memory', () => {
  it('ships disabled: SEEDVIS_KEY_MEMORY_MS is null, so no same-key POST is ever allowed', () => {
    expect(SEEDVIS_KEY_MEMORY_MS).toBeNull()
    const g = sameKeyGate(rec(), T0 + 1)
    expect(g).toEqual({ allowed: false, reason: 'disabled', mustFinishBy: null, safeUntil: null, estMs: null })
    expect(sameKeyDeadline(rec())).toBeNull()
  })

  it.each([null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])('a memory of %s disables the gate', (m) => {
    expect(effectiveMemoryMs(m as number | null)).toBeNull()
    expect(sameKeyGate(rec(), T0, m as number | null).reason).toBe('disabled')
  })

  it('caps the memory it will ever use at 15 min, whatever the constant says', () => {
    expect(effectiveMemoryMs(3_600_000)).toBe(KEY_MEMORY_CAP_MS)
    const g = sameKeyGate(rec(), T0 + 20 * 60_000, 3_600_000)
    expect(g.allowed).toBe(false)
    expect(g.mustFinishBy).toBe(T0 + KEY_MEMORY_CAP_MS - SEEDVIS_SAME_KEY_MARGIN_MS)
  })

  it.each([
    ['no record', null],
    ['NaN start', rec({ at: Number.NaN })],
    ['negative size', rec({ bodyBytes: -1 })],
    ['NaN size', rec({ bodyBytes: Number.NaN })],
  ])('refuses without a usable record (%s)', (_, r) => {
    expect(sameKeyGate(r, T0 + 1, MEM)).toMatchObject({ allowed: false, reason: 'no-record' })
  })
})

describe('seedvis arrival gate — the estimate and the window', () => {
  it('estimates the upload pessimistically: measured rate / 1.5, never below 16 KiB/s, plus 2 s', () => {
    expect(estUploadMs(0, null)).toBe(UPLOAD_FIXED_MS)
    expect(estUploadMs(MIN_UPLOAD_BPS * 10, null)).toBe(10_000 + UPLOAD_FIXED_MS)
    // a measured 1.5 MB/s counts as 1 MB/s
    expect(estUploadMs(3_000_000, 1_500_000)).toBe(3_000 + UPLOAD_FIXED_MS)
    // a measured rate slower than the floor: the floor is still assumed (a floor, not a ceiling)
    expect(estUploadMs(MIN_UPLOAD_BPS * 4, 1000)).toBe(4_000 + UPLOAD_FIXED_MS)
    // garbage rates are unknown
    expect(estUploadMs(MIN_UPLOAD_BPS, Number.NaN)).toBe(1000 + UPLOAD_FIXED_MS)
    expect(estUploadMs(MIN_UPLOAD_BPS, -5)).toBe(1000 + UPLOAD_FIXED_MS)
  })

  it('measures the window from the first attempt last byte, else from the first POST start', () => {
    expect(gateStart({ at: T0, firstLastByteAt: T0 + 7_000 })).toBe(T0 + 7_000)
    expect(gateStart({ at: T0, firstLastByteAt: null })).toBe(T0)
    expect(sameKeyDeadline(rec({ firstLastByteAt: T0 + 7_000 }), MEM)).toBe(T0 + 7_000 + MEM - SEEDVIS_SAME_KEY_MARGIN_MS)
    expect(sameKeyDeadline(rec(), MEM)).toBe(T0 + MEM - SEEDVIS_SAME_KEY_MARGIN_MS)
  })

  it('allows exactly up to now + est + margin = start + memory, refuses 1 ms later', () => {
    const r = rec({ firstLastByteAt: T0 + 5_000, uploadBps: 1_500_000, bodyBytes: 3_000_000 })
    const est = estUploadMs(r.bodyBytes, r.uploadBps)
    const edge = T0 + 5_000 + MEM - SEEDVIS_SAME_KEY_MARGIN_MS - est
    const at = sameKeyGate(r, edge, MEM)
    expect(at).toEqual({ allowed: true, reason: 'ok', mustFinishBy: T0 + 5_000 + MEM - SEEDVIS_SAME_KEY_MARGIN_MS, safeUntil: edge, estMs: est })
    expect(at.safeUntil! + at.estMs! + SEEDVIS_SAME_KEY_MARGIN_MS).toBe(T0 + 5_000 + MEM)
    expect(sameKeyGate(r, edge + 1, MEM)).toMatchObject({ allowed: false, reason: 'expired', safeUntil: edge })
  })

  it('a bigger margin closes it earlier', () => {
    const r = rec({ bodyBytes: 0 })
    expect(sameKeyGate(r, T0 + MEM - 20_000 - UPLOAD_FIXED_MS, MEM, 20_000).allowed).toBe(true)
    expect(sameKeyGate(r, T0 + MEM - 20_000 - UPLOAD_FIXED_MS, MEM, 30_000).allowed).toBe(false)
  })

  it('closes when the clock went backwards (now before the first POST or its last byte)', () => {
    expect(sameKeyGate(rec(), T0 - 1, MEM)).toMatchObject({ allowed: false, reason: 'clock' })
    expect(sameKeyGate(rec({ firstLastByteAt: T0 + 9_000 }), T0 + 8_000, MEM)).toMatchObject({ allowed: false, reason: 'clock' })
  })

  it('without progress information the window starts at the POST start (earlier = safer)', () => {
    const withProgress = sameKeyGate(rec({ firstLastByteAt: T0 + 30_000 }), T0 + 60_000, MEM)
    const without = sameKeyGate(rec({ firstLastByteAt: null }), T0 + 60_000, MEM)
    expect(withProgress.safeUntil! - without.safeUntil!).toBe(30_000)
  })
})

describe('seedvis arrival gate — slow uploads and big bodies (plan §7.3 sim cases)', () => {
  it('8 MiB at 2 Mbps with a lost answer after the 45 s wait: not one automatic re-send fits the window', () => {
    const lastByte = T0 + Math.ceil(((8 * MiB) / MBPS2) * 1000)
    const r = rec({ firstLastByteAt: lastByte, uploadBps: MBPS2, bodyBytes: 8 * MiB })
    const lostAt = lastByte + 45_000
    for (const t of resendSchedule(lostAt)) expect(sameKeyGate(r, t, MEM)).toMatchObject({ allowed: false, reason: 'expired' })
    // the estimate alone is ~52 s: start + 120 s − 20 s − 52 s ≈ 48 s after the last byte
    expect(sameKeyGate(r, lastByte + 47_000, MEM).allowed).toBe(true)
  })

  it('30 MiB at 2 Mbps: an explicit "Chạy lại" at 1:30 is refused (and so is any moment: the upload alone outlasts the memory)', () => {
    const upload = Math.ceil(((30 * MiB) / MBPS2) * 1000)
    const r = rec({ firstLastByteAt: T0 + upload, uploadBps: MBPS2, bodyBytes: 30 * MiB })
    expect(estUploadMs(30 * MiB, MBPS2)).toBeGreaterThan(MEM)
    expect(sameKeyGate(r, T0 + upload + 90_000, MEM)).toMatchObject({ allowed: false, reason: 'expired' })
    expect(sameKeyGate(r, T0 + upload, MEM).allowed).toBe(false)
    // no progress reported and no rate: the 16 KiB/s floor makes it hopeless too
    expect(sameKeyGate(rec({ bodyBytes: 30 * MiB }), T0 + 1, MEM).allowed).toBe(false)
  })

  it('30 MiB on a fast line (100 Mbps measured) fits the first two automatic re-sends, not the third', () => {
    const bps = 100_000_000 / 8
    const lastByte = T0 + Math.ceil(((30 * MiB) / bps) * 1000)
    const r = rec({ firstLastByteAt: lastByte, uploadBps: bps, bodyBytes: 30 * MiB })
    const [first, second, third] = resendSchedule(lastByte + 45_000)
    expect(sameKeyGate(r, first, MEM).allowed).toBe(true)
    // +90 s after the last byte, ~5.8 s upload, 20 s margin: 115.8 s ≤ 120 s
    expect(sameKeyGate(r, second, MEM).allowed).toBe(true)
    expect(sameKeyGate(r, third, MEM).allowed).toBe(false)
  })

  it('invariant over many sizes / rates / moments: an allowed re-send at the assumed rate finishes before mustFinishBy, and mustFinishBy leaves the margin', () => {
    let seed = 0x5a17c0de
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    let allowed = 0
    for (let i = 0; i < 2000; i++) {
      const bodyBytes = Math.floor(rnd() * 40 * MiB)
      const uploadBps = rnd() < 0.2 ? null : 8_000 + rnd() * 20_000_000
      const firstLastByteAt = rnd() < 0.3 ? null : T0 + Math.floor(rnd() * 200_000)
      const r = rec({ bodyBytes, uploadBps, firstLastByteAt })
      const now = Math.max(T0, firstLastByteAt ?? T0) + Math.floor(rnd() * 150_000)
      const g = sameKeyGate(r, now, MEM)
      expect(g.mustFinishBy).toBe(gateStart(r) + MEM - SEEDVIS_SAME_KEY_MARGIN_MS)
      if (!g.allowed) continue
      allowed++
      const assumedRate = Math.max(MIN_UPLOAD_BPS, uploadBps ? uploadBps / 1.5 : 0)
      expect(now + (bodyBytes / assumedRate) * 1000).toBeLessThanOrEqual(g.mustFinishBy!)
      expect(now + g.estMs! + SEEDVIS_SAME_KEY_MARGIN_MS).toBeLessThanOrEqual(gateStart(r) + MEM)
    }
    expect(allowed).toBeGreaterThan(50)
  })
})

describe('seedvis pacing', () => {
  it('re-sends at +15 / +45 / +90 s after the lost answer', () => {
    expect(resendSchedule(1000)).toEqual([16_000, 46_000, 91_000])
    expect(resendSchedule(0, [5, -1, Number.NaN, 7])).toEqual([5, 7])
  })

  it('deferral back-off: 15 → 30 → 60 → 120 → 300 s cap; a longer Retry-After wins', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map((n) => deferDelayMs(n))).toEqual([15_000, 15_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000])
    expect(DEFER_STEPS_MS.at(-1)).toBe(300_000)
    expect(deferDelayMs(1, 90_000)).toBe(90_000)
    expect(deferDelayMs(4, 90_000)).toBe(120_000)
    expect(deferDelayMs(1, -5)).toBe(15_000)
    expect(deferDelayMs(1, 10 * 3_600_000)).toBe(30 * 60_000)
  })

  it('poll 404 back-off: 15 s × 4, then 1 min, 5 min, 30 min, 2 h, then every 6 h', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 40].map(notFoundDelayMs)).toEqual([15_000, 15_000, 15_000, 15_000, 60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 21_600_000])
  })

  it('a take ends "not found" only after ≥ 3 JSON not-found answers over ≥ 30 min — other 404s never count and never reset', () => {
    let s = NO_STREAK
    s = nextStreak(s, 0, true)
    s = nextStreak(s, 60_000, false) // an HTML maintenance page
    s = nextStreak(s, 120_000, true)
    expect(s).toEqual({ misses: 3, count: 2, first: 0, last: 120_000 })
    expect(notFoundEnds(s)).toBe(false)
    s = nextStreak(s, 29 * 60_000, true)
    expect(notFoundEnds(s)).toBe(false) // 3 answers, but only 29 min apart
    s = nextStreak(s, 30 * 60_000, true)
    expect(notFoundEnds(s)).toBe(true)
    // many answers within minutes never end it
    let quick = NO_STREAK
    for (let i = 0; i < 20; i++) quick = nextStreak(quick, i * 15_000, true)
    expect(notFoundEnds(quick)).toBe(false)
    // HTML only, for days: never
    let html = NO_STREAK
    for (let i = 0; i < 50; i++) html = nextStreak(html, i * 6 * 3_600_000, false)
    expect(notFoundEnds(html)).toBe(false)
    expect(notFoundEnds(null)).toBe(false)
  })
})
