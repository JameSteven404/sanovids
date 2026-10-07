// Dialog kind 'player' (store/ui DialogState): the "Phát liền" player over the whole window. Its own chunk (App.tsx),
// opened with filmActions.openFilmPlayer(start).
import { useCallback, useEffect, useRef, useState } from 'react'
import { closeEmptyPlayer, currentFilm, selectMissingStar } from '../../filmActions'
import { useUI } from '../../store/ui'
import { FilmPlayer } from './FilmPlayer'

export function FilmPlayerDialog({ start = 0 }: { start?: number }) {
  // Read once when the player opens: the list stays fixed while it plays, so a take finishing meanwhile never makes
  // the scene numbers jump under the user.
  const [film] = useState(currentFilm)
  // Nothing to play (the scenes were deleted between the click and the chunk load, or another way in): an empty
  // player would render nothing yet keep the dialog open, and the global shortcuts ignore every key while a dialog is
  // open. Close it right away (once, also under StrictMode's double effects).
  const refused = useRef(false)
  useEffect(() => {
    if (film || refused.current) return
    refused.current = true
    closeEmptyPlayer()
  }, [film])
  const close = useCallback(() => useUI.getState().closeDialog(), [])
  const missingIds = film?.summary.missingStarIds
  const selectMissing = useCallback(() => {
    if (missingIds) selectMissingStar(missingIds)
  }, [missingIds])
  if (!film) return null
  return <FilmPlayer items={film.items} start={start} onClose={close} missingCount={missingIds?.length ?? 0} onSelectMissing={selectMissing} />
}
