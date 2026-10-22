// "Phát liền": the film's items (scene order, the take each scene plays, durations) and the numbers about it.
import { beforeEach, describe, expect, it } from 'vitest'
import { chosenTakeIds } from '../../actions'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { buildFilmItems, filmRuntime, filmRuntimeOf, filmSummary, formatRuntime, pickShowcaseTake, runtimeText, starredTake } from '../filmItems'
import type { ImportedField, JobStatus, Project, Scene, Take } from '../types'

const scene = (i: number, over: Partial<Scene> = {}): Scene => ({
  id: 's' + (i + 1),
  order: i + 1,
  title: 'Cảnh ' + (i + 1),
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
  ...over,
})
const take = (
  id: string,
  sceneId: string,
  number: number,
  over: { starred?: boolean; status?: JobStatus; duration?: number; unknown?: ImportedField[]; inferred?: ImportedField[] } = {},
): Take => ({
  id,
  sceneId,
  number,
  status: over.status ?? 'completed',
  progress: 100,
  createdAt: number,
  startedAt: null,
  finishedAt: null,
  promptSnapshot: '',
  rawPromptSnapshot: '',
  refsSnapshot: [],
  videoRefsSnapshot: [],
  settings: { model: 'seedance_2_5', mode: 't2v', duration: over.duration ?? 5, resolution: '1080p', ratio: '16:9' },
  cost: 1,
  starred: over.starred ?? false,
  posterId: null,
  videoId: null,
  error: null,
  position: null,
  // imported with "Nhập job": `unknown` fields hold placeholders (components/runs/importedTake)
  ...(over.unknown || over.inferred ? { imported: { at: 0, jobName: null, unknown: over.unknown ?? [], inferred: over.inferred ?? [] } } : {}),
})
const project = (scenes: Scene[]): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [],
  scenes,
})

describe('buildFilmItems', () => {
  it('follows the scene order, not the array order', () => {
    const scenes = [scene(0, { order: 3 }), scene(1, { order: 1 }), scene(2, { order: 2 })]
    expect(buildFilmItems(scenes, []).map((i) => [i.sceneId, i.code])).toEqual([
      ['s2', 'S01'],
      ['s3', 'S02'],
      ['s1', 'S03'],
    ])
  })
  it('a scene without a finished take plays its slate for the scene duration', () => {
    const items = buildFilmItems([scene(0)], [take('t1', 's1', 1, { status: 'failed' }), take('t2', 's1', 2, { status: 'processing' })])
    expect(items).toEqual([{ sceneId: 's1', code: 'S01', title: 'Cảnh 1', take: null, duration: 10 }])
  })
  it('the ★ take wins over a newer one; failed / running / queued / cancelled takes are skipped', () => {
    const takes = [
      take('t1', 's1', 1, { starred: true, duration: 8 }),
      take('t2', 's1', 2),
      take('t3', 's1', 3, { status: 'failed', starred: true }),
      take('t4', 's2', 1, { duration: 7 }),
      take('t5', 's2', 2, { status: 'processing' }),
      take('t6', 's2', 3, { status: 'queued' }),
      take('t7', 's2', 4, { status: 'cancelled' }),
    ]
    const items = buildFilmItems([scene(0), scene(1)], takes)
    expect(items.map((i) => [i.take?.id ?? null, i.duration])).toEqual([
      ['t1', 8],
      ['t4', 7],
    ])
    expect(pickShowcaseTake(takes.filter((t) => t.sceneId === 's1'))?.id).toBe('t1')
    expect(starredTake(takes.filter((t) => t.sceneId === 's2'))).toBeUndefined()
  })
})

describe('same pick as the .zip (actions.chosenTakeIds) with at most one ★ per scene', () => {
  beforeEach(() => {
    useProject.getState().loadProject(project([scene(0), scene(1), scene(2), scene(3)]))
    useProject.temporal.getState().clear()
  })
  it('playable items = the zip takes, in the same order', () => {
    const takes = [
      take('a1', 's1', 1),
      take('a2', 's1', 2),
      take('b1', 's2', 1, { starred: true }),
      take('b2', 's2', 2),
      take('c1', 's3', 1, { status: 'failed' }),
      take('d1', 's4', 1, { status: 'processing' }),
    ]
    useRuns.setState({ takes })
    useProject.getState().moveScene('s2', 1)
    const items = buildFilmItems(useProject.getState().project.scenes, takes)
    const playing = items.flatMap((i) => (i.take ? [i.take.id] : []))
    expect(playing).toEqual(chosenTakeIds())
    expect(playing).toEqual(['b1', 'a2'])
  })
})

