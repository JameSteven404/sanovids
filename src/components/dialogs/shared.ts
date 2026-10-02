// Small helpers shared by the dialogs (dg-).
import { WEB_UNAVAILABLE } from '../../providers/canvasapp/transport'
import type { RealCreditsState } from '../../store/credits'

/** Readable Vietnamese message for a failed data operation (a broken file throws a JSON SyntaxError). */
export function errorText(e: unknown): string {
  if (e instanceof SyntaxError) return 'File không đúng định dạng .sanovids.json / .bdp.json (không đọc được JSON).'
  if (e instanceof Error && e.message) return e.message
  return 'Có lỗi xảy ra, chưa làm được.'
}

/** What the canvasapp gateway section shows about the account (GatewaySection). */
export type GatewayLogin =
  | { state: 'checking' }
  | { state: 'in'; credits: number; /** Why the number may be old (last refresh failed), else null. */ stale: string | null }
  | { state: 'out' }
  | { state: 'error'; message: string }

export type GatewayCreditsView = Pick<RealCreditsState, 'balance' | 'status' | 'error' | 'refreshing' | 'updatedAt'>

/**
 * Login state from the shared real-credit store (store/credits useRealCredits — GET /api/me): a confirmed balance
 * means logged in, 401 means logged out. A failed refresh after a good read keeps "logged in" with the last number.
 */
export function gatewayLoginFromCredits(real: GatewayCreditsView): GatewayLogin {
  switch (real.status) {
    case 'ok':
      return real.balance === null ? { state: 'checking' } : { state: 'in', credits: real.balance, stale: null }
    case 'login-required':
      return { state: 'out' }
    case 'error':
      return real.balance !== null
        ? { state: 'in', credits: real.balance, stale: real.error ?? 'Không cập nhật được số credit.' }
        : { state: 'error', message: real.error ?? 'Không kiểm tra được trạng thái.' }
    case 'unavailable':
      return { state: 'error', message: real.error ?? WEB_UNAVAILABLE }
    default:
      return { state: 'checking' }
  }
}
