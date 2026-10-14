// The lazy menu host's boundary: a chunk that did not load or a crashing menu closes the menu with a toast (never a
// blank window), and only a chunk failure asks App for a fresh lazy import so the next menu tries again.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useUI } from '../../../store/ui'
import { ContextMenuBoundary } from '../ContextMenuBoundary'
import { openContextMenu, useContextMenu } from '../contextMenuStore'

const open = () => openContextMenu({ spec: { label: 'Menu', entries: [] }, origin: 'mouse', returnFocus: null })
const errorToasts = () => useUI.getState().toasts.filter((t) => t.tone === 'error')

afterEach(() => {
  useContextMenu.setState({ open: null })
  useUI.setState({ toasts: [] })
  vi.restoreAllMocks()
})

describe('ContextMenuBoundary', () => {
  it('a chunk that did not load: the menu closes, a toast explains, App is asked for a new lazy import', () => {
    open()
    const onChunkError = vi.fn()
    const boundary = new ContextMenuBoundary({ children: null, onChunkError })
    expect(ContextMenuBoundary.getDerivedStateFromError()).toEqual({ failed: true })
    boundary.componentDidCatch(new TypeError('Failed to fetch dynamically imported module: app://bdp/assets/ContextMenuHost-x.js'))
    expect(onChunkError).toHaveBeenCalledTimes(1)
    expect(useContextMenu.getState().open).toBeNull()
    expect(errorToasts()).toHaveLength(1)
  })

  it('a menu that crashed while rendering: closed with a toast, the loaded chunk is kept', () => {
    open()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onChunkError = vi.fn()
    new ContextMenuBoundary({ children: null, onChunkError }).componentDidCatch(new Error('icon missing'))
    expect(onChunkError).not.toHaveBeenCalled()
    expect(useContextMenu.getState().open).toBeNull()
    expect(errorToasts()[0]?.text).toContain('icon missing')
  })

  it('App wraps the lazy host in it and renews the lazy import on a chunk failure', () => {
    const app = readFileSync(new URL('../../../App.tsx', import.meta.url), 'utf8')
    expect(app).toMatch(/<ContextMenuBoundary onChunkError=\{\(\) => \(ContextMenuHost = lazyContextMenuHost\(\)\)\}>\s*<Suspense fallback=\{null\}>\s*<ContextMenuHost \/>/)
  })
})
