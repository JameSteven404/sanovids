// "Phát liền" commands: never an empty player (it would hold every key until Esc), the snapshot it plays, and
// "Chọn N cảnh chưa có ★".
import { beforeEach, describe, expect, it } from 'vitest'
import { canvasEvents } from '../actions'
import type { Project, Scene, Take } from '../core/types'
import { closeEmptyPlayer, currentFilm, openFilmPlayer, selectMissingStar } from '../filmActions'
import { useProject } from '../store/project'
import { useRuns } from '../store/runs'
import { useUI } from '../store/ui'

const scene = (i: number): Scene => ({
  id: 's' + (i + 1),
  order: i + 1,
  title: '',
  prompt: '',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 10, resolution: '1080p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: i * 400 },
  note: '',
})
const project = (n: number): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [],
  scenes: Array.from({ length: n }, (_, i) => scene(i)),
})
const take = (id: string, sceneId: string, starred = false): Take => ({
  id,
  sceneId,
  number: 1,
  status: 'completed',
  progress: 100,
  createdAt: 1,
  startedAt: null,
  finishedAt: null,
  promptSnapshot: '',
  rawPromptSnapshot: '',
  refsSnapshot: [],
  videoRefsSnapshot: [],
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '1080p', ratio: '16:9' },
  cost: 1,
  starred,
  posterId: null,
  videoId: null,
  error: null,
  position: null,
})

const ui = () => useUI.getState()
const texts = () => ui().toasts.map((t) => t.text)

beforeEach(() => {
  useUI.setState({ dialog: { kind: 'none' }, toasts: [], selectedIds: [] })
  useRuns.setState({ takes: [] })
})

describe('openFilmPlayer', () => {
  it('refuses a project without scenes: a toast, no dialog', () => {
    useProject.getState().loadProject(project(0))
    expect(openFilmPlayer()).toBe(false)
    expect(ui().dialog).toEqual({ kind: 'none' })
    expect(texts()).toEqual(['Dự án chưa có cảnh nào để phát liền.'])
  })
  it('opens the player dialog from the given scene place', () => {
    useProject.getState().loadProject(project(3))
    expect(openFilmPlayer()).toBe(true)
    expect(ui().dialog).toEqual({ kind: 'player', start: 0 })
    expect(openFilmPlayer(2)).toBe(true)
    expect(ui().dialog).toEqual({ kind: 'player', start: 2 })
    expect(texts()).toEqual([])
  })
})

describe('the snapshot the player plays', () => {
  it('null without scenes; else every scene in order with the summary', () => {
    useProject.getState().loadProject(project(0))
    expect(currentFilm()).toBeNull()
    useProject.getState().loadProject(project(3))
    useRuns.setState({ takes: [take('t1', 's1', true), take('t3', 's3')] })
    const film = currentFilm()
    expect(film?.items.map((i) => i.take?.id ?? null)).toEqual(['t1', null, 't3'])
    expect(film?.summary).toMatchObject({ scenes: 3, withTake: 2, missingStarIds: ['s2', 's3'] })
  })
  it('an empty player closes itself and explains (the shortcuts work again)', () => {
    useProject.getState().loadProject(project(2))
    openFilmPlayer()
    useProject.getState().loadProject(project(0))
    closeEmptyPlayer()
    expect(ui().dialog).toEqual({ kind: 'none' })
    expect(texts()).toEqual(['Dự án chưa có cảnh nào để phát liền.'])
  })
  it('the guard never closes another dialog', () => {
    useUI.setState({ dialog: { kind: 'settings' } })
    closeEmptyPlayer()
    expect(ui().dialog).toEqual({ kind: 'settings' })
  })
})

describe('"Chọn N cảnh chưa có ★"', () => {
  it('closes the player, selects those scenes and shows them on the canvas', () => {
    useProject.getState().loadProject(project(4))
    openFilmPlayer()
    const focused: unknown[] = []
    const onFocus = (e: Event) => focused.push((e as CustomEvent).detail)
    canvasEvents.addEventListener('focus', onFocus)
    try {
      selectMissingStar(['s2', 's4', 'gone'])
    } finally {
      canvasEvents.removeEventListener('focus', onFocus)
    }
    expect(ui().dialog).toEqual({ kind: 'none' })
    expect(ui().selectedIds).toEqual(['s2', 's4'])
    expect(focused).toEqual([['s2', 's4']])
    expect(texts()).toEqual(['Đã chọn 2 cảnh chưa có take ★.'])
  })
  it('nothing left to select: just closes', () => {
    useProject.getState().loadProject(project(1))
    openFilmPlayer()
    selectMissingStar(['gone'])
    expect(ui().dialog).toEqual({ kind: 'none' })
    expect(ui().selectedIds).toEqual([])
    expect(texts()).toEqual([])
  })
})
