// Inside the SANO app ('sano-gateway'): what SanoVids shows names the SANO server, never canvasapp — the Run dialog,
// the empty inspector's footer, the cost tooltip and the engine's "không rõ đã gửi" error. Rendered server-side (no
// DOM, no effects), against the real stores.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/imageStore', () => ({
  putBlob: vi.fn(async () => 'x'),
  getBlob: vi.fn(async () => null),
  getUrl: vi.fn(async () => null),
  cachedUrl: () => null,
  deleteMedia: vi.fn(async () => undefined),
  dataUrlToBlob: () => new Blob(),
  useMediaUrl: () => null,
}))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Scene, Take } from '../../../core/types'
import { activeProviderId, sanoGatewayProvider } from '../../../providers'
import { applyDevAccessState, bareState } from '../../../providers/devAccess'
import { jwt, stubInsideSano } from '../../../providers/__tests__/insideSano'
import { accountKey } from '../../../providers/canvasapp/adapter'
import { LAYOUT, useProject } from '../../../store/project'
import { rerunTake, runNow } from '../../../actions'
import {
  downloadFailedError,
  hasUncertainSubmitText,
  maybeBilledRunWarning,
  paidCancelledRunWarning,
  parkedCountText,
  parkedReasons,
  SANO_UNKNOWN_SUBMIT_ERROR,
  UNKNOWN_SUBMIT_ERROR,
  unknownSubmitError,
  useRuns,
} from '../../../store/runs'
import { useUI } from '../../../store/ui'
import { SANO_LOGIN_TEXT, SANO_LOGIN_WAIT, SANO_OTHER_ACCOUNT_WAIT, SANO_UNAVAILABLE } from '../../../providers/sano/gateway'
import { GatewaySection } from '../../dialogs/GatewaySection'
import { Inspector } from '../../inspector/Inspector'
import { costTitle } from '../../sidebar/shared'
import { RunConfirmDialog } from '../RunConfirmDialog'
import { cancelQuestion, cancelToastText } from '../creditText'
import { checkTakeDelete } from '../../../core/deletePlan'

const scene: Scene = {
  id: 's1',
  order: 1,
  title: 'Mở đầu',
  prompt: 'a cat walks',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: LAYOUT.scenesX, y: 60 },
  note: '',
}
const blank = useProject.getState().project
const model = (maxRefs: number) => ({ id: 'seedance_2_5', label: 'Seedance 2.5', ratios: ['16:9'], resolutions: ['1080p'], durations: [15], maxRefs })

/** SANO's /capabilities answers `body` (read now, as the Run dialog's own read would). */
async function sanoAnswers(body: unknown) {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 200 }))
  await sanoGatewayProvider().refreshLimits({ force: true })
}

beforeEach(() => {
  stubInsideSano({ __SANO_GATEWAY__: { token: () => 'tok' } }) // signed in to SANO
  applyDevAccessState(bareState('locked')) // what initialDevAccess gives inside SANO
  useProject.setState({ project: { ...blank, id: 'sano', scenes: [scene], assets: [], folders: [] } })
})
afterEach(() => {
  sanoGatewayProvider().reset()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  applyDevAccessState(bareState('build'))
  useProject.setState({ project: blank })
})

