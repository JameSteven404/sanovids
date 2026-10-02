// Credit display helpers (pure, no stores). docs/SPEC-v2.md §9 "Demo credits vs real credits".
//
// Two kinds of credits exist and must never be confused:
//   'demo'       play money kept locally in useRuns.credits (store/runs). Only the mock (demo) provider spends it.
//                NOT real money — label it "credit demo" everywhere.
//   'canvasapp'  the user's real canvasapp.io.vn balance (1 credit ≈ 1.000đ), read from /api/me (store/credits).
//
// ---- API ----
//   creditKindOf(providerId)                 'mock' → 'demo', 'canvasapp' → 'canvasapp'.
//   formatCredits(n, kind, { short? })       "1.234 credit demo" | "1.234 credit"; short: "1.234 cr" for both kinds
//                                            (the UI adds its small "demo" mark next to a short demo amount).
//                                            null / NaN → "—" (never invent a number).
//   formatCreditNumber(n)                    "1.234" (vi-VN grouping, up to 2 decimals "1.234,5"); unknown → "—".
//   creditUnitLabel(kind, { short? })        "credit demo" | "credit"; short: "cr".
//   formatVnd(credits)                       "1.234.000đ" (1 credit ≈ 1.000đ; meaningful for canvasapp only).
//   CREDIT_SOURCE_LABEL[kind]                "credit demo" | "credit canvasapp" (e.g. "đã trả bằng credit canvasapp").
//   DEMO_CREDIT_HINT                         tooltip for every demo amount: "Credit giả lập — không phải tiền thật".
//   DEMO_CREDITS_DEFAULT                     1000: demo balance of NEW runs data (store/runs; saved balances are kept).
//   chargedDemo(take)                        the take was paid with demo credits (so a failure/cancel refunds them).
//                                            Always false for canvasapp takes.
import type { Take } from '../core/types'
import { providerOf, type ProviderId } from '../providers/types'

export type CreditKind = 'demo' | 'canvasapp'

/** Demo balance of new runs data (and what "Đặt lại credit demo" sets). */
export const DEMO_CREDITS_DEFAULT = 1000

/** 1 canvasapp credit ≈ 1.000đ (docs/canvasapp-api-notes.md). */
export const VND_PER_CREDIT = 1000

export const DEMO_CREDIT_HINT = 'Credit giả lập — không phải tiền thật'

export const CREDIT_SOURCE_LABEL: Record<CreditKind, string> = { demo: 'credit demo', canvasapp: 'credit canvasapp' }

export const creditKindOf = (provider: ProviderId): CreditKind => (provider === 'canvasapp' ? 'canvasapp' : 'demo')

export interface CreditFormatOptions {
  /** Compact form for tight spots (scene cards, chips): "20 cr". */
  short?: boolean
}

const UNKNOWN = '—'

const known = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

/**
 * Number in Vietnamese notation: "." groups thousands, "," before decimals (at most 2, trailing zeros dropped).
 * Done by hand rather than with Intl so the output is the same in every browser / Electron / test runtime.
 */
export function formatCreditNumber(n: number | null | undefined): string {
  if (!known(n)) return UNKNOWN
  const rounded = Math.round(Math.abs(n) * 100) / 100
  const [int, frac = ''] = rounded.toFixed(2).split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const decimals = frac.replace(/0+$/, '')
  return (n < 0 && rounded !== 0 ? '-' : '') + grouped + (decimals ? ',' + decimals : '')
}

export function creditUnitLabel(kind: CreditKind, opts: CreditFormatOptions = {}): string {
  if (opts.short) return 'cr'
  return kind === 'demo' ? 'credit demo' : 'credit'
}

/** "20 credit demo" | "20 credit" | short "20 cr". Unknown amount → "—". */
export function formatCredits(n: number | null | undefined, kind: CreditKind, opts: CreditFormatOptions = {}): string {
  if (!known(n)) return UNKNOWN
  return `${formatCreditNumber(n)} ${creditUnitLabel(kind, opts)}`
}

/** Approximate value in đồng: "1.234.000đ". Unknown → "—". */
export function formatVnd(credits: number | null | undefined): string {
  if (!known(credits)) return UNKNOWN
  return `${formatCreditNumber(Math.round(credits * VND_PER_CREDIT))}đ`
}

/** Paid with demo credits (refunded on failure / cancel). Old takes without the field: yes. canvasapp: never. */
export function chargedDemo(t: Pick<Take, 'provider' | 'charged'>): boolean {
  return providerOf(t) === 'mock' && t.charged !== false
}
