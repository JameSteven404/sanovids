// Development-mode wording. The real gateway code (providers/canvasapp: api.ts, adapter.ts) writes its messages for
// canvasapp.io.vn and sometimes sends the user there ("Kiểm tra trên canvasapp.io.vn"). A 'dev' take never reached
// that site: the dev API client and the dev provider are wrapped (providers/index.ts) so every message they produce
// names the simulation and points to the Bảng phát triển instead. Pure, no stores.
//
// ---- API ----
//   devWording(text)              the message, rewritten for development mode (idempotent).
//   devError(e)                   the same error with its message rewritten (codes / flags kept), anything else as is.
//   withDevWording(obj, results?) a copy of `obj` whose methods throw devError(…) and (for the listed ones) return
//                                 their result through `results[name]`.

import { LOOKUP_FAILED_TEXT, STILL_SENDING_TEXT } from '../canvasapp/adapter'

/**
 * Whole sentences of the real gateway that say "trên canvasapp" and "credit" without the site's address: the reasons a
 * "Chạy lại" was held back, shown right after the dev "không rõ" text (runs.heldBackSubmitError) — said for the
 * simulation and its credit dev, never mixed with the real site's.
 */
const DEV_SENTENCES: [string, string][] = [STILL_SENDING_TEXT, LOOKUP_FAILED_TEXT].map((t) => [
  t,
  t.replace('trên canvasapp', 'trên canvasapp giả lập').replace(/credit/g, 'credit dev'),
])

/**
 * "Kiểm tra trên canvasapp.io.vn" → "Kiểm tra trong Bảng phát triển"; any other "canvasapp.io.vn" → "canvasapp giả lập";
 * the held-back reasons (DEV_SENTENCES) → their development-mode words.
 */
export function devWording(text: string): string {
  let out = text
  for (const [real, dev] of DEV_SENTENCES) out = out.split(real).join(dev)
  return out.replace(/([Kk])iểm tra trên canvasapp\.io\.vn/g, '$1iểm tra trong Bảng phát triển').replace(/canvasapp\.io\.vn/g, 'canvasapp giả lập')
}

/** The error with a development-mode message (same object: its code, status and flags stay). */
export function devError(e: unknown): unknown {
  if (e instanceof Error && typeof e.message === 'string') {
    const message = devWording(e.message)
    if (message !== e.message) {
      try {
        e.message = message
      } catch {
        /* a frozen error keeps its words */
      }
    }
  }
  return e
}

/** A provider's answer with its `error` / `reason` texts in development-mode words (arrays item by item). */
export function devResult(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(devResult)
  if (!v || typeof v !== 'object' || (typeof Blob !== 'undefined' && v instanceof Blob)) return v
  const o = v as Record<string, unknown>
  if (typeof o.error !== 'string' && typeof o.reason !== 'string') return v
  return {
    ...o,
    ...(typeof o.error === 'string' ? { error: devWording(o.error) } : {}),
    ...(typeof o.reason === 'string' ? { reason: devWording(o.reason) } : {}),
  }
}

/**
 * A copy of `target` (an object of functions, like the API client or the adapter) whose methods rethrow errors in
 * development-mode words; `results` maps the answers of the listed methods (e.g. poll → devResult).
 */
export function withDevWording<T extends object>(target: T, results: Partial<Record<keyof T, (v: unknown) => unknown>> = {}): T {
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) }
  for (const [name, fn] of Object.entries(target as Record<string, unknown>)) {
    if (typeof fn !== 'function') continue
    const map = (results as Record<string, ((v: unknown) => unknown) | undefined>)[name]
    out[name] = (...args: unknown[]) => {
      let r: unknown
      try {
        r = (fn as (...a: unknown[]) => unknown).apply(target, args)
      } catch (e) {
        throw devError(e)
      }
      if (r && typeof (r as PromiseLike<unknown>).then === 'function') {
        return Promise.resolve(r).then(
          (v) => (map ? map(v) : v),
          (e: unknown) => {
            throw devError(e)
          },
        )
      }
      return map ? map(r) : r
    }
  }
  return out as T
}
