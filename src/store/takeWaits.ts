// Why a queued take waits, and until when: its provider deferred the submit (nothing sent) — e.g. another take of its
// scene was just sent without a known answer (canvasapp RIVAL_PENDING_TEXT), or the bridge canvas has no room
// (CANVAS_FULL_TEXT). Not saved, not undoable. Set by the queue engine (store/runs submitTake), which does not start the
// take before `until`; cleared when that time has come (the take is tried again), when it is cancelled / deleted, when
// the engine restarts (loadRuns), and for every take of a provider whose state was wiped (resetDevMode →
// clearTakeWaits('dev')). The take node, the queue and Xem take show it next to "Đang chờ".
//
// ---- API ----
//   useTakeWaits                         zustand store { byTake: { [takeId]: { until, why, provider } } } — select one
//                                        take's entry (an existing object or undefined: stable).
//   setTakeWait(id, wait) / clearTakeWait(id) / clearTakeWaits(provider?)
//   takeWaitUntil(id)                    the time before which the engine does not start it (null = none).
//   waitLabel(w) / waitText(w)           "Chờ tới 14:32" / "Chờ tới 14:32 — <why>" (pure; null without a wait).
import { create } from 'zustand'
import type { ProviderId } from '../providers/types'

export interface TakeWait {
  /** Local time before which the take is not tried again. */
  until: number
  /** The provider's words (what was not done, and why). */
  why: string
  provider: ProviderId
}

interface TakeWaitsState {
  byTake: Record<string, TakeWait>
}

export const useTakeWaits = create<TakeWaitsState>()(() => ({ byTake: {} }))

export function setTakeWait(takeId: string, wait: TakeWait): void {
  if (!Number.isFinite(wait.until)) return
  useTakeWaits.setState((s) => ({ byTake: { ...s.byTake, [takeId]: { until: wait.until, why: wait.why.trim(), provider: wait.provider } } }))
}

export function clearTakeWait(takeId: string): void {
  if (!(takeId in useTakeWaits.getState().byTake)) return
  useTakeWaits.setState((s) => {
    const next = { ...s.byTake }
    delete next[takeId]
    return { byTake: next }
  })
}

/** Every wait (the engine restarts), or only those of one provider (its state was wiped: the reason may be gone). */
export function clearTakeWaits(provider?: ProviderId): void {
  const all = useTakeWaits.getState().byTake
  const keep = provider ? Object.fromEntries(Object.entries(all).filter(([, w]) => w.provider !== provider)) : {}
  if (Object.keys(keep).length !== Object.keys(all).length) useTakeWaits.setState({ byTake: keep })
}

export function takeWaitUntil(takeId: string): number | null {
  return useTakeWaits.getState().byTake[takeId]?.until ?? null
}

const two = (n: number) => String(n).padStart(2, '0')

/** "Chờ tới 14:32" (local time, rounded up to the minute: never earlier than the take is tried again). */
export function waitLabel(w: TakeWait | undefined): string | null {
  if (!w) return null
  const d = new Date(Math.ceil(w.until / 60_000) * 60_000)
  return `Chờ tới ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** "Chờ tới 14:32 — <why>" for a tooltip / the queue row. */
export function waitText(w: TakeWait | undefined): string | null {
  const label = waitLabel(w)
  if (!label || !w) return null
  return w.why ? `${label} — ${w.why}` : label
}
