// Credit display helpers (pure, no stores). docs/SPEC-v2.md §9 "Demo credits vs real credits".
//
// Five kinds of credits exist (one wallet per provider, CREDIT_KIND_OF) and must never be confused:
//   'dev'          development mode: the balance of the SIMULATED canvasapp account (providers/dev), read from its
//                  /api/me like the real one (store/credits). Fake — label it "credit dev" (DEV_CREDIT_HINT).
//   'canvasapp'    the user's real canvasapp.io.vn balance (1 credit ≈ 1.000đ), read from /api/me (store/credits).
//   'seedvis'      the user's real seedvis.com balance ("credit seedvis"; no đồng value — formatVnd is canvasapp's).
//   'seedvis-dev'  development mode: the SIMULATED seedvis account ("credit dev seedvis", SEEDVIS_DEV_CREDIT_HINT).
//   'demo'         the old demo's local play money (useRuns.credits, store/runs). Only takes of the old demo provider
//                  ('mock', saved before development mode) were paid with it — kept for their cost lines.
//
// ---- API ----
//   creditKindOf(providerId)                 'dev' → 'dev', 'canvasapp' → 'canvasapp', 'mock' → 'demo', 'seedvis' →
//                                            'seedvis', 'seedvis-dev' → 'seedvis-dev' (CREDIT_KIND_OF, a full Record).
//   isSimulatedCredit(kind)                  'dev' / 'seedvis-dev' / 'demo': not real money.
//   formatCredits(n, kind, { short? })       "1.234 credit dev" | "1.234 credit demo" | "1.234 credit" | "1.234 credit
//                                            seedvis" | "1.234 credit dev seedvis"; short: "1.234 cr"
//                                            for every kind (the UI adds its small mark next to a short fake amount).
//                                            null / NaN → "—" (never invent a number).
//   formatCreditNumber(n)                    "1.234" (vi-VN grouping, up to 2 decimals "1.234,5"); unknown → "—".
//   creditUnitLabel(kind, { short? })        "credit dev" | "credit demo" | "credit" | "credit seedvis" | "credit dev
//                                            seedvis"; short: "cr".
//   formatVnd(credits)                       "1.234.000đ" (1 credit ≈ 1.000đ; meaningful for canvasapp — and its
//                                            simulation — only).
//   CREDIT_SOURCE_LABEL[kind]                "credit dev" | "credit demo" | "credit canvasapp" | "credit seedvis" |
//                                            "credit dev seedvis".
//   DEV_CREDIT_HINT                          tooltip for every dev amount: "Credit giả lập của chế độ Phát triển — …".
//   SEEDVIS_DEV_CREDIT_HINT                  tooltip for every simulated seedvis amount.
//   DEMO_CREDIT_HINT                         tooltip for every demo amount: "Credit giả lập — không phải tiền thật".
//   CREDIT_HINT[kind]                        the tooltip of a kind (canvasapp / seedvis: null).
//   CREDIT_MARK[kind]                        small mark next to a short fake amount ("20 cr" + "dev" / "demo");
//                                            null for real canvasapp / seedvis credits.
//   DEMO_CREDITS_DEFAULT                     1000: demo balance of NEW runs data (store/runs; saved balances are kept).
//   chargedDemo(take)                        the take was paid with demo credits (so a failure/cancel refunds them).
//                                            Always false for dev / canvasapp / seedvis takes.
import type { Take } from '../core/types'
import { providerOf, type ProviderId } from '../providers/types'

export type CreditKind = 'demo' | 'canvasapp' | 'dev' | 'seedvis' | 'seedvis-dev'

/** Demo balance of new runs data (and what "Đặt lại credit demo" sets). */
export const DEMO_CREDITS_DEFAULT = 1000

/** 1 canvasapp credit ≈ 1.000đ (docs/canvasapp-api-notes.md). */
export const VND_PER_CREDIT = 1000

export const DEMO_CREDIT_HINT = 'Credit giả lập — không phải tiền thật'
export const DEV_CREDIT_HINT = 'Credit giả lập của chế độ Phát triển — không phải tiền thật'
export const SEEDVIS_DEV_CREDIT_HINT = 'Credit giả lập của seedvis giả lập (chế độ Phát triển) — không phải tiền thật'

export const CREDIT_HINT: Record<CreditKind, string | null> = {
  demo: DEMO_CREDIT_HINT,
  dev: DEV_CREDIT_HINT,
  canvasapp: null,
  seedvis: null,
  'seedvis-dev': SEEDVIS_DEV_CREDIT_HINT,
}

export const CREDIT_SOURCE_LABEL: Record<CreditKind, string> = {
  demo: 'credit demo',
  dev: 'credit dev',
  canvasapp: 'credit canvasapp',
  seedvis: 'credit seedvis',
  'seedvis-dev': 'credit dev seedvis',
}

/** Small mark drawn next to a short simulated amount ("20 cr dev"), so it is never taken for real credits. */
export const CREDIT_MARK: Record<CreditKind, string | null> = { demo: 'demo', dev: 'dev', canvasapp: null, seedvis: null, 'seedvis-dev': 'dev' }

/** The wallet each provider's takes are paid from. A full Record: a new provider never falls back to another wallet. */
export const CREDIT_KIND_OF: Readonly<Record<ProviderId, CreditKind>> = { mock: 'demo', dev: 'dev', canvasapp: 'canvasapp', 'seedvis-dev': 'seedvis-dev', seedvis: 'seedvis' }

/** The wallet of a provider (an id this build does not know — never a ProviderId at run time — counts as the old demo). */
export const creditKindOf = (provider: ProviderId): CreditKind => CREDIT_KIND_OF[provider] ?? 'demo'

const SIMULATED: Readonly<Record<CreditKind, boolean>> = { demo: true, dev: true, canvasapp: false, seedvis: false, 'seedvis-dev': true }

/** Not real money: development-mode or old-demo credits. */
export const isSimulatedCredit = (kind: CreditKind): boolean => SIMULATED[kind] ?? true

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

/** The unit after an amount (canvasapp's real credits are the bare "credit": 1 credit ≈ 1.000đ). */
const CREDIT_UNIT: Readonly<Record<CreditKind, string>> = {
  demo: 'credit demo',
  dev: 'credit dev',
  canvasapp: 'credit',
  seedvis: 'credit seedvis',
  'seedvis-dev': 'credit dev seedvis',
}

export function creditUnitLabel(kind: CreditKind, opts: CreditFormatOptions = {}): string {
  if (opts.short) return 'cr'
  return CREDIT_UNIT[kind] ?? 'credit'
}

/** "20 credit dev" | "20 credit demo" | "20 credit" | "20 credit seedvis" | short "20 cr". Unknown amount → "—". */
export function formatCredits(n: number | null | undefined, kind: CreditKind, opts: CreditFormatOptions = {}): string {
  if (!known(n)) return UNKNOWN
  return `${formatCreditNumber(n)} ${creditUnitLabel(kind, opts)}`
}

/** Approximate value in đồng: "1.234.000đ". Unknown → "—". */
export function formatVnd(credits: number | null | undefined): string {
  if (!known(credits)) return UNKNOWN
  return `${formatCreditNumber(Math.round(credits * VND_PER_CREDIT))}đ`
}

/** Paid with demo credits (refunded on failure / cancel). Old takes without the field: yes. Every other provider: never. */
export function chargedDemo(t: Pick<Take, 'provider' | 'charged'>): boolean {
  return providerOf(t) === 'mock' && t.charged !== false
}
