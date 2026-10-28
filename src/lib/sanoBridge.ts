// SanoVids inside SANO (D229 "Canvas", D230 "Trợ lý"): SANO frames SanoVids and, on every load of the frame, posts
// { source: 'sano', type: 'hello', features: ['assistant'] }. Framed, SanoVids shows a compact layout
// (<html data-embedded>, CSS only, so standalone SanoVids and its saved prefs never change) and, after a hello offering
// 'assistant', a "Trợ lý" button that posts { source: 'sanovids', type: 'open-assistant' } back to SANO.
// These two messages are the whole contract: nothing else is read, sent, evaluated or navigated to.
import { create } from 'zustand'

/** The parent's origin when framed: location.ancestorOrigins[0] (Chromium / Electron), never 'null' or file:. */
export function parentOriginOf(framed: boolean, ancestors: ArrayLike<string> | null | undefined): string | null {
  const origin = framed && ancestors?.length ? ancestors[0] : null
  return origin && origin !== 'null' && !origin.startsWith('file:') ? origin : null
}

/** The features of SANO's hello, or null when the message is anything else (other window, other origin, other shape). */
export function helloFeatures(e: { source: unknown; origin: string; data: unknown }, parent: unknown, origin: string | null): string[] | null {
  if (!origin || e.source !== parent || e.origin !== origin) return null
  const data = e.data as { source?: unknown; type?: unknown; features?: unknown } | null
  if (!data || typeof data !== 'object' || data.source !== 'sano' || data.type !== 'hello' || !Array.isArray(data.features)) return null
  return data.features.filter((f): f is string => typeof f === 'string')
}

export const OPEN_ASSISTANT = { source: 'sanovids', type: 'open-assistant' } as const

/** Asks SANO to open its project assistant; only ever to the parent's own origin (never '*'). */
export function postOpenAssistant(target: { postMessage(message: unknown, targetOrigin: string): void }, origin: string | null): boolean {
  if (!origin) return false
  target.postMessage(OPEN_ASSISTANT, origin)
  return true
}

export const EMBEDDED = typeof window !== 'undefined' && window.top !== window.self
// shortcut: Firefox has no location.ancestorOrigins, so no bridge (no "Trợ lý") there; SANO desktop is Chromium.
const PARENT_ORIGIN = parentOriginOf(EMBEDDED, EMBEDDED ? location.ancestorOrigins : null)

/** assistant: SANO's last hello offered its project assistant. */
export const useSanoBridge = create(() => ({ assistant: false }))

export function initSanoBridge(): void {
  if (!EMBEDDED) return
  document.documentElement.dataset.embedded = ''
  if (!PARENT_ORIGIN) return
  window.addEventListener('message', (e) => {
    const features = helloFeatures(e, window.parent, PARENT_ORIGIN)
    if (features) useSanoBridge.setState({ assistant: features.includes('assistant') })
  })
}

export const openSanoAssistant = (): boolean => postOpenAssistant(window.parent, PARENT_ORIGIN)
