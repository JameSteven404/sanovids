// The app's ONE top-up flow (topupFlow.ts) wired to the ACTIVE gateway (providers/index activeGateway()): the real
// canvasapp gateway, or in development mode its in-app simulation (fake SePay sheet, fake credits, no network).
// Module-level on purpose: closing the "Nạp credit" sheet does not stop an order being confirmed, and reopening it
// shows the same order (and still refuses a second one while it is in flight).
//   - api: the gateway's API client. An order stays on the gateway it was created on (`flowGateway`), even if the
//     provider choice changes meanwhile.
//   - checkout: transport openCheckout(args, gateway.bridge) (refuses non-SePay URLs before the bridge; main / the
//     dev bridge re-check).
//   - the gateway said paid → refreshRealCredits({ force: true }) so every balance in the app moves.
//   - A final answer, or an error that stops the tracking, while the sheet is closed (or on the history tab) → a toast
//     with "Xem" to reopen it.
import { useStore } from 'zustand'
import { formatCreditNumber } from '../../lib/credits'
import { activeGateway, type Gateway } from '../../providers'
import { openCheckout } from '../../providers/canvasapp/transport'
import { refreshRealCredits } from '../../store/credits'
import { toast, useUI } from '../../store/ui'
import { createTopupFlow, type TopupFlowState } from './topupFlow'

function sheetShowsStatus(): boolean {
  const d = useUI.getState().dialog
  return d.kind === 'topup' && (d.tab ?? 'topup') === 'topup'
}

function reopenSheet() {
  useUI.getState().openDialog({ kind: 'topup', tab: 'topup' })
}

/** The gateway of the order in flight (set when an order is created); null = none → the active one. */
let orderGateway: Gateway | null = null

/** The gateway the top-up flow talks to: the order's, else the active one. */
export function flowGateway(): Gateway {
  return orderGateway ?? activeGateway()
}

function announce(s: TopupFlowState) {
  if (s.phase === 'paid') void refreshRealCredits({ force: true })
  if (sheetShowsStatus()) return
  const action = { label: 'Xem', run: reopenSheet }
  const account = flowGateway().simulated ? 'tài khoản giả lập (chế độ phát triển)' : 'tài khoản canvasapp'
  switch (s.phase) {
    case 'paid': {
      const credits = s.paidCredits ?? s.credits
      toast(credits !== null ? `Nạp credit thành công: +${formatCreditNumber(credits)} credit vào ${account}.` : 'Nạp credit thành công.', {
        tone: 'success',
        ms: 8000,
        action,
      })
      return
    }
    case 'review':
      toast('canvasapp đang đối soát giao dịch nạp credit — credit sẽ được cộng sau khi kiểm tra.', { tone: 'warning', ms: 10000, action })
      return
    case 'expired':
      toast('Đơn nạp credit đã hết hạn.', { tone: 'warning', ms: 8000, action })
      return
    case 'rejected':
      toast('Thanh toán nạp credit bị từ chối.', { tone: 'error', ms: 8000, action })
      return
    default:
      return
  }
}

export const topupFlow = createTopupFlow({
  api: () => flowGateway().api,
  checkout: (args) => openCheckout(args, flowGateway().bridge),
  onSettled: announce,
})

// A new order binds the flow to the gateway active at that moment; back to idle frees it.
topupFlow.store.subscribe((s, prev) => {
  if (s.phase === 'creating' && prev.phase !== 'creating') orderGateway = activeGateway()
  else if (s.phase === 'idle') orderGateway = null
})

// The order stopped being tracked by an error (session ended, canvasapp unreachable…) while the sheet is not on screen:
// say so, otherwise the user would believe SanoVids is still waiting for canvasapp.
topupFlow.store.subscribe((s, prev) => {
  if (s.phase !== 'error' || prev.phase === 'error' || sheetShowsStatus()) return
  const text =
    s.error?.code === 'login-required'
      ? 'Nạp credit: phiên canvasapp đã hết — đăng nhập lại để SanoVids tiếp tục kiểm tra đơn nạp.'
      : `Nạp credit: ${s.error?.message ?? 'đã có lỗi.'}`
  toast(text, { tone: 'error', ms: 10000, action: { label: 'Xem', run: reopenSheet } })
})

/** The whole flow state (re-renders on every change — only the sheet uses it). */
export function useTopupFlowState(): TopupFlowState {
  return useStore(topupFlow.store)
}
