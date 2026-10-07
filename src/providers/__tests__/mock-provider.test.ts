import { describe, expect, it } from 'vitest'
import { createMockProvider, DEFAULT_MOCK_SETTINGS, FAIL_MESSAGES, type MockSettings } from '../mock'
import type { JobRequest } from '../types'

const req = (over: Partial<JobRequest> = {}): JobRequest => ({
  key: 'take_1',
  takeId: 'take_1',
  sceneId: 's',
  sanovidsProjectId: 'prj_a',
  sceneCode: 'S01',
  takeNumber: 1,
  title: '',
  color: '#fff',
  model: 'seedance_2_5',
  mode: 't2v',
  duration: 5,
  resolution: '480p',
  ratio: '16:9',
  prompt: 'x',
  rawPrompt: 'x',
  images: [],
  videos: [],
  firstFrame: null,
  lastFrame: null,
  startedAt: 1000,
  ...over,
})

function setup(settings: Partial<MockSettings> = {}, random = 0.5) {
  const clock = { t: 1000 }
  const rendered: string[] = []
  const p = createMockProvider(() => ({ ...DEFAULT_MOCK_SETTINGS, ...settings }), {
    now: () => clock.t,
    random: () => random,
    render: async (r) => {
      rendered.push(r.key)
      return { poster: new Blob(['p']), video: null }
    },
  })
  return { p, clock, rendered }
}

describe('mock provider', () => {
  it('progresses on wall-clock time and completes at 99%', async () => {
    // fast = 3–6 s, random 0.5 → 4.5 s total; failRate 0 → never fails
    const { p, clock, rendered } = setup({ speed: 'fast', failRate: 0 })
    const { remoteId } = await p.submit(req())
    expect(remoteId).toBe('take_1')
    clock.t += 2250
    expect(await p.poll([remoteId])).toEqual([{ remoteId, state: 'processing', progress: 50 }])
    clock.t += 2300
    expect(await p.poll([remoteId])).toEqual([{ remoteId, state: 'completed', progress: 99 }])
    const res = await p.fetchResult(remoteId)
    expect(res.poster).toBeInstanceOf(Blob)
    expect(rendered).toEqual(['take_1'])
    expect(p.size()).toBe(0)
  })

  it('fails at a progress threshold depending on the take number', async () => {
    // random 0.05 < failRate 0.5 → fail; take 2 → threshold 40 + 2*10 = 60%
    const { p, clock } = setup({ failRate: 0.5 }, 0.05)
    const { remoteId } = await p.submit(req({ takeNumber: 2 }))
    const total = 3000 + 0.05 * 3000
    clock.t += total * 0.5
    expect((await p.poll([remoteId]))[0].state).toBe('processing')
    clock.t += total * 0.15
    const st = (await p.poll([remoteId]))[0]
    expect(st.state).toBe('failed')
    expect(st.error).toBe(FAIL_MESSAGES[2 % FAIL_MESSAGES.length])
  })

  it('cancel and reset drop jobs; unknown ids are reported as failed', async () => {
    const { p } = setup()
    await p.submit(req())
    await p.submit(req({ key: 'take_2', takeId: 'take_2' }))
    p.cancel!('take_1')
    expect(p.size()).toBe(1)
    p.reset!()
    expect(p.size()).toBe(0)
    expect((await p.poll(['take_2']))[0].state).toBe('failed')
  })
})
