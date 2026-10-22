// UI-06 (docs/UI-MUOT.md): the canvas only animates colour, opacity and transform — a transition on a size or a
// position lays the page out again on every frame (the canvas is the hot path: 100+ nodes, wheel pan / zoom).
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dir = new URL('../../components/canvas/', import.meta.url)
const css = readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => [f, readFileSync(new URL(f, dir), 'utf8')] as const)
// `stroke-width` (SVG paint, no layout) is fine: only a bare size / position property counts.
const LAYOUT = /(?<![\w-])(width|height|top|left|right|bottom|margin|padding|max-height|max-width|inset)\b/

describe('canvas motion (UI-06)', () => {
  it('no transition / transition-property on a size or a position in the canvas CSS', () => {
    for (const [file, text] of css) {
      for (const m of text.matchAll(/transition(?:-property)?\s*:\s*([^;]+);/g)) {
        expect(LAYOUT.test(m[1]) ? `${file}: ${m[0]}` : '', file).toBe('')
      }
    }
  })
  it('the motion tokens exist once, in the base tokens', () => {
    const base = readFileSync(new URL('../base.css', import.meta.url), 'utf8')
    for (const t of ['--motion-press: 75ms', '--motion-hover: 120ms', '--motion-state: 150ms', '--motion-pop: 180ms', '--ease-ui:']) {
      expect(base.split(t).length - 1, t).toBe(1)
    }
  })
})
