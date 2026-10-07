// "Khôi phục prompt này" and the take viewer's reference list: the numbers a take was sent with.
// Pure helpers (no React, no stores) — covered by ./__tests__/restore.test.ts.
//
// A take keeps the scene prompt and the ordered asset ids it ran with. Tokens are positional (@image_N = N-th image of
// the refs), so restoring the old prompt with a shorter list (an asset was deleted since) must renumber the tokens
// like a live deletion does. @video text of an older take (reference videos were retired in 0.6.0) comes back exactly
// as it was written — never renumbered or replaced — and blocks the run (core/compile retiredVideoTokens).
// The exact image list of the run is only known when the take carries `imageKeysSnapshot` (the image keys it was
// sent with, in order). Older takes do not: the image slots are then rebuilt from the assets as they are now.
import { HAS_TOKEN_RE, imageKey, mediaKeys, remapTokens, retiredVideoTokens, TOKEN_RE } from '../../core/compile'
import { tokensShifted } from '../../core/staleTokens'
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
  /** References of the take that no longer exist (dropped). */
  gone: number
  /** True when tokens of the prompt were rewritten. */
  renumbered: boolean
  /**
   * Renumbering off and the prompt kept tokens that now point at another image than when the take ran (a reference
   * was deleted, or a character's pictures changed): the user must check them.
   */
  stale: boolean
  /** Retired @video tokens of the restored prompt, as written (distinct, in order): they block the run. */
  retired: string[]
  /**
   * @image tokens whose number could not be resolved for sure: they come after a deleted asset of an older take
   * (no image snapshot), whose image count is unknown. They were renumbered as if that asset had one image —
   * the user should check them.
   */
  uncertain: number
}

/**
 * Scene data that puts a scene back the way it was when `take` ran. References that no longer exist are dropped
 * and, with `renumber` (project.settings.autoRenumber), the @image_N tokens of the old prompt are rewritten so each
 * one still points at the same image; tokens whose image is gone become the asset name (or "ảnh") — the same rule as
 * removing a reference from a live scene. @video text is kept exactly as written (`retired` lists it).
 */
export function restoredFromTake(
  take: Pick<Take, 'rawPromptSnapshot' | 'refsSnapshot'> & { imageKeysSnapshot?: readonly string[] },
  assets: Asset[],
  opts: { renumber: boolean },
): RestoredScene {
  const alive = new Set(assets.map((a) => a.id))
  const refs = take.refsSnapshot.filter((id) => alive.has(id))
  const gone = take.refsSnapshot.length - refs.length
  let prompt = take.rawPromptSnapshot
  let renumbered = false
  let uncertain = 0
  const retired = [...new Set(retiredVideoTokens(prompt).map((t) => t.text))]
  if (!HAS_TOKEN_RE.test(prompt)) return { prompt, refs, gone, renumbered, uncertain, stale: false, retired }

  const exact = exactImageKeys(take)
  const beforeImages = snapshotImageKeys(assets, take.refsSnapshot, exact)
  const after = mediaKeys(assets, refs)
  // With the exact snapshot, images added to / removed from an asset since the run also shift the numbers.
  const imagesMoved = !!exact && beforeImages.join('|') !== after.images.join('|')
  if (gone === 0 && !imagesMoved) return { prompt, refs, gone, renumbered, uncertain, stale: false, retired }
  if (!opts.renumber) {
    const stale = tokensShifted(prompt, { images: beforeImages }, after)
    return { prompt, refs, gone, renumbered, uncertain, stale, retired }
  }

  // Old take: past the first deleted asset the slots are a guess (its real image count is unknown).
  const guessFrom = beforeImages.findIndex(isMissingKey)
  if (guessFrom >= 0) {
    for (const m of prompt.matchAll(TOKEN_RE)) {
      if (m[1].toLowerCase() === 'image' && Number(m[2]) - 1 > guessFrom) uncertain++
    }
  }
  const names = new Map(assets.map((a) => [a.id, a.name]))
  const res = remapTokens(prompt, { images: beforeImages }, after, (key) => names.get(key.slice(0, key.indexOf(':'))) ?? 'ảnh')
  prompt = res.text
  renumbered = res.changed
  return { prompt, refs, gone, renumbered, uncertain, stale: false, retired }
}
