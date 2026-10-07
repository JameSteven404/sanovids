// canvas.css keeps only what the canvas still renders (cleanup after E2 / RV / XT): no retired reference-video visuals
// (a purple ring on every scene while a video wire is dragged, a two-tone reference dot, "Dùng làm @video"), and none
// of the 0.5.x scene / asset card internals that sceneNode.css / assetNode.css replaced.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const css = read('../canvas.css')

describe('canvas.css', () => {
  it('no reference-video visuals (reference videos were retired in 0.6.0)', () => {
    for (const sel of ['.cv-h-ref.is-video', '.cv-h-ref.is-mixed', '.cv-connecting-take .cv-scene', '.cv-conn-hint.take', '.is-take-target', '.is-drop-take', '.cv-vref']) {
      expect(css, sel).not.toContain(sel)
    }
  })

  it('no 0.5.x card internals the 352 × 304 node / 220 × 275 tile replaced', () => {
    for (const cls of ['cv-scene-head', 'cv-refs', 'cv-av', 'cv-prompt', 'cv-m', 'cv-scene-foot', 'cv-settings', 'cv-cost', 'cv-run', 'cv-take-line', 'cv-far', 'cv-asset-img', 'cv-asset-name', 'cv-asset-meta', 'cv-scene-body']) {
      expect(css, cls).not.toMatch(new RegExp(`\\.${cls}(?![\\w-])`))
    }
  })

  it('what the node, tile and take still use stays (states, drop / wire feedback, the running bar, previews)', () => {
    for (const sel of ['.cv-scene {', '.cv-scene.is-selected {', '.cv-scene-stripe {', '.cv-run-bar {', '@keyframes cv-run', '.cv-drop-hint,', '.cv-connecting-asset .cv-scene {', '.cv-ref-preview {', '.cv-asset-zoom {', '.cv-asset-count {', '.cv-stage .cv-h-video {', '.cv-spin {']) {
      expect(css, sel).toContain(sel)
    }
  })
})
