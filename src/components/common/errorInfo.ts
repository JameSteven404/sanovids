// Pure helpers for SectionBoundary (ErrorBoundary.tsx). Covered by ./__tests__/errorInfo.test.ts.

/**
 * A lazy chunk could not be loaded (offline on first visit, or a new version replaced the files). React.lazy keeps
 * the failed promise, so only a page reload helps.
 */
export function isChunkLoadError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const { name, message } = e as { name?: unknown; message?: unknown }
  const text = `${typeof name === 'string' ? name : ''} ${typeof message === 'string' ? message : ''}`
  return /ChunkLoadError|dynamically imported module|Importing a module script failed|Loading (CSS )?chunk|Unable to preload CSS/i.test(text)
}

/** Short, single-line description of a caught error for the fallback (details stay in the console). */
export function errorSummary(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : typeof e === 'string' ? e : 'Lỗi không xác định'
  const line = raw.split('\n')[0].trim()
  return line.length > 180 ? line.slice(0, 179) + '…' : line
}
