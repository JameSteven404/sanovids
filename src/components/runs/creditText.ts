// Credit wording for the runs area (queue rows, take strip, take viewer, run dialog) — pure, tested in
// __tests__/creditText.test.ts. docs/SPEC-v2.md §9, §11: 'dev' credits are the simulated canvasapp account of
// development mode (fake, billed by the simulation when it accepts the job); canvasapp credits are the user's real
// account, billed by canvasapp when it accepts the job; 'demo' credits are the old demo's play money (refunded on
// failure / cancel by SanoVids itself).
import type { Take } from '../../core/types'
import { chargedDemo, creditKindOf, formatCredits, type CreditKind } from '../../lib/credits'
import { PROVIDER_LABEL } from '../../providers'
import { providerOf, type ProviderId } from '../../providers/types'
import { isUncertainSubmit } from '../../store/runs'
import { takeCostInferred, takeCostKnown } from './importedTake'

/** Wallet a take was paid from: its provider decides, never the provider chosen now. */
export const takeCreditKind = (t: Pick<Take, 'provider'>): CreditKind => creditKindOf(providerOf(t))

/**
 * "20 credit dev" | "20 credit demo" | "20 credit canvasapp" — a take's cost naming its wallet (tooltips, toasts).
 * "—" when it is not known (an imported take whose resolution / duration canvasapp did not say); "≈ …" on a guess.
 */
export function takeCostLabel(t: Pick<Take, 'provider' | 'cost'> & Partial<Pick<Take, 'imported'>>): string {
  const kind = takeCreditKind(t)
  const amount = formatCredits(takeCostKnown(t), kind)
  const said = kind === 'canvasapp' && amount !== '—' ? `${amount} canvasapp` : amount
  return said !== '—' && takeCostInferred(t) ? `≈ ${said}` : said
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
  /** The site by name: "canvasapp" | "canvasapp giả lập". */
  siteName: string
}

export const GATEWAY_WORDS: Record<'canvasapp' | 'dev', GatewayWords> = {
  canvasapp: { credit: 'credit canvasapp', site: 'canvasapp', check: 'kiểm tra trên canvasapp.io.vn', approx: true, paidNote: '', siteName: 'canvasapp' },
  dev: {
    credit: 'credit dev',
    site: 'máy chủ giả lập',
    check: 'kiểm tra trong Bảng phát triển',
    approx: false,
    paidNote: ' (giả lập, không phải tiền thật)',
    siteName: 'canvasapp giả lập',
  },
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

type CostTake = Pick<Take, 'provider' | 'charged' | 'cost' | 'status' | 'remoteId' | 'error'> & Partial<Pick<Take, 'startedAt' | 'submitUnknown' | 'imported'>>

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
  if (t.imported) {
    // made on the site, outside SanoVids: paid there when it was made; importing it costs nothing
    const known = formatCredits(takeCostKnown(t), kind)
    return {
      kind,
      amount: known === '—' || !(w.approx || takeCostInferred(t)) ? known : `≈ ${known}`,
      note: `trả trên ${w.siteName} khi tạo job (ngoài SanoVids) — nhập không trừ thêm`,
      struck: false,
    }
  }
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

// ---- "Huỷ" of a running take (actions.cancelTake: queue row, Xem take) ----

/** What "Huỷ" concerns, read at click time. */
export interface CancelFacts {
  /** "S03·T2" */
  label: string
  provider: ProviderId
  status: 'queued' | 'processing'
  cost: number
  /** Paid with old demo credits (SanoVids refunds them). */
  demoPaid: boolean
  /** The site has the job (it runs there, or is done). */
  sentAway: boolean
  /** The site's job is finished (paid) and SanoVids is downloading its video, or waits to try again (runs.remoteVideoReady). */
  videoReady: boolean
  /** Imported ("Nhập job"): the job was made on the site's own page, not sent by SanoVids. */
  imported?: boolean
}

/**
 * The question before "Huỷ" drops a video that is already made and paid (null = nothing to ask): cancelling only
 * stops SanoVids tracking the take — the video stays on the site, re-running the scene pays again.
 */
export function cancelQuestion(f: CancelFacts): string | null {
  if (!f.videoReady || f.status !== 'processing' || f.provider === 'mock') return null
  return f.provider === 'dev'
    ? `${f.label}: video đã tạo xong trên canvasapp giả lập và đã trừ credit dev — SanoVids chưa tải về xong.\nHuỷ sẽ bỏ video này trong SanoVids (job vẫn còn trong Bảng phát triển); chạy lại cảnh sẽ trừ credit dev lần nữa.\nVẫn huỷ?`
    : `${f.label}: video đã tạo xong trên canvasapp và đã trừ credit — SanoVids chưa tải về xong.\nHuỷ sẽ bỏ video này trong SanoVids (vẫn tải được trên canvasapp.io.vn, phiên “SanoVids bridge”); chạy lại cảnh sẽ trừ credit lần nữa.\nVẫn huỷ?`
}

/** The toast once "Huỷ" went through. */
export function cancelToastText(f: CancelFacts): { text: string; warning: boolean } {
  // development mode: "canvasapp giả lập" / "credit dev" (never the mode's own label)
  const site = f.provider === 'dev' ? GATEWAY_WORDS.dev.siteName : PROVIDER_LABEL[f.provider]
  const credit = f.provider === 'dev' ? GATEWAY_WORDS.dev.credit : 'credit'
  if (f.demoPaid) return { text: `Đã huỷ ${f.label} · hoàn ${formatCredits(f.cost, 'demo')}.`, warning: false }
  if (f.videoReady && f.status === 'processing' && f.provider !== 'mock') {
    return {
      text:
        f.provider === 'dev'
          ? `Đã huỷ ${f.label} trong SanoVids — video đã tạo xong (đã trừ credit dev) không được tải về; job vẫn còn trong Bảng phát triển.`
          : `Đã huỷ ${f.label} trong SanoVids — video đã tạo xong (đã trừ credit) không được tải về; vẫn tải được trên canvasapp.io.vn.`,
      warning: true,
    }
  }
  if (f.sentAway && f.imported) return { text: `Đã ngừng theo dõi ${f.label} trong SanoVids — job tạo trên ${site} vẫn chạy ở đó.`, warning: true }
  if (f.sentAway) return { text: `Đã huỷ ${f.label} trong SanoVids — job đã gửi sang ${site} vẫn chạy ở đó.`, warning: true }
  // The request was on its way (no remote id yet): the provider may still accept — and bill — it (see takeCostLine).
  if (f.status === 'processing') return { text: `Đã huỷ ${f.label} lúc đang gửi sang ${site} — nếu job đã được nhận thì có thể đã trừ ${credit}.`, warning: true }
  return { text: `Đã huỷ ${f.label}.`, warning: false }
}
