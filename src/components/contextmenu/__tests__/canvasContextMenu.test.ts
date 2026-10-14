// The canvas' delegated right-click handler without a browser: what a right-click at a DOM element means (thumbnail →
// node → wire stack → empty canvas, no menu on the canvas' own controls), the native text menu kept in text fields and
// over selected text (never preventDefault there), and the Menu key / Shift+F10 path (never from a text field — the
// card prompt keeps its keys — and the browser's echo right after it ignored).
import type { MouseEvent as ReactMouseEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Scene } from '../../../core/types'
import { useProject } from '../../../store/project'
import { useRuns } from '../../../store/runs'
import { useUI } from '../../../store/ui'
import { onCanvasContextMenu, onCanvasMenuKey, resolveTarget, type CanvasMenuBridge } from '../canvasContextMenu'
import { useContextMenu } from '../contextMenuStore'

// ---- a tiny fake DOM: enough of Element for closest / getAttribute / classList ----
interface Fake {
  tagName: string
  parent: Fake | null
  attrs: Record<string, string>
  classList: string[] & { contains: (c: string) => boolean }
  isContentEditable: boolean
  closest: (sel: string) => Fake | null
  getAttribute: (name: string) => string | null
  contains: (other: unknown) => boolean
  getBoundingClientRect: () => { left: number; top: number; right: number; bottom: number; width: number; height: number }
}
const matchesOne = (n: Fake, simple: string) =>
  (simple.match(/\.[\w-]+|\[[^\]]+\]|^[a-z]+/gi) ?? []).every((part) => {
    if (part.startsWith('.')) return n.classList.includes(part.slice(1))
    if (part.startsWith('[')) {
      const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part) ?? []
      return name in n.attrs && (value === undefined || n.attrs[name] === value)
    }
    return n.tagName === part.toUpperCase()
  })
