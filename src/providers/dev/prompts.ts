// The two "windows" of the desktop gateway, simulated in-app for development mode: canvasapp's login page and the SePay
// checkout page. No React here: the dev bridge opens a prompt in this zustand store and waits; the dev UI renders the
// open prompt as a sheet and answers it with answerDevLogin / answerDevCheckout.
//
// ---- API for the UI ----
//   useDevPrompts                       zustand store DevPromptsState { login, checkout } (null = closed).
//   answerDevLogin(accept)              "Đăng nhập (giả lập)" (true) or closing the sheet (false).
//   answerDevCheckout(choice, opts?)    choice 'success' | 'cancel' | 'error' | 'closed' — the buttons
//                                       "Thanh toán thành công" / "Huỷ" / "Lỗi thanh toán" / "Đóng cửa sổ".
//                                       opts.outcome: what the simulated canvasapp then says about the order
//                                       ('paid' default for success, 'none' otherwise = stays pending → expires;
//                                       also 'reconcile_required' | 'rejected' | 'expired'; 'paid' with 'closed' =
//                                       "paid on the phone, then closed the window"). opts.delayMs: when canvasapp
//                                       flips the order (default DEV_PAYMENT_DELAY_MS = 2 s, so the polling path runs).
// ---- For the bridge ----
//   openLoginPrompt(), openCheckoutPrompt(info), closeDevPrompts()
import { create } from 'zustand'

/** canvasapp marks a paid order this long after SePay's success (the app's status polling must see "pending" first). */
export const DEV_PAYMENT_DELAY_MS = 2_000

/** What the simulated canvasapp says about the order afterwards. 'none' = nothing (it stays pending, then expires). */
export type DevTopupOutcome = 'paid' | 'reconcile_required' | 'rejected' | 'expired' | 'none'
export type DevCheckoutChoice = 'success' | 'cancel' | 'error' | 'closed'

export const DEV_CHECKOUT_CHOICE_LABEL: Record<DevCheckoutChoice, string> = {
  success: 'Thanh toán thành công',
  cancel: 'Huỷ',
  error: 'Lỗi thanh toán',
  closed: 'Đóng cửa sổ',
}

export const DEV_TOPUP_OUTCOME_LABEL: Record<DevTopupOutcome, string> = {
  paid: 'canvasapp ghi nhận đã thanh toán',
  reconcile_required: 'canvasapp cần đối soát',
  rejected: 'canvasapp từ chối',
  expired: 'Đơn hết hạn',
  none: 'Không có gì (đơn vẫn chờ)',
}

export interface DevLoginPrompt {
  id: number
  openedAt: number
}

export interface DevCheckoutPrompt {
  id: number
  openedAt: number
  /** The order this checkout pays (from the checkout URL); null when unknown. */
  orderId: string | null
  amountVnd: number | null
  /** amountVnd / 1.000 */
  credits: number | null
  checkoutUrl: string
  /** The form fields canvasapp returned (shown read-only, like the hidden form the real page posts). */
  fields: Record<string, string>
  /** When the window closes by itself (15 min, like electron/main.cjs). */
  timeoutAt: number
}

export interface DevPromptsState {
  login: DevLoginPrompt | null
  checkout: DevCheckoutPrompt | null
}

export interface DevCheckoutAnswer {
  choice: DevCheckoutChoice | 'timeout'
  outcome: DevTopupOutcome
  delayMs: number
}

export const useDevPrompts = create<DevPromptsState>()(() => ({ login: null, checkout: null }))

let seq = 0
let loginWaiters: ((accepted: boolean) => void)[] = []
let checkoutWaiter: ((a: DevCheckoutAnswer) => void) | null = null

/** Opens (or joins) the simulated login page. Resolves true when the user logs in, false when it is closed. */
export function openLoginPrompt(now: number = Date.now()): Promise<boolean> {
  if (!useDevPrompts.getState().login) useDevPrompts.setState({ login: { id: ++seq, openedAt: now } })
  return new Promise<boolean>((resolve) => loginWaiters.push(resolve))
}

export function answerDevLogin(accept: boolean): void {
  const waiters = loginWaiters
  loginWaiters = []
  useDevPrompts.setState({ login: null })
  for (const w of waiters) w(accept)
}

/** Whether a checkout page is open (the real gateway answers 'busy' to a second one). */
export const checkoutPromptOpen = () => useDevPrompts.getState().checkout !== null

/** Opens the simulated SePay page. Resolves with the user's choice. The caller checks checkoutPromptOpen() first. */
export function openCheckoutPrompt(info: Omit<DevCheckoutPrompt, 'id'>): Promise<DevCheckoutAnswer> {
  useDevPrompts.setState({ checkout: { ...info, id: ++seq } })
  return new Promise<DevCheckoutAnswer>((resolve) => {
    checkoutWaiter = resolve
  })
}

export function answerDevCheckout(choice: DevCheckoutChoice | 'timeout', opts: { outcome?: DevTopupOutcome; delayMs?: number } = {}): void {
  const w = checkoutWaiter
  checkoutWaiter = null
  useDevPrompts.setState({ checkout: null })
  const outcome = opts.outcome ?? (choice === 'success' ? 'paid' : 'none')
  const delayMs = Math.max(0, opts.delayMs ?? DEV_PAYMENT_DELAY_MS)
  w?.({ choice, outcome, delayMs })
}

/** Logout / reset: the login page resolves "not logged in", the checkout page "closed" (nothing paid). */
export function closeDevPrompts(): void {
  if (useDevPrompts.getState().login || loginWaiters.length) answerDevLogin(false)
  if (useDevPrompts.getState().checkout || checkoutWaiter) answerDevCheckout('closed', { outcome: 'none' })
}
