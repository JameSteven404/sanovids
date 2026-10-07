import { SEEDVIS_API_BASE, SEEDVIS_IPC_LIMITS, SEEDVIS_IPC_ROUTES, type SeedvisIpcRoute } from '../../seedvis/contract'

// The desktop parity test can import this without starting the simulation.
export const SEEDVIS_DEV_ROUTES = SEEDVIS_IPC_ROUTES
export const SEEDVIS_ID_RE = /^[A-Za-z0-9_-]{1,100}$/

export interface SeedvisRouteMatch { endpoint: SeedvisIpcRoute; id?: string }

/** Only canonical API paths; do not normalize traversal, escapes or a foreign origin. */
export function matchSeedvisRoute(method: string, path: unknown): SeedvisRouteMatch | null {
  if (typeof path !== 'string' || path.length > SEEDVIS_IPC_LIMITS.pathChars) return null
  for (const [endpoint, route] of Object.entries(SEEDVIS_DEV_ROUTES)) {
    if (method !== route.method) continue
    const template = SEEDVIS_API_BASE + route.path
    if (!template.includes('{id}')) {
      if (path === template) return { endpoint: endpoint as SeedvisIpcRoute }
      continue
    }
    const [prefix, suffix] = template.split('{id}')
    // An omitted wait is allowed; any supplied value must be exactly wait=0.
    for (const tail of suffix === '?wait=0' ? [suffix, ''] : [suffix]) {
      if (!path.startsWith(prefix) || !path.endsWith(tail)) continue
      const id = path.slice(prefix.length, tail ? -tail.length : undefined)
      if (SEEDVIS_ID_RE.test(id)) return { endpoint: endpoint as SeedvisIpcRoute, id }
    }
  }
  return null
}
