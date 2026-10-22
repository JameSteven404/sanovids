// The launch reminder of a Mac run from a temporary / removable place (macOS's read-only copy of an app opened from a
// .dmg or the Tải về folder, an external drive): once per launch, a toast that says how to move SanoVids into
// Applications — the app never moves itself. "Xem" opens Cài đặt → Ứng dụng, which keeps the same note
// (SettingsBasic PlacementNoteView). Which places toast: lib/appPlacement placementToastsOnLaunch; the words:
// macPlacementNote. Called once by src/main.tsx, outside React (StrictMode would run an effect twice).
import { openSettings } from './actions'
import { loadAppPlacement, macPlacementNote, placementToastsOnLaunch, type AppPlacement } from './lib/appPlacement'
import { toast } from './store/ui'

/** The toast's button: the "Ứng dụng" settings group (SettingsDialog GROUPS id). */
export const PLACEMENT_NOTICE_SECTION = 'app'

/** Shows the reminder when this run's place asks for one; true when it did. Never rejects. */
export async function showPlacementNoticeOnLaunch(load: () => Promise<AppPlacement> = loadAppPlacement): Promise<boolean> {
  let kind: AppPlacement['kind']
  try {
    kind = (await load()).kind
  } catch {
    return false
  }
  const text = placementToastsOnLaunch(kind) ? macPlacementNote(kind) : null
  if (!text) return false
  toast(text, { tone: 'warning', ms: 12000, action: { label: 'Xem', run: () => openSettings(PLACEMENT_NOTICE_SECTION) } })
  return true
}
