// The user's rule (GT1): "khi cắt ảnh tham chiếu khỏi node KHÔNG ĐƯỢC XÓA TEXT TRONG PROMPT". Every removal of a
// reference picture turns its token into a red placeholder; no path may go back to replacing it with a name or nothing.
// A guard on the source (who may call remapTokens, and how) + the old wording that described the name fallback.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')

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

/** Source files (relative, forward slashes) whose code calls remapTokens( — the definition itself excluded. */
function remapCallers(): Map<string, string> {
  const out = new Map<string, string>()
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8')
    const rel = relative(SRC, file).replace(/\\/g, '/')
    const calls = text.split('\n').filter((l) => /\bremapTokens\(/.test(l) && !/export function remapTokens/.test(l) && !/^\s*(\/\/|\*)/.test(l))
    if (calls.length) out.set(rel, text)
  }
  return out
}

describe('removing a reference picture never deletes prompt text (source guard)', () => {
  it('remapTokens is called only where the placeholder rule is applied (or the explicit "undo auto link")', () => {
    const callers = [...remapCallers().keys()].sort()
    expect(callers).toEqual(['components/inspector/tokens.ts', 'components/runs/restore.ts', 'core/placeholders.ts', 'store/project.ts'])
  })
  it('the store and the restore pass the placeholder option (never a name fallback)', () => {
    for (const rel of ['store/project.ts', 'components/runs/restore.ts']) {
      const text = read(rel)
      const calls = text.split('remapTokens(').slice(1)
      expect(calls.length, rel).toBeGreaterThan(0)
      for (const call of calls) expect(call.slice(0, 260), rel).toMatch(/placeholder/)
    }
    expect(read('store/project.ts')).not.toMatch(/imageFallbackNames/)
  })
  it('only renumberImageTokens (the prompt editor\'s explicit "undo auto link", which promises names) keeps the name fallback', () => {
    const tokens = read('components/inspector/tokens.ts')
    const at = tokens.indexOf('remapTokens(prompt')
    expect(at).toBeGreaterThan(tokens.indexOf('export function renumberImageTokens'))
  })
  it('no UI text still says the removed picture "đổi thành tên"', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8')
      if (/đổi thành tên|đã đánh lại số trong prompt \(ảnh/.test(text)) offenders.push(relative(SRC, file))
    }
    expect(offenders).toEqual([])
  })
  it('the scene inspector renders the always-available bar under the prompt editor', () => {
    const si = read('components/inspector/SceneInspector.tsx')
    expect(si).toMatch(/<PromptEditor sceneId=\{sceneId\} \/>\s*<PlaceholderBar sceneId=\{sceneId\} \/>/)
  })
  it('every removal toast goes through mediaChangeNote (red placeholders are announced)', () => {
    for (const rel of ['components/canvas/edges.tsx', 'actions.ts', 'placeholderActions.ts']) expect(read(rel), rel).toMatch(/mediaChangeNote\(/)
    for (const rel of ['components/inspector/SceneInspector.tsx', 'components/inspector/MultiSceneInspector.tsx', 'components/sidebar/assetImages.ts', 'components/sidebar/AssetDialog.tsx']) {
      expect(read(rel), rel).toMatch(/reportMediaChange\(/)
    }
  })
})
