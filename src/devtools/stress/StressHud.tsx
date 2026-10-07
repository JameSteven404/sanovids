// Small floating pill shown while a stress run goes on, so it can be watched / stopped with the dev panel closed.
// Mount once in App (development mode only): `{isDev && <StressHud />}`. Renders nothing when idle.
import { memo } from 'react'
import { LoaderCircle, Square } from 'lucide-react'
import { useStress, stopStress } from './store'
import './stress.css'

function StressHudImpl() {
  const phase = useStress((s) => s.phase)
  const step = useStress((s) => s.progress?.step ?? 0)
  const steps = useStress((s) => s.progress?.steps ?? 0)
  const errors = useStress((s) => s.progress?.errors ?? 0)
  const phaseText = useStress((s) => s.phaseText)
  if (phase === 'idle') return null
  return (
    <div className="dv-stress-hud" role="status">
      <LoaderCircle size={14} className="dv-stress-spin" />
      <span>
        Test giới hạn: {phase === 'running' ? `bước ${step}${steps ? `/${steps}` : ''}` : phase === 'stopping' ? 'đang dừng…' : phaseText || 'đang trả lại dự án…'}
      </span>
      {errors > 0 && <span className="dv-stress-hud-err">{errors} lỗi</span>}
      {phase === 'running' && (
        <button className="icon-btn" title="Dừng" onClick={stopStress}>
          <Square size={14} />
        </button>
      )}
    </div>
  )
}

export const StressHud = memo(StressHudImpl)