function el(tag: string, cls: string[] = [], attrs: Record<string, string> = {}, parent: Fake | null = null): Fake {
  const n: Fake = {
    tagName: tag.toUpperCase(),
    parent,
    attrs,
    classList: Object.assign([...cls], { contains: (c: string) => cls.includes(c) }),
    isContentEditable: attrs.contenteditable === 'true' || !!parent?.isContentEditable,
    closest: (sel) => {
      for (let x: Fake | null = n; x; x = x.parent) if (sel.split(',').some((s) => matchesOne(x!, s.trim()))) return x
      return null
    },
    getAttribute: (name) => attrs[name] ?? null,
    contains: (other) => {
      for (let x = other as Fake | null; x; x = x.parent) if (x === n) return true
      return false
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
  }
  return n
}
const asEl = (f: Fake) => f as unknown as Element

const stage = el('div', ['cv-stage'])
const pane = el('div', ['react-flow__pane'], {}, stage)
const nodeOf = (type: string, id: string) => el('div', ['react-flow__node', `react-flow__node-${type}`], { 'data-id': id }, pane)
const edge = (id: string) => el('path', ['react-flow__edge-path'], {}, el('g', ['react-flow__edge'], { 'data-id': id }, pane))

let under: Fake[] = []
let active: Fake | null = null
let selection: { isCollapsed: boolean; rangeCount: number; containsNode: () => boolean } | null = null
const body = el('body')

const scene = (id: string, order: number): Scene => ({
  id,
  order,
  title: '',
  prompt: 'Một cảnh',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 'i2v', duration: 5, resolution: '480p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: order * 400 },
  note: '',
})
const project: Project = { id: 'p1', name: 'P', schemaVersion: 2, createdAt: 0, updatedAt: 0, presets: [], settings: { autoRenumber: true }, assets: [], scenes: [scene('s1', 1)] }

beforeEach(() => {
  under = []
  active = null
  selection = null
  vi.stubGlobal('HTMLElement', class {})
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  vi.stubGlobal('window', { getSelection: () => selection })
  vi.stubGlobal('document', {
    get body() {
      return body
    },
    get activeElement() {
      return active ?? body
    },
    elementsFromPoint: () => under,
    querySelector: (sel: string) => (sel === '.cv-stage' ? stage : null),
  })
  useProject.getState().loadProject(project)
  useRuns.setState({ takes: [] })
  useUI.setState({ selectedIds: [], selectedEdgeIds: [], view: 'canvas', dialog: { kind: 'none' } })
  useContextMenu.setState({ open: null })
})
afterEach(() => {
  useContextMenu.setState({ open: null })
  vi.unstubAllGlobals()
})

const bridge: CanvasMenuBridge = { toFlow: (p) => p, busy: () => false, closeOthers: () => undefined }
const rightClick = (target: Fake) => {
  const e = { target, defaultPrevented: false, clientX: 50, clientY: 60, nativeEvent: { pointerType: 'mouse' }, preventDefault: vi.fn() }
  onCanvasContextMenu(e as unknown as ReactMouseEvent, bridge)
  return e
}
const menuKey = () => {
  const e = { key: 'F10', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn() }
  onCanvasMenuKey(e as unknown as KeyboardEvent, bridge)
  return e
}

describe('resolveTarget', () => {
  it('a thumbnail on a scene card wins over its node', () => {
    const thumb = el('span', ['cv-sn-th'], { 'data-ctx': 'ref', 'data-asset-id': 'a', 'data-scene-id': 's1' }, nodeOf('scene', 's1'))
    expect(resolveTarget(asEl(el('img', [], {}, thumb)), 0, 0)?.target).toEqual({ kind: 'ref', assetId: 'a', sceneId: 's1' })
  })
  it('a node of each kind; an unknown node type is no target', () => {
    for (const type of ['scene', 'take', 'asset', 'folder']) {
      const r = resolveTarget(asEl(el('div', [], {}, nodeOf(type, 'x1'))), 0, 0)
      expect(r?.target).toEqual({ kind: type, id: 'x1' })
      expect(r?.kind).toBe(type)
    }
    expect(resolveTarget(asEl(el('div', [], {}, el('div', ['react-flow__node', 'react-flow__node-group'], { 'data-id': 'g' }))), 0, 0)).toBeNull()
  })
  it('a wire: every wire under the point, the clicked one first, once each', () => {
    const top = edge('ref:a->s1')
    under = [top, edge('first:a->s2'), top, pane]
    expect(resolveTarget(asEl(top), 0, 0)?.target).toEqual({ kind: 'edges', ids: ['ref:a->s1', 'first:a->s2'] })
  })
  it('empty canvas → pane; the canvas controls and the card mention list → no canvas menu', () => {
    expect(resolveTarget(asEl(pane), 0, 0)?.target).toEqual({ kind: 'pane' })
    expect(resolveTarget(asEl(stage), 0, 0)?.target).toEqual({ kind: 'pane' })
    expect(resolveTarget(asEl(el('button', [], {}, el('div', ['cv-toolbar-host'], {}, stage))), 0, 0)).toBeNull()
    expect(resolveTarget(asEl(el('button', ['in-mention-item'], {}, el('div', ['cv-sn-mention'], {}, nodeOf('scene', 's1')))), 0, 0)).toBeNull()
  })
})

describe('right-click on the stage', () => {
  it('empty canvas: the default menu is stopped and the canvas menu opens', () => {
    const e = rightClick(pane)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(useContextMenu.getState().open?.spec.label).toBe('Menu nền canvas')
  })
  it('text fields (the card prompt, an input, contenteditable) and selected text keep the native text menu', () => {
    const card = nodeOf('scene', 's1')
    for (const target of [el('textarea', ['cv-sn-ta'], {}, card), el('input', [], { type: 'text' }, card), el('span', [], {}, el('div', [], { contenteditable: 'true' }, card))]) {
      expect(rightClick(target).preventDefault).not.toHaveBeenCalled()
    }
    selection = { isCollapsed: false, rangeCount: 1, containsNode: () => true }
    expect(rightClick(el('span', [], {}, card)).preventDefault).not.toHaveBeenCalled()
    expect(useContextMenu.getState().open).toBeNull()
  })
})

describe('Menu key / Shift+F10', () => {
  it('typing in the card prompt: nothing taken (no menu, no preventDefault) — the field keeps its keys', () => {
    active = el('textarea', ['cv-sn-ta'], {}, nodeOf('scene', 's1'))
    const e = menuKey()
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(e.stopPropagation).not.toHaveBeenCalled()
    expect(useContextMenu.getState().open).toBeNull()
  })
  it('focus outside the canvas: not the canvas menu', () => {
    active = el('button', ['sb-card'])
    expect(menuKey().preventDefault).not.toHaveBeenCalled()
    expect(useContextMenu.getState().open).toBeNull()
  })
  // Last: the echo window is module state.
  it('nothing focused: the empty-canvas menu opens; the browser contextmenu echo right after it opens nothing more', () => {
    const e = menuKey()
    expect(e.preventDefault).toHaveBeenCalled()
    const opened = useContextMenu.getState().open
    expect(opened).toMatchObject({ origin: 'keyboard', spec: { label: 'Menu nền canvas' } })
    const echo = rightClick(pane)
    expect(echo.preventDefault).toHaveBeenCalled()
    expect(useContextMenu.getState().open?.seq).toBe(opened!.seq)
  })
})
