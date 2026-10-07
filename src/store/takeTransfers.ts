// Download progress of finished videos (the queue engine's finishTake → provider.fetchResult onProgress). Not saved,
// not undoable: it only exists while a download runs, and is cleared when it ends (completed, failed, aborted) or the
// engine restarts (loadRuns). The take node / Xem take show "Đang tải về 45%" instead of "Đang tạo 99%".
//
// ---- API ----
//   useTakeTransfers                 zustand store { byTake: { [takeId]: { received, total } } } — select one take's
//                                    label / percent with the pure helpers below (they return primitives: stable).
//   reportTakeTransfer(id, p)        set a take's progress (the provider throttles it).
//   clearTakeTransfer(id) / clearTakeTransfers()
//   transferPercent(t) / transferLabel(t)   0–99 (null when the size is unknown) / "Đang tải về 45%" | "Đang tải về 12,3 MB".
import { create } from 'zustand'

export interface TakeTransfer {
  received: number
  /** Whole size, null = the provider did not say. */
  total: number | null
}

interface TakeTransfersState {
  byTake: Record<string, TakeTransfer>
}

export const useTakeTransfers = create<TakeTransfersState>()(() => ({ byTake: {} }))

const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

export function reportTakeTransfer(takeId: string, p: { received: number; total: number | null }): void {
  if (!valid(p?.received)) return
  const total = valid(p.total) && p.total > 0 ? p.total : null
  const cur = useTakeTransfers.getState().byTake[takeId]
  if (cur && cur.received === p.received && cur.total === total) return
  useTakeTransfers.setState((s) => ({ byTake: { ...s.byTake, [takeId]: { received: p.received, total } } }))
}

export function clearTakeTransfer(takeId: string): void {
  if (!(takeId in useTakeTransfers.getState().byTake)) return
  useTakeTransfers.setState((s) => {
    const next = { ...s.byTake }
    delete next[takeId]
    return { byTake: next }
  })
}

export function clearTakeTransfers(): void {
  if (Object.keys(useTakeTransfers.getState().byTake).length) useTakeTransfers.setState({ byTake: {} })
}

/** 0–99 while it downloads (100 only once the take is completed); null when the size is unknown or nothing runs. */
export function transferPercent(t: TakeTransfer | undefined): number | null {
  if (!t || t.total === null || t.total <= 0) return null
  return Math.max(0, Math.min(99, Math.floor((t.received * 100) / t.total)))
}

/** "12,3" (MB, one decimal, decimal comma). */
export function formatMegabytes(bytes: number): string {
  return (Math.floor(bytes / 104_857.6) / 10).toFixed(1).replace('.', ',')
}

/** "Đang tải về 45%" / "Đang tải về 12,3 MB" (size unknown); null when no download runs for the take. */
export function transferLabel(t: TakeTransfer | undefined): string | null {
  if (!t) return null
  const pct = transferPercent(t)
  return pct !== null ? `Đang tải về ${pct}%` : `Đang tải về ${formatMegabytes(t.received)} MB`
}
