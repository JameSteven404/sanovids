// "Khôi phục prompt này" and the take viewer's reference list: the numbers a take was sent with.
// Pure helpers (no React, no stores) — covered by ./__tests__/restore.test.ts.
//
// A take keeps the scene prompt and the ordered asset/take ids it ran with. Tokens are positional (@image_N =
// N-th image of the refs, @video_N = N-th video), so restoring the old prompt with a shorter list (an asset or a
// take was deleted since) must renumber the tokens like a live deletion does.
// The exact image list of the run is only known when the take carries `imageKeysSnapshot` (the image keys it was
// sent with, in order). Older takes do not: the image slots are then rebuilt from the assets as they are now.
import { imageKey, mediaKeys, remapTokens, TOKEN_RE } from '../../core/compile'
import type { Asset, Take } from '../../core/types'

/** Key of an image slot whose asset was deleted (its image count is unknown, counted as one image). */
const missingKey = (assetId: string) => `${assetId}:?`
const isMissingKey = (key: string) => key.endsWith(':?')

/**
 * The exact image keys a take was sent with (`imageKeysSnapshot`, set by newer versions of the run queue), or
 * undefined for older takes that only have the asset ids.
 */
export function exactImageKeys(take: object): string[] | undefined {
  const keys = (take as { imageKeysSnapshot?: unknown }).imageKeysSnapshot
  return Array.isArray(keys) && keys.every((k) => typeof k === 'string') ? (keys as string[]) : undefined
}

/**
 * Image keys of a take's reference list, numbered like when it ran. With `imageKeysSnapshot` these are exact.
 * Otherwise an approximation: an asset deleted since still takes one number (so the numbers after it do not
 * shift when it had one image — the usual case), and images added to / removed from an asset since the run are
 * unknown, so the asset's current images are used.
 */
export function snapshotImageKeys(assets: Asset[], refs: string[], exact?: string[]): string[] {
  if (exact) return [...exact]
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
export function snapshotImageNumbers(assets: Asset[], refs: string[], exact?: string[]): Map<string, number> {
  const out = new Map<string, number>()
  snapshotImageKeys(assets, refs, exact).forEach((key, i) => {
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
  /**
   * @image tokens whose number could not be resolved for sure: they come after a deleted asset of an older take
   * (no image snapshot), whose image count is unknown. They were renumbered as if that asset had one image —
   * the user should check them.
   */
  uncertain: number
}

/**
 * Scene data that puts a scene back the way it was when `take` ran. References that no longer exist are dropped
 * and, with `renumber` (project.settings.autoRenumber), the @image_N / @video_N tokens of the old prompt are
 * rewritten so each one still points at the same image/video; tokens whose media is gone become the asset name
 * (or "ảnh") / `videoLabel(takeId)` — the same rule as removing a reference from a live scene.
 */
export function restoredFromTake(
  take: Pick<Take, 'rawPromptSnapshot' | 'refsSnapshot' | 'videoRefsSnapshot'> & { imageKeysSnapshot?: readonly string[] },
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
  let uncertain = 0
  if (!opts.renumber || !/@(image|video)_\d/i.test(prompt)) return { prompt, refs, videoRefs, gone, renumbered, uncertain }

  const exact = exactImageKeys(take)
  const beforeImages = snapshotImageKeys(assets, take.refsSnapshot, exact)
  const after = mediaKeys(assets, refs, videoRefs)
  // With the exact snapshot, images added to / removed from an asset since the run also shift the numbers.
  const imagesMoved = !!exact && beforeImages.join('|') !== after.images.join('|')
  if (gone === 0 && !imagesMoved) return { prompt, refs, videoRefs, gone, renumbered, uncertain }

  // Old take: past the first deleted asset the slots are a guess (its real image count is unknown).
  const guessFrom = beforeImages.findIndex(isMissingKey)
  if (guessFrom >= 0) {
    for (const m of prompt.matchAll(TOKEN_RE)) {
      if (m[1].toLowerCase() === 'image' && Number(m[2]) - 1 > guessFrom) uncertain++
    }
  }
  const names = new Map(assets.map((a) => [a.id, a.name]))
  const videoLabel = opts.videoLabel ?? (() => 'video')
  const res = remapTokens(prompt, { images: beforeImages, videos: take.videoRefsSnapshot }, after, (kind, key) =>
    kind === 'image' ? (names.get(key.slice(0, key.indexOf(':'))) ?? 'ảnh') : videoLabel(key),
  )
  prompt = res.text
  renumbered = res.changed
  return { prompt, refs, videoRefs, gone, renumbered, uncertain }
}
