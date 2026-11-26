// SanoVids side of the SANO bridge (D230): which messages are accepted, what is posted back, and that the compact
// layout stays scoped to <html data-embedded> (standalone SanoVids unchanged).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { helloFeatures, OPEN_ASSISTANT, parentOriginOf, postOpenAssistant } from '../sanoBridge'

// Read from disk: vitest hands `?raw` CSS imports back empty.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mainSource = read('../../main.tsx')
const topbarTsx = read('../../components/topbar/TopBar.tsx')
const topbarCss = read('../../components/topbar/topbar.css')
const runsCss = read('../../components/runs/runs.css')
const inspectorCss = read('../../components/inspector/inspector.css')
const bridgeSource = read('../sanoBridge.ts')

const SANO = 'app://bdp'
const parent = { name: 'parent' }
const hello = { source: 'sano', type: 'hello', features: ['assistant'] }
const msg = (data: unknown, over: { source?: unknown; origin?: string } = {}) => ({ source: parent, origin: SANO, data, ...over })

describe('parentOriginOf', () => {
  it('is the first ancestor origin when framed', () => {
    expect(parentOriginOf(true, ['http://127.0.0.1:5173'])).toBe('http://127.0.0.1:5173')
    expect(parentOriginOf(true, [SANO, 'https://x'])).toBe(SANO)
  })
  it('is null when not framed, without ancestor origins (Firefox), or for opaque / file origins', () => {
    expect(parentOriginOf(false, ['http://a'])).toBeNull()
    expect(parentOriginOf(true, undefined)).toBeNull()
    expect(parentOriginOf(true, null)).toBeNull()
    expect(parentOriginOf(true, [])).toBeNull()
    expect(parentOriginOf(true, ['null'])).toBeNull()
    expect(parentOriginOf(true, ['file://'])).toBeNull()
  })
})

describe('helloFeatures', () => {
  it("accepts SANO's hello from the parent window and origin", () => {
    expect(helloFeatures(msg(hello), parent, SANO)).toEqual(['assistant'])
  })
  it('rejects another window, another origin, or no known parent origin', () => {
    expect(helloFeatures(msg(hello, { source: { name: 'other' } }), parent, SANO)).toBeNull()
    expect(helloFeatures(msg(hello, { source: null }), parent, SANO)).toBeNull()
    expect(helloFeatures(msg(hello, { origin: 'https://evil.example' }), parent, SANO)).toBeNull()
    expect(helloFeatures(msg(hello), parent, null)).toBeNull()
  })
  it('rejects anything but the hello shape', () => {
    expect(helloFeatures(msg({ ...hello, source: 'sanovids' }), parent, SANO)).toBeNull()
    expect(helloFeatures(msg({ ...hello, type: 'open-assistant' }), parent, SANO)).toBeNull()
    expect(helloFeatures(msg({ ...hello, features: 'assistant' }), parent, SANO)).toBeNull()
    expect(helloFeatures(msg({ source: 'sano', type: 'hello' }), parent, SANO)).toBeNull()
    expect(helloFeatures(msg(null), parent, SANO)).toBeNull()
    expect(helloFeatures(msg('hello'), parent, SANO)).toBeNull()
  })
  it('keeps only string features; an empty list offers no assistant', () => {
    expect(helloFeatures(msg({ ...hello, features: ['assistant', 1, null, { a: 1 }, 'x'] }), parent, SANO)).toEqual(['assistant', 'x'])
    expect(helloFeatures(msg({ ...hello, features: [] }), parent, SANO)).toEqual([])
  })
})

describe('postOpenAssistant', () => {
  const fake = () => {
    const posted: [unknown, string][] = []
    return { posted, target: { postMessage: (m: unknown, o: string) => void posted.push([m, o]) } }
  }
  it('posts exactly { source, type } to the parent origin', () => {
    const { posted, target } = fake()
    expect(postOpenAssistant(target, SANO)).toBe(true)
    expect(posted).toEqual([[{ source: 'sanovids', type: 'open-assistant' }, SANO]])
    expect(Object.keys(posted[0][0] as object)).toEqual(['source', 'type'])
    expect(OPEN_ASSISTANT).toEqual({ source: 'sanovids', type: 'open-assistant' })
  })
  it('posts nothing without a parent origin', () => {
    const { posted, target } = fake()
    expect(postOpenAssistant(target, null)).toBe(false)
    expect(posted).toEqual([])
  })
})

describe('wiring', () => {
  it('main.tsx starts the bridge before React (the single hello comes on the frame load)', () => {
    const init = mainSource.indexOf('initSanoBridge()')
    expect(init).toBeGreaterThan(0)
    expect(init).toBeLessThan(mainSource.indexOf('createRoot('))
  })
  it('never posts to any origin', () => {
    expect(bridgeSource).not.toMatch(/postMessage\([^)]*['"]\*['"]/)
  })
  it('hides only under :root[data-embedded]; the guide button is hidden outside it', () => {
    const css = [topbarCss, runsCss, inspectorCss].join('\n').replace(/\/\*[\s\S]*?\*\//g, '')
    const hidden = /\.(tb-brand|tb-import|tb-keys|rq-bar-credit|in-tips)(?![\w-])[^{}]*\{\s*display: none;/
    const rules = (css.match(/[^{}]+\{[^{}]*\}/g) ?? []).filter((rule) => hidden.test(rule))
    expect(rules).toHaveLength(3)
    for (const rule of rules) expect(rule.trim(), rule).toMatch(/^:root\[data-embedded\]/)
    expect(inspectorCss).toMatch(/\n\.btn\.in-guide \{\s*display: none;\s*\}/)
    expect(inspectorCss).toMatch(/:root\[data-embedded\] \.btn\.in-guide \{\s*display: inline-flex;/)
  })
  it('the top bar shows "Trợ lý" only once SANO offered it', () => {
    expect(topbarTsx).toMatch(/\{assistant && \(\s*<div className="tb-pill">\s*<AssistantButton \/>/)
    const button = topbarTsx.slice(topbarTsx.indexOf('function AssistantButton()'))
    expect(button).toMatch(/onClick=\{\(\) => openSanoAssistant\(\)\} title="Mở trợ lý dự án của SANO"/)
    expect(button).toMatch(/<span>Trợ lý<\/span>/)
  })
})
