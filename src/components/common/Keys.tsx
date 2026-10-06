import { Fragment, type ReactNode } from 'react'
import { chordAria, chordParts, type ActionId } from '../../core/keymap'
import { IS_MAC } from '../../lib/keyEvents'
import { useKeymap } from '../../lib/keymapPrefs'

/** Canonical chords, not formatted labels; parts keep Mac glyphs and literal '+' keys intact. */
export function Keys({ keys, mac = IS_MAC }: { keys: readonly string[]; mac?: boolean }) {
  return <span className="cm-keys">
    {keys.map((chord, i) => <Fragment key={`${chord}:${i}`}>
      {i > 0 && <span className="cm-keys-or" aria-hidden="true">/</span>}
      <span className="cm-key-chord" role="img" aria-label={chordAria(chord, mac)} title={mac && chord === 'Delete' ? 'fn + ⌫' : undefined}>
        {chordParts(chord, mac).map((part, j) => <Fragment key={j}>
          {!mac && j > 0 && <span className="cm-keys-plus" aria-hidden="true">+</span>}
          <kbd className="kbd" aria-hidden="true">{part}</kbd>
        </Fragment>)}
      </span>
    </Fragment>)}
  </span>
}

export function ActionKeys({ id, fallback = 'Chưa gán' }: { id: ActionId; fallback?: ReactNode }) {
  const chords = useKeymap((s) => s.resolved.byAction[id])
  return chords.length ? <Keys keys={chords} /> : <>{fallback}</>
}
