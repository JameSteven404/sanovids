// The app's ONE top-up flow (topupFlow.ts) wired to the real canvasapp gateway. Module-level on purpose: closing the
// "Nạp credit" sheet does not stop an order being confirmed, and reopening it shows the same order (and still
// refuses a second one while it is in flight).
//   - api: providers canvasappApi() (desktop bridge; main enforces the endpoint allowlist).
//   - checkout: transport openCheckout() (refuses non-SePay URLs before the bridge; main re-checks).
//   - canvasapp said paid → refreshRealCredits({ force: true }) so every balance in the app moves.
//   - A final answer, or an error that stops the tracking, while the sheet is closed (or on the history tab) → a toast
//     with "Xem" to reopen it.
import { useStore } from 'zustand'
import { formatCreditNumber } from '../../lib/credits'
import { canvasappApi } from '../../providers'
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

function announce(s: TopupFlowState) {
  if (s.phase === 'paid') void refreshRealCredits({ force: true })
  if (sheetShowsStatus()) return
  const action = { label: 'Xem', run: reopenSheet }
  switch (s.phase) {
    case 'paid': {
      const credits = s.paidCredits ?? s.credits
      toast(credits !== null ? `Nạp credit thành công: +${formatCreditNumber(credits)} credit vào tài khoản canvasapp.` : 'Nạp credit thành công.', {
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
  api: () => canvasappApi(),
  checkout: (args) => openCheckout(args),
  onSettled: announce,
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
