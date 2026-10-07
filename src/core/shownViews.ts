// Which center views the app shows. 0.6.0: Canvas only. Storyboard is hidden and frozen in components/views (not
// bundled: App.tsx does not import it); Bảng cảnh (SceneTable) was deleted. Showing a view again starts here: add its
// id to SHOWN_VIEWS and restore its chunk / render branch in App.tsx. The top bar, the stored pref and App all ask here.
import type { ViewMode } from './types'

export interface ViewMeta {
  id: ViewMode
  label: string
}

/** Every view that still has code. 'table' is gone with SceneTable; ViewMode keeps it so old stored prefs still parse. */
export const ALL_VIEWS: readonly ViewMeta[] = [
  { id: 'canvas', label: 'Canvas' },
  { id: 'storyboard', label: 'Storyboard' },
]

/** The views a user can reach. */
export const SHOWN_VIEWS: readonly ViewMode[] = ['canvas']

export const isShownView = (v: unknown): v is ViewMode => typeof v === 'string' && (SHOWN_VIEWS as readonly string[]).includes(v)

/** Metadata of the shown views, in switch order. The view switch renders only with 2 or more. */
export const SHOWN_VIEW_LIST: readonly ViewMeta[] = ALL_VIEWS.filter((v) => isShownView(v.id))
