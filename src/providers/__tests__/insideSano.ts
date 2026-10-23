// Inside the SANO app, for tests (providers/sano): the VITE_SANO_GATEWAY=1 web build in an iframe of a same-origin page.
// Undo with vi.unstubAllEnvs() and vi.unstubAllGlobals().
import { vi } from 'vitest'

export function stubInsideSano(win: object = {}): void {
  const location = { origin: 'https://sano.example' }
  vi.stubEnv('VITE_SANO_GATEWAY', '1')
  vi.stubGlobal('window', { location, ...win, parent: { location } })
}
