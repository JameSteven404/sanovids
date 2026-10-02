// Credit wording for the runs area (queue rows, take strip, take viewer, run dialog) — pure, tested in
// __tests__/creditText.test.ts. docs/SPEC-v2.md §9, §11: 'dev' credits are the simulated canvasapp account of
// development mode (fake, billed by the simulation when it accepts the job); canvasapp credits are the user's real
// account, billed by canvasapp when it accepts the job; 'demo' credits are the old demo's play money (refunded on
// failure / cancel by SanoVids itself).
import type { Take } from '../../core/types'
import { chargedDemo, creditKindOf, formatCredits, type CreditKind } from '../../lib/credits'
import { providerOf } from '../../providers/types'
import { isUncertainSubmit } from '../../store/runs'

/** Wallet a take was paid from: its provider decides, never the provider chosen now. */
export const takeCreditKind = (t: Pick<Take, 'provider'>): CreditKind => creditKindOf(providerOf(t))

/** "20 credit dev" | "20 credit demo" | "20 credit canvasapp" — a take's cost naming its wallet (tooltips, toasts). */
export function takeCostLabel(t: Pick<Take, 'provider' | 'cost'>): string {
  const kind = takeCreditKind(t)
  const amount = formatCredits(t.cost, kind)
  return kind === 'canvasapp' && amount !== '—' ? `${amount} canvasapp` : amount
}

/** How a gateway (the real canvasapp or its development-mode simulation) is named in the cost notes. */
export interface GatewayWords {
  /** "credit canvasapp" | "credit dev" */
  credit: string
  /** Who accepts / bills the job: "canvasapp" | "máy chủ giả lập". */
  site: string
  /** Where to check an uncertain charge. */
  check: string
  /** The amount is SanoVids' estimate of what the site bills ("≈ 20 credit"); the simulation bills the same table. */
  approx: boolean
  /** Extra words after "đã trả bằng …" ("" for real credits). */
  paidNote: string
}

export const GATEWAY_WORDS: Record<'canvasapp' | 'dev', GatewayWords> = {
  canvasapp: { credit: 'credit canvasapp', site: 'canvasapp', check: 'kiểm tra trên canvasapp.io.vn', approx: true, paidNote: '' },
  dev: { credit: 'credit dev', site: 'máy chủ giả lập', check: 'kiểm tra trong Bảng phát triển', approx: false, paidNote: ' (giả lập, không phải tiền thật)' },
}

export interface TakeCostLine {
  kind: CreditKind
  /** "20 credit demo" | "20 credit dev" | "≈ 20 credit" (canvasapp: SanoVids' estimate of what canvasapp bills). */
  amount: string
  /** How it was paid: "đã trả bằng credit demo" / "đã trả bằng credit dev" / "đã trả bằng credit canvasapp" / … */
  note: string
  /** Not (or no longer) paid: show the amount struck through. */
  struck: boolean
}

type CostTake = Pick<Take, 'provider' | 'charged' | 'cost' | 'status' | 'remoteId' | 'error'> & Partial<Pick<Take, 'startedAt' | 'submitUnknown'>>

/** Take viewer "Chi phí" line: the amount and which credits paid it (take.provider / take.charged / remoteId). */
export function takeCostLine(t: CostTake): TakeCostLine {
  const kind = takeCreditKind(t)
  const ended = t.status === 'failed' || t.status === 'cancelled'
  if (kind === 'demo') {
    const amount = formatCredits(t.cost, 'demo')
    if (!chargedDemo(t)) return { kind, amount, note: 'không trừ credit demo', struck: true }
    if (ended) return { kind, amount, note: 'đã trả bằng credit demo · đã hoàn lại', struck: true }
    return { kind, amount, note: 'đã trả bằng credit demo (giả lập, không phải tiền thật)', struck: false }
  }
  const w = GATEWAY_WORDS[kind]
  const est = formatCredits(t.cost, kind)
  const amount = est === '—' || !w.approx ? est : `≈ ${est}`
  if (t.remoteId) {
    return {
      kind,
      amount,
      note: ended ? `đã trả bằng ${w.credit} · hoàn hay không do ${w.site} quyết định` : `đã trả bằng ${w.credit}${w.paidNote}`,
      struck: false,
    }
  }
  // An earlier send of this take lost its answer: it may already be billed, whatever happened after (retry, cancel).
  if (t.submitUnknown && (t.status === 'queued' || t.status === 'processing')) {
    return { kind, amount, note: `${w.credit} · lần gửi trước không rõ đã bị trừ chưa — SanoVids tìm job cũ trước khi gửi lại`, struck: false }
  }
  if (isUncertainSubmit(t)) return { kind, amount, note: `${w.credit} · không rõ đã bị trừ chưa — ${w.check}`, struck: false }
  if (t.status === 'queued' || t.status === 'processing') return { kind, amount, note: `${w.credit} · trừ trên ${w.site} khi job được nhận`, struck: false }
  if (t.status === 'failed') return { kind, amount, note: `${w.site} không nhận job — không bị trừ credit`, struck: true }
  if (t.status === 'cancelled') {
    // Started (startedAt) but no remote id: cancelled while the request was on its way — the site may still have
    // accepted (and billed) it; store/runs then stops it there but never records its id. Never started: not sent.
    return t.startedAt
      ? { kind, amount, note: `huỷ lúc đang gửi sang ${w.site} — nếu ${w.site} đã nhận job thì có thể đã trừ credit, ${w.check}`, struck: false }
      : { kind, amount, note: `huỷ trước khi gửi sang ${w.site} — không bị trừ credit`, struck: true }
  }
  return { kind, amount, note: `đã trả bằng ${w.credit}${w.paidNote}`, struck: false }
}

export interface RunCostPreview {
  kind: CreditKind
  total: number
  /** Balance now; null = unknown (gateway not read yet / not logged in) → "—". */
  before: number | null
  /** Balance after the run (dev / canvasapp: an estimate — the site bills when it accepts each job). */
  after: number | null
  /** Demo only: not enough demo credits — the run is blocked (store/runs enqueue refuses it). */
  short: boolean
  /** canvasapp / dev: the last known gateway balance looks too small. A warning, never a block (the server decides). */
  mayBeShort: boolean
}

/** Run dialog numbers. Gateway runs (dev / canvasapp) are never blocked here, whatever the demo wallet holds. */
export function runCostPreview(kind: CreditKind, total: number, balance: number | null | undefined): RunCostPreview {
  const before = typeof balance === 'number' && Number.isFinite(balance) ? balance : null
  const after = before === null ? null : before - total
  const below = after !== null && after < 0
  return { kind, total, before, after, short: kind === 'demo' && below, mayBeShort: kind !== 'demo' && below }
}