describe('SANO wording', () => {
  it('new takes go to the SANO server', () => {
    expect(activeProviderId()).toBe('sano-gateway')
  })

  it.each([
    ['live', 'video thật, chi phí do SANO quản lý'],
    ['simulator', 'Giả lập — clip mẫu, không phát sinh phí'],
    [undefined, 'Máy chủ SANO chưa báo chế độ chạy'],
  ] as const)('Run dialog, SANO mode %s: says it; real costs only when live; no canvasapp, no balance', async (mode, said) => {
    await sanoAnswers({ ...(mode ? { mode } : {}), models: [model(4)] })
    const html = renderToStaticMarkup(createElement(RunConfirmDialog, { sceneIds: ['s1'] }))
    expect(html).toContain('Tạo video qua máy chủ SANO')
    expect(html).toContain(said)
    expect(html).toContain('chỉ dừng được job còn đang chờ trên SANO')
    if (mode !== 'live') expect(html).not.toMatch(/video thật|chi phí thật|chi phí do SANO/)
    // the simulator's sample clip: no amount offered as the run's cost (the Run button, the summary)
    if (mode === 'simulator') expect(html).toMatch(/Chạy \d+ cảnh · không phát sinh phí/)
    expect(html).not.toMatch(/canvasapp/i)
    expect(html).not.toContain('Số dư')
  })

  it("run check: a scene over SANO's advertised maxRefs is refused before it is queued", async () => {
    await sanoAnswers({ mode: 'live', models: [model(1)] })
    const asset = (id: string) => ({ id, kind: 'character' as const, name: id, tag: id, description: '', imageIds: [`img_${id}`], color: '#fff', position: null })
    const two: Scene = { ...scene, id: 's2', order: 2, refs: ['a', 'b'], prompt: '@image_1 meets @image_2' }
    useProject.setState({ project: { ...useProject.getState().project, scenes: [scene, two], assets: [asset('a'), asset('b')] } })
    const [one, over] = useRuns.getState().check(['s1', 's2'])
    expect(one.ok).toBe(true)
    expect(over).toMatchObject({ ok: false, reason: 'Seedance 2.5 trên SANO nhận tối đa 1 ảnh tham chiếu (đang có 2)' })
  })

  it.each([
    ['live', 'video thật, chi phí do SANO quản lý'],
    ['simulator', 'giả lập — clip mẫu, không phát sinh phí'],
    [undefined, 'SANO chưa báo chạy thật hay giả lập'],
  ] as const)('empty inspector footer, SANO mode %s: says what SANO runs, as the Run dialog does', async (mode, said) => {
    await sanoAnswers({ ...(mode ? { mode } : {}), models: [model(4)] })
    const html = renderToStaticMarkup(createElement(Inspector))
    expect(html).toContain(`Tạo video qua máy chủ SANO: ${said}.`)
    expect(html).not.toMatch(/canvasapp/i)
  })

  it('cost tooltip', () => {
    expect(costTitle(20, 'canvasapp', 'Mỗi lần chạy · ')).toBe('Mỗi lần chạy · ≈ 20 credit\nƯớc tính — chi phí thật do máy chủ SANO tính')
  })

  it('engine: a lost SANO submit says to retry the same take, and is still recognised as uncertain', () => {
    expect(unknownSubmitError('sano-gateway')).toBe(SANO_UNKNOWN_SUBMIT_ERROR)
    expect(SANO_UNKNOWN_SUBMIT_ERROR).not.toMatch(/canvasapp/i)
    expect(hasUncertainSubmitText(SANO_UNKNOWN_SUBMIT_ERROR)).toBe(true)
    expect(unknownSubmitError('canvasapp')).toBe(UNKNOWN_SUBMIT_ERROR)
  })

  it('run toast, download failure and run warnings name SANO, never canvasapp', () => {
    const enqueue = useRuns.getState().enqueue
    useRuns.setState({ enqueue: () => ({ queued: 1, cost: 20, skipped: [] }) })
    try {
      runNow(['s1'])
    } finally {
      useRuns.setState({ enqueue })
    }
    expect(useUI.getState().toasts.at(-1)?.text).toBe('Đã gửi 1 cảnh vào hàng đợi · ≈ 20 credit · chi phí do SANO quản lý')
    for (const text of [
      downloadFailedError('HTTP 500', 'sano-gateway'),
      maybeBilledRunWarning('S01', 'sano-gateway', true),
      maybeBilledRunWarning('S01', 'sano-gateway', false),
      paidCancelledRunWarning('S01', 'sano-gateway'),
    ]) {
      expect(text).toMatch(/SANO|Chạy lại/)
      expect(text).not.toMatch(/canvasapp/i)
    }
  })

  it('run toast under the simulator: no fee, as the Run dialog promised', async () => {
    await sanoAnswers({ mode: 'simulator', models: [model(4)] })
    const enqueue = useRuns.getState().enqueue
    useRuns.setState({ enqueue: () => ({ queued: 1, cost: 20, skipped: [] }) })
    try {
      runNow(['s1'])
    } finally {
      useRuns.setState({ enqueue })
    }
    expect(useUI.getState().toasts.at(-1)?.text).toBe('Đã gửi 1 cảnh vào hàng đợi · giả lập — clip mẫu, không phát sinh phí')
  })

  it('"Chạy lại" of a SANO take whose answer was lost: the same take goes again at once (same key, one job) — no canvasapp question', () => {
    const lost = { id: 'tk1', sceneId: 's1', number: 1, provider: 'sano-gateway', status: 'failed', remoteId: null, error: SANO_UNKNOWN_SUBMIT_ERROR, submitUnknown: true } as Take
    const { retry, takes } = useRuns.getState()
    const resent = vi.fn(() => ({ queued: 1, cost: 20, skipped: [] }))
    useRuns.setState({ takes: [lost], retry: resent })
    try {
      rerunTake('tk1') // window.confirm does not exist here: asking would throw
    } finally {
      useRuns.setState({ retry, takes })
    }
    expect(resent).toHaveBeenCalledWith('tk1')
    expect(useUI.getState().toasts.at(-1)?.text).toBe('Đang gửi lại S01·T1 lên máy chủ SANO (cùng mã yêu cầu — SANO không tạo job thứ hai).')
  })

  it('"Huỷ" / delete of a SANO take whose video is made (still downloading), maybe billed or sent: SANO words, never canvasapp', () => {
    const facts = { label: 'S01·T1', provider: 'sano-gateway' as const, status: 'processing' as const, cost: 20, demoPaid: false, sentAway: true, videoReady: true }
    const asked = checkTakeDelete(['a', 'b', 'c'], [
      { id: 'a', status: 'processing', videoReady: true, sent: true, provider: 'sano-gateway' },
      { id: 'b', status: 'failed', uncertain: true, provider: 'sano-gateway' },
      { id: 'c', status: 'processing', sent: true, provider: 'sano-gateway' },
    ]).question
    for (const text of [cancelQuestion(facts), cancelToastText(facts).text, asked]) {
      expect(text).toMatch(/app SANO|máy chủ SANO/)
      expect(text).not.toMatch(/canvasapp/i)
    }
  })

  it('Settings says why SANO cannot take new takes: a plain tab of the SANO build (its choice off), signed out inside SANO', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://sano.example' } }) // SANO's /sanovids/ in a plain tab
    const seg = /<button[^>]*data-seg="sano-gateway"[^>]*>/
    for (const access of ['locked', 'build'] as const) {
      applyDevAccessState(bareState(access))
      const html = renderToStaticMarkup(createElement(GatewaySection))
      expect(html).toContain(SANO_UNAVAILABLE)
      // development mode open: SANO is listed, but disabled here (like canvasapp outside the desktop app)
      if (access === 'build') expect(html.match(seg)?.[0]).toMatch(/disabled=""/)
    }
    stubInsideSano() // inside SANO, not signed in
    applyDevAccessState(bareState('locked'))
    expect(await sanoGatewayProvider().refreshLimits({ force: true })).toBe('login') // the token read
    expect(renderToStaticMarkup(createElement(GatewaySection))).toContain(SANO_LOGIN_TEXT)
  })

  it("queue: what the bar's chip and the list's banner say of SANO takes that wait — for a sign-in, another account, SANO itself (a wait that ends by itself)", async () => {
    stubInsideSano() // inside SANO, signed out (SANO's 1 h token was not renewed)
    expect(await sanoGatewayProvider().refreshLimits({ force: true })).toBe('login')
    const t = (status: Take['status'], provider: Take['provider'] = 'sano-gateway') => ({ id: status, status, provider, remoteId: null }) as Take
    const takes = [t('processing'), t('queued'), t('completed'), t('failed'), t('cancelled'), t('processing', 'dev')]
    expect(parkedReasons(takes)).toEqual([SANO_LOGIN_WAIT, SANO_LOGIN_WAIT])
    expect(parkedCountText(parkedReasons(takes))).toBe('2 take chờ đăng nhập SANO') // the chip names the cause
    expect(SANO_LOGIN_WAIT).not.toBe(SANO_LOGIN_TEXT) // the Run refusal keeps its own words

    stubInsideSano({ __SANO_GATEWAY__: { token: () => jwt({ sub: 'B' }) } }) // signed in as B: A's take waits
    await sanoAnswers({ models: [] })
    const mixed = [{ ...t('queued'), account: accountKey('A') }, t('queued')]
    expect(parkedReasons(mixed)).toEqual([SANO_OTHER_ACCOUNT_WAIT])
    expect(parkedCountText(parkedReasons(mixed))).toBe('1 take chờ tài khoản SANO khác')

    vi.stubGlobal('window', { location: { origin: 'https://sano.example' } }) // SANO's /sanovids/ in a plain tab
    expect(parkedReasons(takes)).toEqual([SANO_UNAVAILABLE, SANO_UNAVAILABLE])
    expect(parkedCountText(parkedReasons(takes))).toBe('2 take chờ mở trong SANO')
  })
})
