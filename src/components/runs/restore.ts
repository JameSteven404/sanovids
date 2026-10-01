// "Khôi phục prompt này" and the take viewer's reference list: the numbers a take was sent with.
// Pure helpers (no React, no stores) — covered by ./__tests__/restore.test.ts.
//
// A take keeps the scene prompt and the ordered asset/take ids it ran with, but not the image ids of each asset.
// Tokens are positional (@image_N = N-th image of the refs, @video_N = N-th video), so restoring the old prompt
// with a shorter list (an asset or a take was deleted since) must renumber the tokens like a live deletion does.
import { imageKey, mediaKeys, remapTokens } from '../../core/compile'
import type { Asset, Take } from '../../core/types'

/** Key of an image slot whose asset was deleted (its image count is unknown, counted as one image). */
const missingKey = (assetId: string) => `${assetId}:?`

/**
 * Image keys of a take's reference list, numbered like when it ran: an asset deleted since still takes one
 * number, so the numbers after it do not shift. Approximation: images added to / removed from an asset since
 * the run are unknown (not snapshotted), so the asset's current images are used.
 */
export function snapshotImageKeys(assets: Asset[], refs: string[]): string[] {
  const byId = new Map(assets.map((a) => [a.id, a]))
  const out: string[] = []
  for (const id of refs) {
    const a = byId.get(id)
    if (!a) out.push(missingKey(id))
    else for (const imageId of a.imageIds) out.push(imageKey({ assetId: id, imageId }))
  }
  return out
}

/** @image number of each asset of a take (its primary image), with the same rules as `snapshotImageKeys`. */
export function snapshotImageNumbers(assets: Asset[], refs: string[]): Map<string, number> {
  const out = new Map<string, number>()
  snapshotImageKeys(assets, refs).forEach((key, i) => {
    const assetId = key.slice(0, key.indexOf(':'))
    if (!out.has(assetId)) out.set(assetId, i + 1)
  })
  return out
}

export interface RestoredScene {
  prompt: string
  /** The take's references that still exist, in their original order. */
  refs: string[]
  videoRefs: string[]
  /** References of the take that no longer exist (dropped). */
  gone: number
  /** True when tokens of the prompt were rewritten. */
  renumbered: boolean
}

/**
 * Scene data that puts a scene back the way it was when `take` ran. References that no longer exist are dropped
 * and, with `renumber` (project.settings.autoRenumber), the @image_N / @video_N tokens of the old prompt are
 * rewritten so each one still points at the same image/video; tokens whose media is gone become the asset name
 * (or "ảnh") / `videoLabel(takeId)` — the same rule as removing a reference from a live scene.
 */
export function restoredFromTake(
  take: Pick<Take, 'rawPromptSnapshot' | 'refsSnapshot' | 'videoRefsSnapshot'>,
  assets: Asset[],
  liveTakeIds: Set<string>,
  opts: { renumber: boolean; videoLabel?: (takeId: string) => string },
): RestoredScene {
  const alive = new Set(assets.map((a) => a.id))
  const refs = take.refsSnapshot.filter((id) => alive.has(id))
  const videoRefs = take.videoRefsSnapshot.filter((id) => liveTakeIds.has(id))
  const gone = take.refsSnapshot.length - refs.length + take.videoRefsSnapshot.length - videoRefs.length
  let prompt = take.rawPromptSnapshot
  let renumbered = false
  if (opts.renumber && gone > 0 && /@(image|video)_\d/i.test(prompt)) {
    const before = { images: snapshotImageKeys(assets, take.refsSnapshot), videos: take.videoRefsSnapshot }
    const after = mediaKeys(assets, refs, videoRefs)
    const names = new Map(assets.map((a) => [a.id, a.name]))
    const videoLabel = opts.videoLabel ?? (() => 'video')
    const res = remapTokens(prompt, before, after, (kind, key) => (kind === 'image' ? (names.get(key.slice(0, key.indexOf(':'))) ?? 'ảnh') : videoLabel(key)))
    prompt = res.text
    renumbered = res.changed
  }
  return { prompt, refs, videoRefs, gone, renumbered }
}
