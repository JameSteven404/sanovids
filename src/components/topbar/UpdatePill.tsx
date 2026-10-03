// Top-bar pill of the auto-updater (lib/updates, updateActions): "Cập nhật 0.5.1" (a new version), "Đang tải 42%",
// "Cập nhật 0.5.1" once downloaded, "Chờ cập nhật" while "Cập nhật khi xong" waits for running videos. Hidden when
// there is nothing to say (up to date, checking, errors — automatic checks stay silent —, builds that do not update).
// A portable build only shows "Bản mới 0.5.1". A click always opens the "Cập nhật SanoVids" dialog. Styles: topbar.css.
import { CircleArrowUp, Clock, CloudDownload } from 'lucide-react'
import { memo } from 'react'
import { pillView } from '../../lib/updateModel'
import { useUpdates } from '../../lib/updates'
import { useActiveCount } from '../../store/runs'
import { openUpdateDialog, useInstallUi } from '../../updateActions'

export const UpdatePill = memo(function UpdatePill() {
  const state = useUpdates((s) => s.state)
  const installWhenIdle = useInstallUi((s) => s.installWhenIdle)
  const activeJobs = useActiveCount()
  const view = pillView(state, { installWhenIdle, activeJobs })
  if (!view) return null
  const Icon = view.tone === 'downloading' ? CloudDownload : view.tone === 'waiting' ? Clock : CircleArrowUp
  return (
    <button type="button" className={`tb-update ${view.tone}`} onClick={openUpdateDialog} title={view.title} aria-label={view.title}>
      <Icon size={13} className="tb-update-icon" aria-hidden="true" />
      <span>
        {view.long && <span className="tb-hide-md">{view.long}</span>}
        {view.short}
      </span>
    </button>
  )
})
