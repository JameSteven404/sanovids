// The open question of store/confirm, in the app's own dialog (the shared Modal, layer 'top': above any dialog that is
// open — e.g. the item dialog asking before a delete — with the app's theme and keys, never the browser's
// window.confirm). Mounted once at the app root (App.tsx). Enter / the red button confirms; Escape, "Huỷ" and a click
// outside cancel.
import { answerConfirm, useConfirm } from '../../store/confirm'
import { Modal } from './Modal'

export function ConfirmSheet() {
  const req = useConfirm((s) => s.request)
  if (!req) return null
  return (
    <Modal
      key={req.id}
      layer="top"
      title={req.title}
      onClose={() => answerConfirm(false)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => answerConfirm(false)}>
            {req.cancelLabel ?? 'Huỷ'}
          </button>
          {/* focused first: Enter confirms, as the browser's question did */}
          <button type="button" className={`btn ${req.danger ? 'btn-danger' : 'btn-primary'}`} autoFocus onClick={() => answerConfirm(true)}>
            {req.confirmLabel}
          </button>
        </>
      }
    >
      <p className="cm-confirm-text">{req.text}</p>
    </Modal>
  )
}
