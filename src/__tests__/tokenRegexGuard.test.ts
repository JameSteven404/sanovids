// Reference videos were retired, but `video` must stay in every token pattern: narrowed to `image`, "@video1" would read
// as a legacy @Tag (and an asset could take the tag "video_1"), so old @video text would silently change meaning
// instead of being kept, marked and blocked. A guard on the source + the behaviour it protects.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkTag } from '../components/sidebar/shared'
import { extractMentions, MENTION_RE, parseTokens, retiredVideoTokens, uniqueTag } from '../core/compile'
import { tagsToTokens } from '../core/migrate'
import type { Project } from '../core/types'

const SRC = fileURLToPath(new URL('..', import.meta.url))

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') out.push(...sourceFiles(path))
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|stress)\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

/** Where a regex names the image token kind as a kind (an alternation or a token prefix), not a fixed "@image_" text. */
const IMAGE_KIND = /\(\?:image\||\(image\||image\[ _\]|\[iI\]\[mM\]/
const VIDEO_KIND = /video|\[vV\]\[iI\]/

describe('token regexes keep `video` (source guard)', () => {
  it('every regex literal of src that names the image token kind names video too', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (IMAGE_KIND.test(line) && !VIDEO_KIND.test(line)) offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(offenders).toEqual([])
  })

  it('finds the token patterns it guards (the scan is not empty)', () => {
    const hits = sourceFiles(SRC).filter((f) => readFileSync(f, 'utf8').split('\n').some((l) => IMAGE_KIND.test(l)))
    expect(hits.length).toBeGreaterThan(5)
  })
})

describe('token regexes keep `video` (behaviour)', () => {
  it('@video spellings are never legacy @Tag mentions, and every layer reads them as video tokens', () => {
    const text = '@video_1 @video1 @Video 2'
    expect(extractMentions(text)).toEqual([])
    expect([...text.matchAll(MENTION_RE)]).toEqual([])
    expect(parseTokens(text).map((t) => [t.kind, t.n])).toEqual([
      ['video', 1],
      ['video', 1],
      ['video', 2],
    ])
    expect(retiredVideoTokens(text).map((t) => t.text)).toEqual(['@video_1', '@video1', '@Video 2'])
  })
  it('no asset can take a tag that reads as a @video token', () => {
    const p = {
      assets: [{ id: 'a', kind: 'character', name: 'A', tag: 'A', description: '', imageIds: [], color: '#fff', position: null }],
    } as unknown as Project
    expect(checkTag(p, 'a', 'video_1').error).toBeTruthy()
    expect(checkTag(p, 'a', '@Video_2').error).toBeTruthy()
    expect(uniqueTag('video_1', [])).not.toMatch(/^video_?\d+$/i)
    expect(uniqueTag('Video 3', [])).not.toMatch(/^video_?\d+$/i)
  })
  it('migrating v1 @Tag mentions leaves @video text alone', () => {
    const assets = [{ id: 'a', kind: 'character' as const, name: 'Elara', tag: 'Elara', description: '', imageIds: ['i1'], color: '#fff', position: null }]
    expect(tagsToTokens('@Elara và @video_1 và @Video1', assets, ['a'])).toBe('@image_1 và @video_1 và @Video1')
  })
})
