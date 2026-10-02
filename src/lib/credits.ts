// Credit display helpers (pure, no stores). docs/SPEC-v2.md §9 "Demo credits vs real credits".
//
// Three kinds of credits exist and must never be confused:
//   'dev'        development mode: the balance of the SIMULATED canvasapp account (providers/dev), read from its
//                /api/me like the real one (store/credits). Fake — label it "credit dev" (DEV_CREDIT_HINT).
//   'canvasapp'  the user's real canvasapp.io.vn balance (1 credit ≈ 1.000đ), read from /api/me (store/credits).
//   'demo'       the old demo's local play money (useRuns.credits, store/runs). Only takes of the old demo provider
//                ('mock', saved before development mode) were paid with it — kept for their cost lines.
//
// ---- API ----
//   creditKindOf(providerId)                 'dev' → 'dev', 'canvasapp' → 'canvasapp', 'mock' → 'demo'.
//   isSimulatedCredit(kind)                  'dev' / 'demo': not real money.
//   formatCredits(n, kind, { short? })       "1.234 credit dev" | "1.234 credit demo" | "1.234 credit"; short: "1.234 cr"
//                                            for every kind (the UI adds its small mark next to a short fake amount).
//                                            null / NaN → "—" (never invent a number).
//   formatCreditNumber(n)                    "1.234" (vi-VN grouping, up to 2 decimals "1.234,5"); unknown → "—".
//   creditUnitLabel(kind, { short? })        "credit dev" | "credit demo" | "credit"; short: "cr".
//   formatVnd(credits)                       "1.234.000đ" (1 credit ≈ 1.000đ; meaningful for canvasapp — and its
//                                            simulation — only).
//   CREDIT_SOURCE_LABEL[kind]                "credit dev" | "credit demo" | "credit canvasapp".
//   DEV_CREDIT_HINT                          tooltip for every dev amount: "Credit giả lập của chế độ Phát triển — …".
//   DEMO_CREDIT_HINT                         tooltip for every demo amount: "Credit giả lập — không phải tiền thật".
//   CREDIT_HINT[kind]                        the tooltip of a kind (canvasapp: null).
//   CREDIT_MARK[kind]                        small mark next to a short fake amount ("20 cr" + "dev" / "demo");
//                                            null for real canvasapp credits.
//   DEMO_CREDITS_DEFAULT                     1000: demo balance of NEW runs data (store/runs; saved balances are kept).
//   chargedDemo(take)                        the take was paid with demo credits (so a failure/cancel refunds them).
//                                            Always false for dev / canvasapp takes.
import type { Take } from '../core/types'
import { providerOf, type ProviderId } from '../providers/types'

export type CreditKind = 'demo' | 'canvasapp' | 'dev'

/** Demo balance of new runs data (and what "Đặt lại credit demo" sets). */
export const DEMO_CREDITS_DEFAULT = 1000

/** 1 canvasapp credit ≈ 1.000đ (docs/canvasapp-api-notes.md). */
export const VND_PER_CREDIT = 1000

export const DEMO_CREDIT_HINT = 'Credit giả lập — không phải tiền thật'
export const DEV_CREDIT_HINT = 'Credit giả lập của chế độ Phát triển — không phải tiền thật'

export const CREDIT_HINT: Record<CreditKind, string | null> = { demo: DEMO_CREDIT_HINT, dev: DEV_CREDIT_HINT, canvasapp: null }

export const CREDIT_SOURCE_LABEL: Record<CreditKind, string> = { demo: 'credit demo', dev: 'credit dev', canvasapp: 'credit canvasapp' }

/** Small mark drawn next to a short simulated amount ("20 cr dev"), so it is never taken for real credits. */
export const CREDIT_MARK: Record<CreditKind, string | null> = { demo: 'demo', dev: 'dev', canvasapp: null }

export const creditKindOf = (provider: ProviderId): CreditKind => (provider === 'canvasapp' ? 'canvasapp' : provider === 'dev' ? 'dev' : 'demo')

/** Not real money: development-mode or old-demo credits. */
export const isSimulatedCredit = (kind: CreditKind): boolean => kind !== 'canvasapp'

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
  return kind === 'demo' ? 'credit demo' : kind === 'dev' ? 'credit dev' : 'credit'
}

/** "20 credit dev" | "20 credit demo" | "20 credit" | short "20 cr". Unknown amount → "—". */
export function formatCredits(n: number | null | undefined, kind: CreditKind, opts: CreditFormatOptions = {}): string {
  if (!known(n)) return UNKNOWN
  return `${formatCreditNumber(n)} ${creditUnitLabel(kind, opts)}`
}

/** Approximate value in đồng: "1.234.000đ". Unknown → "—". */
export function formatVnd(credits: number | null | undefined): string {
  if (!known(credits)) return UNKNOWN
  return `${formatCreditNumber(Math.round(credits * VND_PER_CREDIT))}đ`
}

/** Paid with demo credits (refunded on failure / cancel). Old takes without the field: yes. dev / canvasapp: never. */
export function chargedDemo(t: Pick<Take, 'provider' | 'charged'>): boolean {
  return providerOf(t) === 'mock' && t.charged !== false
}
