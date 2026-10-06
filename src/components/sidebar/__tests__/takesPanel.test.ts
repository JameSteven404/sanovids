import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DragEvent } from 'react'
import { linkTakes } from '../../../actions'
import type { Scene, Take } from '../../../core/types'
import { readIds, TAKES_MIME } from '../../../lib/dnd'
import { useProject } from '../../../store/project'
import { useRuns } from '../../../store/runs'
import { useUI } from '../../../store/ui'
import { endTakeDrag, selectTake, startTakeDrag } from '../TakesPanel'

vi.mock('../../../actions', async (original) => ({ ...await original<typeof import('../../../actions')>(), focusNodes: vi.fn() }))

const settings: Scene['settings'] = { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' }
const scene = (id: string, order: number): Scene => ({ id, order, title: '', prompt: '', refs: [], videoRefs: [], presetId: null, settings, firstFrame: null, lastFrame: null, color: null, position: { x: 0, y: 0 }, note: '' })
const take = (id: string, number: number, status: Take['status'] = 'completed'): Take => ({
  id, number, sceneId: 'source', status, progress: 100, createdAt: number, finishedAt: number, startedAt: null,
  promptSnapshot: '', rawPromptSnapshot: '', refsSnapshot: [], videoRefsSnapshot: [], settings,
  cost: 0, starred: false, posterId: null, videoId: null, error: null, position: null,
})
const plain = { ctrlKey: false, metaKey: false, shiftKey: false }

describe('windowed take row actions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useProject.setState((s) => ({ project: { ...s.project, scenes: [scene('source', 1), scene('target', 2)] } }))
    useRuns.setState({ takes: [take('older', 1), take('newer', 2), take('running', 3, 'processing')] })
    useUI.setState({ selectedIds: [], draggingTakeIds: null, view: 'canvas', takeDisplay: 'all', toasts: [] })
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('carries selected completed takes even when their rows are not mounted, and links the same payload', () => {
    useUI.getState().select(['older', 'newer', 'running', 'target'])
    const data = new Map<string, string>()
    const dt = { effectAllowed: 'none', setData: (key: string, value: string) => data.set(key, value), getData: (key: string) => data.get(key) ?? '' } as unknown as DataTransfer
    startTakeDrag({ dataTransfer: dt } as DragEvent<HTMLElement>, 'older', null)
    expect(dt.effectAllowed).toBe('all')
    expect(readIds(dt, TAKES_MIME)).toEqual(['older', 'newer'])
    expect(useUI.getState().draggingTakeIds).toEqual(['older', 'newer'])
    linkTakes(['target'], readIds(dt, TAKES_MIME))
    expect(useProject.getState().project.scenes[1].videoRefs).toEqual(['older', 'newer'])
    endTakeDrag()
    expect(useUI.getState().draggingTakeIds).toBeNull()
    useUI.getState().select(['newer'])
    startTakeDrag({ dataTransfer: dt } as DragEvent<HTMLElement>, 'older', null)
    expect(readIds(dt, TAKES_MIME)).toEqual(['older'])
    endTakeDrag()
  })

  it('preserves plain selection and Ctrl/Shift/Meta toggles for click and Space', () => {
    selectTake(plain, 'older')
    expect(useUI.getState().selectedIds).toEqual(['older'])
    selectTake({ ...plain, ctrlKey: true }, 'newer')
    expect(useUI.getState().selectedIds).toEqual(['older', 'newer'])
    selectTake({ ...plain, shiftKey: true }, 'older')
    expect(useUI.getState().selectedIds).toEqual(['newer'])
    selectTake({ ...plain, metaKey: true }, 'older')
    expect(useUI.getState().selectedIds).toEqual(['newer', 'older'])
  })

  it('selects the scene with a toast for a hidden take, while other views select the take', () => {
    useUI.setState({ takeDisplay: 'chosen' })
    selectTake(plain, 'older')
    expect(useUI.getState().selectedIds).toEqual(['source'])
    expect(useUI.getState().toasts.at(-1)?.text).toContain('đang ẩn')
    useUI.setState({ view: 'storyboard' })
    selectTake(plain, 'older')
    expect(useUI.getState().selectedIds).toEqual(['older'])
  })
})
