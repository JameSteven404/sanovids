// Sano Agent "Tài liệu" windows (electron/sano-docs-rules.cjs): the pure allowlists, and createDocs against fake
// windows, a fake partition clear, a fake confirm dialog and a fake clock. Never a real window, never Google.
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

type Answer = { ok: true; value: undefined } | { ok: false; error: string; code: string }
interface Docs {
  open(input: unknown): Promise<Answer>
  endSession(): Promise<void>
  closeAll(o?: { ask?: boolean }): boolean
  confirmClose(): boolean
  track(parentKey: string, child: Win): boolean
  external(key: string, url: string): boolean
}
interface Rules {
  DRIVE_FILE_ID: RegExp
  PARTITION: string
  MAX_WINDOWS: number
  EXTERNAL_EVERY_MS: number
  TEXT: Record<string, string>
  docUrl(input: unknown): string | null
  navigationAllowed(url: unknown): boolean
  popupDecision(url: unknown): 'allow' | 'external' | 'deny'
  downloadAllowed(url: unknown): boolean
  permissionAllowed(p: unknown): boolean
  hostLabel(url: unknown): string
  createDocs(fx: Record<string, unknown>): Docs
}
const nodeRequire = createRequire(import.meta.url)
const R = nodeRequire('../../../electron/sano-docs-rules.cjs') as Rules

const ID = '1AbC-def_GhIjKlMnOp'
const DOC = 'https://docs.google.com/document/d/1AbC-def_GhIjKlMnOp/edit'

type Win = { url: string; key: string | null; focused: number; destroyed: boolean; focus(): void; destroy(): void; isDestroyed(): boolean; onClosed(cb: () => void): void; close(): void }
function fakeWindow(url: string, key: string | null): Win {
  const closed: (() => void)[] = []
  const w: Win = {
    url,
    key,
    focused: 0,
    destroyed: false,
    focus: () => void w.focused++,
    destroy: () => w.close(),
    isDestroyed: () => w.destroyed,
    onClosed: (cb) => void closed.push(cb),
    close: () => {
      if (w.destroyed) return
      w.destroyed = true
      for (const cb of closed) cb()
    },
  }
  return w
}

