// "Khôi phục prompt này" and the take viewer's reference list: the numbers a take was sent with.
// Pure helpers (no React, no stores) — covered by ./__tests__/restore.test.ts.
//
// A take keeps the scene prompt and the ordered asset ids it ran with. Tokens are positional (@image_N = N-th image of
// the refs), so restoring the old prompt with a shorter list (an asset was deleted since) must renumber the tokens
// like a live deletion does — the token of a picture that is gone becomes a red placeholder (core/placeholders), never
// a name or nothing. @video text of an older take (reference videos were retired in 0.6.0) comes back exactly
// as it was written — never renumbered or replaced — and blocks the run (core/compile retiredVideoTokens).
// The exact image list of the run is only known when the take carries `imageKeysSnapshot` (the image keys it was
// sent with, in order). Older takes do not: the image slots are then rebuilt from the assets as they are now.
import { HAS_TOKEN_RE, imageKey, mediaKeys, remapTokens, retiredVideoTokens, TOKEN_RE } from '../../core/compile'
import { imagePlaceholders, removalLabels } from '../../core/placeholders'
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
  /** True when tokens of the prompt were rewritten (renumbered, or turned into red placeholders). */
  renumbered: boolean
  /**
   * Renumbering off and the prompt kept tokens that now point at another image than when the take ran (a reference
   * was deleted, or a character's pictures changed): the user must check them.
   */
  stale: boolean
  /** Retired @video tokens of the restored prompt, as written (distinct, in order): they block the run. */
  retired: string[]
  /**
   * @image tokens of an older take (no image snapshot) that come after a character deleted since: its picture count is
   * unknown, so their picture is unknown too — they became bare red placeholders "@image_?N" (never a guess).
   */
  uncertain: number
  /** Red placeholders the restore wrote (removed pictures + `uncertain`): the scene is blocked until they are filled. */
  placeholders: number
}

/** Key standing for a picture of an older take whose place is unknown (after a deleted character). */
const unknownKey = (i: number) => `\u0000unknown:${i}`

/**
 * Scene data that puts a scene back the way it was when `take` ran. References that no longer exist are dropped and
 * the @image_N tokens of the old prompt are rewritten so each one still points at the same image — with `renumber` off
 * (project.settings.autoRenumber) they keep their numbers. The token of a picture that is gone becomes a red
 * placeholder, exactly like removing a reference from a live scene: "@image_?N(Tên · ảnh k)" when the character still
 * exists (only that picture is gone), a bare "@image_?N" when it was deleted. For an older take without an image
 * snapshot, every token from the first deleted character on becomes a bare placeholder (`uncertain` past it). @video
 * text is kept exactly as written (`retired` lists it).
 */
export function restoredFromTake(
  take: Pick<Take, 'rawPromptSnapshot' | 'refsSnapshot'> & { imageKeysSnapshot?: readonly string[] },
  assets: Asset[],
  opts: { renumber: boolean },
): RestoredScene {
  const alive = new Set(assets.map((a) => a.id))
  const refs = take.refsSnapshot.filter((id) => alive.has(id))
  const gone = take.refsSnapshot.length - refs.length
  const raw = take.rawPromptSnapshot
  const retired = [...new Set(retiredVideoTokens(raw).map((t) => t.text))]
  const same = { prompt: raw, refs, gone, renumbered: false, uncertain: 0, placeholders: 0, stale: false, retired }
  if (!HAS_TOKEN_RE.test(raw)) return same

  const exact = exactImageKeys(take)
  let beforeImages = snapshotImageKeys(assets, take.refsSnapshot, exact)
  const after = mediaKeys(assets, refs)
  // With the exact snapshot, images added to / removed from an asset since the run also shift the numbers.
  const imagesMoved = !!exact && beforeImages.join('|') !== after.images.join('|')
  if (gone === 0 && !imagesMoved) return same

  // Old take: from the first deleted asset on the slots are unknown (its real image count is unknown) — never guessed.
  let uncertain = 0
  const guessFrom = beforeImages.findIndex(isMissingKey)
  if (guessFrom >= 0) {
    for (const m of raw.matchAll(TOKEN_RE)) {
      if (m[1].toLowerCase() === 'image' && Number(m[2]) - 1 > guessFrom) uncertain++
    }
    beforeImages = beforeImages.map((k, i) => (i > guessFrom ? unknownKey(i) : k))
  }
  const labels = removalLabels(assets, { beforeKeys: beforeImages, refsAfter: refs, assetsAfter: assets })
  const res = remapTokens(raw, { images: beforeImages }, after, () => '', {
    keepNumbers: !opts.renumber,
    placeholder: (key, n, glued) => (isMissingKey(key) || key.startsWith('\u0000') ? null : labels(key, n, glued)),
  })
  const placeholders = imagePlaceholders(res.text).length - imagePlaceholders(raw).length
  // Past the unknown slots a typed-ahead number of the old prompt has no picture either (out of range: blocked).
  const stale = !opts.renumber && tokensShifted(res.text, { images: beforeImages }, after)
  return { prompt: res.text, refs, gone, renumbered: res.changed, uncertain, placeholders: Math.max(0, placeholders), stale, retired }
}
