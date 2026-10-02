import { CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { useUI, type Toast } from '../../store/ui'
import './common.css'

const TONE_ICON: Record<Toast['tone'], LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
}

/** Notifications: translucent capsules at the bottom center, newest last. */
export function Toasts() {
  const toasts = useUI((s) => s.toasts)
  const dismiss = useUI((s) => s.dismissToast)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => {
        const Icon = TONE_ICON[t.tone] ?? Info
        return (
          <div key={t.id} className={`toast ${t.tone}${t.persistent ? ' persistent' : ''}`}>
            <Icon size={16} className="toast-icon" aria-hidden="true" />
            <span className="toast-text">{t.text}</span>
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  t.action!.run()
                  dismiss(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="Đóng thông báo" title="Đóng">
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