it('formatRuntime', () => {
  expect(formatRuntime(95)).toBe('1:35')
  expect(formatRuntime(30)).toBe('0:30')
  expect(formatRuntime(3725)).toBe('1:02:05')
  expect(formatRuntime(-4)).toBe('0:00')
})

it('filmSummary: scenes with a take, scenes without ★ (in scene order), seconds played and planned', () => {
  const scenes = [scene(0, { order: 2 }), scene(1, { order: 1 }), scene(2, { order: 3, settings: { ...scene(2).settings, duration: 15 } })]
  const takes = [take('t1', 's1', 1, { starred: true, duration: 6 }), take('t2', 's2', 1, { duration: 4 }), take('t3', 's3', 1, { status: 'failed', starred: true })]
  expect(filmSummary(scenes, takes)).toEqual({ scenes: 3, withTake: 2, missingStarIds: ['s2', 's3'], totalS: 10, unknown: 0, inferred: 0, plannedS: 35 })
  expect(filmSummary([], [])).toEqual({ scenes: 0, withTake: 0, missingStarIds: [], totalS: 0, unknown: 0, inferred: 0, plannedS: 0 })
})

it('filmRuntime: the player says the same "tổng" as the top-bar tooltip (scenes without a take do not count)', () => {
  // Two scenes with 5 s takes, one without a take set to 10 s: the film is 0:10 long, not 0:20.
  const scenes = [scene(0), scene(1), scene(2, { settings: { ...scene(2).settings, duration: 10 } })]
  const takes = [take('t1', 's1', 1, { duration: 5 }), take('t2', 's2', 1, { duration: 5, starred: true }), take('t3', 's3', 1, { status: 'failed', duration: 7 })]
  const items = buildFilmItems(scenes, takes)
  expect(items.map((i) => i.duration)).toEqual([5, 5, 10])
  expect(filmRuntime(items)).toBe(10)
  expect(filmRuntime(items)).toBe(filmSummary(scenes, takes).totalS)
  // A ★ take shorter than a newer one: both count what plays.
  const more = [...takes, take('t4', 's2', 2, { duration: 12 })]
  expect(filmRuntime(buildFilmItems(scenes, more))).toBe(filmSummary(scenes, more).totalS)
  expect(filmRuntime(buildFilmItems(scenes, []))).toBe(0)
  expect(filmRuntime([])).toBe(0)
})

it('an imported take whose length canvasapp did not say is never counted as a fact (its placeholder stays out of "tổng")', () => {
  // s1: 6 s take · s2: imported, duration unknown (placeholder 15) · s3: imported, duration guessed (≈8) · s4: no take
  const scenes = [scene(0), scene(1, { settings: { ...scene(1).settings, duration: 12 } }), scene(2), scene(3)]
  const takes = [
    take('t1', 's1', 1, { duration: 6 }),
    take('t2', 's2', 1, { duration: 15, unknown: ['duration', 'resolution'] }),
    take('t3', 's3', 1, { duration: 8, inferred: ['duration'] }),
    take('t4', 's4', 1, { status: 'failed' }),
  ]
  const items = buildFilmItems(scenes, takes)
  // the still of the unknown one lasts the scene's duration / 5, never the placeholder's
  expect(items.map((i) => [i.take?.id ?? null, i.duration, i.durationIs ?? 'known'])).toEqual([
    ['t1', 6, 'known'],
    ['t2', 12, 'unknown'],
    ['t3', 8, 'inferred'],
    [null, 10, 'known'],
  ])
  const runtime = filmRuntimeOf(items)
  expect(runtime).toEqual({ totalS: 14, unknown: 1, inferred: 1 })
  expect(filmRuntime(items)).toBe(14)
  // the top-bar tooltip says the same as the player
  expect(filmSummary(scenes, takes)).toMatchObject(runtime)
  expect(runtimeText(runtime)).toBe('≈0:14 + 1 cảnh chưa rõ thời lượng')
  expect(runtimeText(filmSummary(scenes, takes))).toBe(runtimeText(runtime))
  // only unknown lengths: no figure at all
  const onlyUnknown = filmRuntimeOf(buildFilmItems([scene(1)], [take('t2', 's2', 1, { unknown: ['duration'] })]))
  expect(runtimeText(onlyUnknown)).toBe('chưa rõ (1 cảnh chưa rõ thời lượng)')
  // takes SanoVids made (or an import that knows the length: another field unknown) read exactly as before
  expect(runtimeText(filmRuntimeOf(buildFilmItems([scene(0)], [take('t1', 's1', 1, { duration: 95, unknown: ['ratio'] })])))).toBe('1:35')
  expect(runtimeText({ totalS: 0, unknown: 0, inferred: 0 })).toBe('0:00')
})