function setup(o: { signedIn?: boolean; clear?: () => Promise<void>; confirm?: (n: number) => boolean } = {}) {
  const windows: Win[] = []
  const logs: string[] = []
  const external: string[] = []
  const asked: number[] = []
  const state = { signedIn: o.signedIn ?? true, clears: 0, now: 0 }
  const docs = R.createDocs({
    openWindow: (url: string, key: string) => {
      const w = fakeWindow(url, key)
      windows.push(w)
      return w
    },
    clearPartition: () => {
      state.clears++
      return o.clear ? o.clear() : Promise.resolve()
    },
    signedIn: async () => state.signedIn,
    confirm: (n: number) => {
      asked.push(n)
      return o.confirm ? o.confirm(n) : true
    },
    openExternal: (url: string) => void external.push(url),
    now: () => state.now,
    log: (line: string) => void logs.push(line),
  })
  return { docs, windows, logs, external, asked, state }
}
const open = (docs: Docs, n: number, kind = 'docs') => docs.open({ id: `${ID}${n}`, kind })
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('sano-docs-rules', () => {
  it('docUrl exact URLs; refuses bad id/kind', () => {
    expect(R.docUrl({ id: ID, kind: 'docs' })).toBe(DOC)
    expect(R.docUrl({ id: ID, kind: 'sheets' })).toBe(`https://docs.google.com/spreadsheets/d/${ID}/edit`)
    expect(R.docUrl({ id: 'a'.repeat(200), kind: 'docs' })).not.toBeNull()
    for (const bad of [
      { id: 'a'.repeat(201), kind: 'docs' },
      { id: 'short', kind: 'docs' },
      { id: 'demo-1', kind: 'docs' },
      { id: `${ID}/../x`, kind: 'docs' },
      { id: `${ID}?x=1`, kind: 'docs' },
      { id: ID, kind: 'slides' },
      { id: ID, kind: 'constructor' },
      { id: ID },
      { kind: 'docs' },
      null,
      ID,
    ])
      expect(R.docUrl(bad)).toBeNull()
    expect(R.DRIVE_FILE_ID.source).toBe('^[A-Za-z0-9_-]{10,200}$') // identical to SANO shared/assistant.ts
    expect(R.PARTITION).toBe('sano-google-docs') // no persist: prefix: in memory
  })

  it('navigation allowlist: hosts, https only, www.google.com only /accounts/, userinfo/port refused', () => {
    for (const ok of [
      DOC,
      'https://drive.google.com/drive/folders/abc',
      'https://accounts.google.com/v3/signin/identifier?continue=x',
      'https://accounts.youtube.com/accounts/SetSID',
      'https://www.google.com/accounts/CheckCookie?x=1',
      'https://DOCS.google.com/x',
      'https://docs.google.com:443/x',
    ])
      expect(R.navigationAllowed(ok), ok).toBe(true)
    for (const bad of [
      'http://docs.google.com/x',
      'https://www.google.com/search?q=x',
      'https://www.google.com/accountsx',
      'https://mail.google.com/',
      'https://docs.google.com.evil.example/',
      'https://docs.google.com./x',
      'https://user@docs.google.com/x',
      'https://user:pw@docs.google.com/x',
      'https://docs.google.com:8443/x',
      'https://evil.example/https://docs.google.com/',
      'javascript:alert(1)',
      'about:blank',
      'not a url',
      42,
    ])
      expect(R.navigationAllowed(bad), String(bad)).toBe(false)
  })

  it('popups allow/external/deny; popups count toward the cap of 20', async () => {
    expect(R.popupDecision(DOC)).toBe('allow')
    expect(R.popupDecision('https://accounts.google.com/x')).toBe('allow')
    expect(R.popupDecision('https://example.com/page')).toBe('external')
    expect(R.popupDecision('http://docs.google.com/x')).toBe('deny') // http is not followed out either
    expect(R.popupDecision('mailto:a@sanogroup.tv')).toBe('external')
    for (const deny of ['about:blank', 'javascript:alert(1)', 'data:text/html,x', 'blob:https://docs.google.com/x', 'file:///C:/x', ''])
      expect(R.popupDecision(deny), deny).toBe('deny')

    const { docs, windows } = setup()
    expect((await open(docs, 0)).ok).toBe(true)
    const popups = Array.from({ length: R.MAX_WINDOWS }, (_, i) => fakeWindow(`https://accounts.google.com/${i}`, null))
    for (const p of popups.slice(0, R.MAX_WINDOWS - 1)) expect(docs.track(`docs:${ID}0`, p)).toBe(true)
    const last = popups[R.MAX_WINDOWS - 1]
    expect(docs.track(`docs:${ID}0`, last)).toBe(false) // 1 document + 19 popups = 20
    expect(last.destroyed).toBe(true)
    expect(await open(docs, 1)).toEqual({ ok: false, error: R.TEXT.tooMany, code: 'too-many' })
    popups[0].close() // a popup closed by Google frees its slot
    expect((await open(docs, 1)).ok).toBe(true)
    expect(windows.length).toBe(2)
    // popups go with their documents on closeAll
    expect(docs.closeAll({ ask: false })).toBe(true)
    expect(popups.every((p) => p.destroyed)).toBe(true)
  })

  it('external: at most one openExternal per window every 2 s (fake clock), the rest logged', async () => {
    const { docs, external, logs, state } = setup()
    expect(docs.external('docs:a', 'https://example.com/a?secret=1')).toBe(true)
    expect(docs.external('docs:a', 'https://example.com/b?secret=1')).toBe(false)
    expect(docs.external('docs:b', 'mailto:x@sanogroup.tv')).toBe(true) // another window has its own budget
    state.now = R.EXTERNAL_EVERY_MS - 1
    expect(docs.external('docs:a', 'https://example.com/c')).toBe(false)
    state.now = R.EXTERNAL_EVERY_MS
    expect(docs.external('docs:a', 'https://example.com/d')).toBe(true)
    expect(docs.external('docs:c', 'javascript:alert(1)')).toBe(false) // never handed to the system
    expect(docs.external('docs:c', 'file:///C:/Windows/x.exe')).toBe(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(external).toEqual(['https://example.com/a?secret=1', 'mailto:x@sanogroup.tv', 'https://example.com/d'])
    expect(logs).toEqual(['[SanoVids] docs: external throttled example.com', '[SanoVids] docs: external throttled example.com'])
    expect(logs.join('\n')).not.toContain('secret')
  })

  it('downloads allowlist: docs.google.com, doc-*-docs.googleusercontent.com, blob:https://docs.google.com; other googleusercontent refused', () => {
    for (const ok of [
      'https://docs.google.com/document/d/x/export?format=docx',
      'https://doc-0k-2c-docs.googleusercontent.com/docs/securesc/x',
      'blob:https://docs.google.com/5b0c7c1e-1111-2222-3333-444455556666',
    ])
      expect(R.downloadAllowed(ok), ok).toBe(true)
    for (const bad of [
      'https://lh3.googleusercontent.com/x',
      'https://evil-docs.googleusercontent.com/x',
      'https://doc-x-docs.googleusercontent.com.evil.example/x',
      'https://doc-0k-docs.googleusercontent.com:8443/x',
      'http://docs.google.com/x',
      'https://user@docs.google.com/x',
      'blob:https://docs.google.com.evil.example/x',
      'blob:https://drive.google.com/x',
      'blob:app://bdp/x',
      'data:text/plain,x',
      'https://drive.google.com/uc?export=download',
      null,
    ])
      expect(R.downloadAllowed(bad), String(bad)).toBe(false)
    expect(R.hostLabel('https://doc-0k-docs.googleusercontent.com/docs/securesc/x?id=1')).toBe('doc-0k-docs.googleusercontent.com')
    expect(R.hostLabel('blob:https://docs.google.com/uuid')).toBe('docs.google.com')
    expect(R.hostLabel('mailto:x@sanogroup.tv')).toBe('mailto:')
    expect(R.hostLabel('nope')).toBe('not-a-url')
  })

  it('permissions: only clipboard-sanitized-write', () => {
    expect(R.permissionAllowed('clipboard-sanitized-write')).toBe(true)
    for (const p of ['clipboard-read', 'notifications', 'media', 'geolocation', 'fullscreen', 'fileSystem', 'persistent-storage', 'openExternal', '', undefined])
      expect(R.permissionAllowed(p), String(p)).toBe(false)
  })

  it('one window per document, focus existing, cap 20, signed-out refused', async () => {
    const out = setup({ signedIn: false })
    expect(await open(out.docs, 0)).toEqual({ ok: false, error: R.TEXT.signedOut, code: 'signed-out' })
    expect([out.windows.length, out.state.clears]).toEqual([0, 0])
    expect(await out.docs.open({ id: 'demo-1', kind: 'docs' })).toEqual({ ok: false, error: R.TEXT.badInput, code: 'bad-input' })

    const { docs, windows } = setup()
    expect(await docs.open({ id: ID, kind: 'docs' })).toEqual({ ok: true, value: undefined })
    expect([windows[0].url, windows[0].key]).toEqual([DOC, `docs:${ID}`])
    expect((await docs.open({ id: ID, kind: 'docs' })).ok).toBe(true)
    expect([windows.length, windows[0].focused]).toEqual([1, 1])
    expect((await docs.open({ id: ID, kind: 'sheets' })).ok).toBe(true) // another kind: another document
    expect(windows.length).toBe(2)
    windows[0].close()
    expect((await docs.open({ id: ID, kind: 'docs' })).ok).toBe(true) // closed: opens again
    expect(windows.length).toBe(3)
    for (let i = 0; windows.filter((w) => !w.destroyed).length < R.MAX_WINDOWS; i++) expect((await open(docs, i)).ok).toBe(true)
    expect(await open(docs, 99)).toEqual({ ok: false, error: R.TEXT.tooMany, code: 'too-many' })
    expect((await docs.open({ id: ID, kind: 'docs' })).ok).toBe(true) // an open one still focuses at the cap
  })

  it('first open after start clears; clear failure → next open retries, refuses with failed if it fails again', async () => {
    let failing = 2
    const { docs, windows, logs, state } = setup({
      clear: async () => {
        if (failing-- > 0) throw new Error('busy')
      },
    })
    expect(await open(docs, 0)).toEqual({ ok: false, error: R.TEXT.notCleared, code: 'failed' })
    expect(await open(docs, 0)).toEqual({ ok: false, error: R.TEXT.notCleared, code: 'failed' })
    expect([windows.length, state.clears]).toEqual([0, 2])
    expect(logs).toEqual(['[SanoVids] docs: clear failed (Error)', '[SanoVids] docs: clear failed (Error)'])
    expect((await open(docs, 0)).ok).toBe(true)
    expect((await open(docs, 1)).ok).toBe(true)
    expect(state.clears).toBe(3) // once clean, opens do not clear again
  })

  it('open called in the same tick as endSession waits for it', async () => {
    const gates: (() => void)[] = []
    let gated = false
    const { docs, windows, state } = setup({ clear: () => (gated ? new Promise<void>((r) => void gates.push(r)) : Promise.resolve()) })
    expect((await open(docs, 0)).ok).toBe(true)
    gated = true
    const ended = docs.endSession()
    expect(windows[0].destroyed).toBe(true) // in the same tick
    const opening = open(docs, 1)
    await tick()
    expect([windows.length, gates.length]).toEqual([1, 1]) // still waiting for the clear
    gates.shift()!()
    await ended
    expect((await opening).ok).toBe(true)
    expect([windows.length, state.clears]).toEqual([2, 2])

    // an open still checking the sign-in when the session ends is refused, not opened for whoever signs in next
    const raced = open(docs, 2)
    const ended2 = docs.endSession()
    await tick()
    gates.shift()!()
    await ended2
    expect(await raced).toEqual({ ok: false, error: R.TEXT.signedOut, code: 'signed-out' })
    expect(windows.length).toBe(2)

    // a clear that started before endSession does not mark the partition clean: endSession's own clear decides
    const fresh = setup({ clear: () => new Promise<void>((r) => void gates.push(r)) })
    const first = open(fresh.docs, 0)
    await tick() // the open's clear is running
    const end = fresh.docs.endSession()
    gates.shift()!()
    expect(await first).toEqual({ ok: false, error: R.TEXT.signedOut, code: 'signed-out' })
    const second = open(fresh.docs, 0)
    await tick()
    expect([fresh.windows.length, gates.length]).toEqual([0, 1]) // waits for endSession's clear
    gates.shift()!()
    await end
    expect((await second).ok).toBe(true)
    expect(fresh.state.clears).toBe(2)
  })

  it('endSession destroys all windows then clears storage and cache; failures logged, not thrown', async () => {
    const { docs, windows, logs, state } = setup({ clear: async () => { if (state.clears > 1) throw new TypeError('locked') } })
    expect((await open(docs, 0)).ok).toBe(true)
    expect((await open(docs, 1)).ok).toBe(true)
    const popup = fakeWindow('https://accounts.google.com/x', null)
    expect(docs.track(`docs:${ID}0`, popup)).toBe(true)
    windows[1].destroy = () => {
      throw new RangeError('gone')
    }
    await expect(docs.endSession()).resolves.toBeUndefined()
    expect([windows[0].destroyed, popup.destroyed]).toEqual([true, true])
    expect(logs).toEqual(['[SanoVids] docs: destroy failed (RangeError)', '[SanoVids] docs: clear failed (TypeError)'])
    expect(await open(docs, 0)).toEqual({ ok: false, error: R.TEXT.notCleared, code: 'failed' }) // still dirty
    expect(logs.join('\n')).not.toContain(ID)
  })

  it('closeAll: no window → true without asking; ask declined → false, windows kept; accepted → all destroyed', async () => {
    let answer = false
    const { docs, windows, asked, state } = setup({ confirm: () => answer })
    expect(docs.closeAll({ ask: true })).toBe(true)
    expect(asked).toEqual([])
    expect((await open(docs, 0)).ok).toBe(true)
    expect((await open(docs, 1)).ok).toBe(true)
    expect(docs.closeAll({ ask: true })).toBe(false)
    expect(asked).toEqual([2])
    expect(windows.some((w) => w.destroyed)).toBe(false)
    answer = true
    expect(docs.closeAll({ ask: true })).toBe(true)
    expect(windows.every((w) => w.destroyed)).toBe(true)
    expect((await open(docs, 0)).ok).toBe(true) // the same session: no new clear
    expect(state.clears).toBe(1)
    expect(docs.closeAll({ ask: false })).toBe(true) // the main window is gone: no question
    expect(asked).toEqual([2, 2])
  })

  it('confirmClose: no window → true without asking; otherwise the answer, and no window destroyed either way', async () => {
    let answer = false
    const { docs, windows, asked } = setup({ confirm: () => answer })
    expect(docs.confirmClose()).toBe(true)
    expect(asked).toEqual([])
    expect((await open(docs, 0)).ok).toBe(true)
    expect(docs.confirmClose()).toBe(false)
    answer = true
    expect(docs.confirmClose()).toBe(true)
    expect(asked).toEqual([1, 1])
    expect(windows.some((w) => w.destroyed)).toBe(false)
  })
})
