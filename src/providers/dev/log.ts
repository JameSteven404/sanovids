// Request log of the dev server (development mode): every request the app sent to the simulated canvasapp, with the
// answer, the time it took and the fault that was applied. In memory only (a ring of DEV_LOG_MAX entries), exposed as
// a zustand store for the dev UI. Never holds blobs: uploads / videos are logged as their size, long strings are cut.
//
// ---- API ----
//   useDevLog                    zustand store { entries: DevLogEntry[] } (oldest first, newest last).
//   clearDevLog()                empty it.
//   pushDevLog(entry)            add one (the server / bridge do it); returns the stored entry.
//   summarizeForLog(value)       JSON-safe copy for the log (strings ≤ 300 chars, arrays ≤ 40 items, depth ≤ 6).
import { create } from 'zustand'
import type { DevEndpoint } from './routes'

export const DEV_LOG_MAX = 300
const MAX_STRING = 300
const MAX_ITEMS = 40
const MAX_DEPTH = 6

export interface DevLogEntry {
  /** Increasing id (stable React key). */
  id: number
  /** When the request arrived (ms since epoch). */
  at: number
  method: string
  /** Path + query as sent ("/api/video-jobs?project_id=…"). */
  path: string
  /** Endpoint name (routes.ts), null when the path is not on the allowlist. */
  endpoint: DevEndpoint | null
  /** HTTP status of the answer the app got; null = no answer (network fault / refused by the gateway). */
  status: number | null
  /** Time until the answer (ms), latency and 'slow' faults included. */
  ms: number
  /** Request body (summarized); multipart → { field, filename, contentType, bytes }. */
  req: unknown
  /** Response body (summarized); binary → { bytes, contentType }. */
  res: unknown
  /** Fault applied ("network", "lost-response", "processed-then 502", "response 402", "slow 3000ms", "not-allowed"…), else null. */
  fault: string | null
  /** The server handled the request (state may have changed) even when the app got no / another answer. */
  processed: boolean
  /** Short Vietnamese note (e.g. "trừ 20 credit", "job lỗi theo kịch bản"). */
  note?: string
}

export interface DevLogState {
  entries: DevLogEntry[]
}

export const useDevLog = create<DevLogState>()(() => ({ entries: [] }))

let nextId = 1

export function pushDevLog(entry: Omit<DevLogEntry, 'id'>): DevLogEntry {
  const full: DevLogEntry = { ...entry, id: nextId++ }
  useDevLog.setState((s) => {
    const entries = s.entries.length >= DEV_LOG_MAX ? s.entries.slice(s.entries.length - DEV_LOG_MAX + 1) : s.entries.slice()
    entries.push(full)
    return { entries }
  })
  return full
}

export function clearDevLog(): void {
  useDevLog.setState({ entries: [] })
}

/** A JSON-safe, size-bounded copy for the log: long strings cut, big arrays / deep objects summarized, bytes as sizes. */
export function summarizeForLog(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (+${value.length - MAX_STRING} ký tự)` : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`
  if (typeof Blob !== 'undefined' && value instanceof Blob) return `[blob ${value.type || '?'} ${value.size} bytes]`
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[${value.length} mục]` : '{…}'
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ITEMS).map((v) => summarizeForLog(v, depth + 1))
    return value.length > MAX_ITEMS ? [...head, `… (+${value.length - MAX_ITEMS} mục)`] : head
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = summarizeForLog(v, depth + 1)
    return out
  }
  return String(value)
}
