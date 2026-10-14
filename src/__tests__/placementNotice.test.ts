// The Mac launch reminder (src/placementNotice.ts, called once by main.tsx): a toast only for a run macOS keeps in a
// temporary / removable place, with the words of lib/appPlacement macPlacementNote, and "Xem" → Cài đặt → Ứng dụng.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import mainSource from '../main.tsx?raw'
import settingsDialogSource from '../components/dialogs/SettingsDialog.tsx?raw'
import { APP_PLACEMENT_KINDS, macPlacementNote, type AppPlacement } from '../lib/appPlacement'
import { PLACEMENT_NOTICE_SECTION, showPlacementNoticeOnLaunch } from '../placementNotice'
import { useUI } from '../store/ui'

beforeEach(() => {
  vi.useFakeTimers()
  useUI.setState({ toasts: [], dialog: { kind: 'none' } })
})
afterEach(() => {
  vi.useRealTimers()
})

const placed = (kind: AppPlacement['kind']) => async (): Promise<AppPlacement> => ({ kind })

describe('the Mac placement toast at launch', () => {
  it('only a run from a .dmg / Tải về (translocated) or an external drive gets the toast', async () => {
    for (const kind of [...APP_PLACEMENT_KINDS, 'unknown'] as const) {
      useUI.setState({ toasts: [] })
      const shown = await showPlacementNoticeOnLaunch(placed(kind))
      expect(shown, kind).toBe(kind === 'mac-translocated' || kind === 'mac-volume')
      expect(useUI.getState().toasts, kind).toHaveLength(shown ? 1 : 0)
    }
  })

  it('says how to move the app (the Settings note), and "Xem" opens Cài đặt → Ứng dụng', async () => {
    expect(await showPlacementNoticeOnLaunch(placed('mac-volume'))).toBe(true)
    const [t] = useUI.getState().toasts
    expect(t).toMatchObject({ text: macPlacementNote('mac-volume'), tone: 'warning', action: { label: 'Xem' } })
    t.action!.run()
    expect(useUI.getState().dialog).toEqual({ kind: 'settings', section: PLACEMENT_NOTICE_SECTION })
    // That section is the "Ứng dụng" group, which shows the same note (AppBlock → PlacementNoteView).
    expect(PLACEMENT_NOTICE_SECTION).toBe('app')
    expect(settingsDialogSource).toMatch(/id: 'app',[\s\S]{0,400}?Block: AppBlock/)
  })

  it('a loader that fails shows nothing and never rejects', async () => {
    await expect(showPlacementNoticeOnLaunch(() => Promise.reject(new Error('bridge gone')))).resolves.toBe(false)
    expect(useUI.getState().toasts).toEqual([])
  })

  it('main.tsx asks once per launch, outside React (StrictMode would run an effect twice)', () => {
    expect(mainSource).toContain("import { showPlacementNoticeOnLaunch } from './placementNotice'")
    expect(mainSource.match(/showPlacementNoticeOnLaunch\(\)/g)).toHaveLength(1)
    expect(mainSource).toMatch(/^void showPlacementNoticeOnLaunch\(\)$/m)
  })
})
