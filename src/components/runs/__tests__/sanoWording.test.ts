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
import type { Scene } from '../../../core/types'
import { activeProviderId, sanoGatewayProvider } from '../../../providers'
import { applyDevAccessState, bareState } from '../../../providers/devAccess'
import { LAYOUT, useProject } from '../../../store/project'
import { runNow } from '../../../actions'
import {
  downloadFailedError,
  hasUncertainSubmitText,
  maybeBilledRunWarning,
  paidCancelledRunWarning,
  SANO_UNKNOWN_SUBMIT_ERROR,
  UNKNOWN_SUBMIT_ERROR,
  unknownSubmitError,
  useRuns,
} from '../../../store/runs'
import { useUI } from '../../../store/ui'
import { Inspector } from '../../inspector/Inspector'
import { costTitle } from '../../sidebar/shared'
import { RunConfirmDialog } from '../RunConfirmDialog'

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
  vi.stubGlobal('window', { __SANO_GATEWAY__: {} })
  applyDevAccessState(bareState('locked')) // what initialDevAccess gives inside SANO
  useProject.setState({ project: { ...blank, id: 'sano', scenes: [scene], assets: [], folders: [] } })
})
afterEach(() => {
  sanoGatewayProvider().reset()
  vi.unstubAllGlobals()
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

  it('empty inspector footer', () => {
    const html = renderToStaticMarkup(createElement(Inspector))
    expect(html).toContain('Tạo video qua máy chủ SANO: video thật, chi phí do SANO quản lý.')
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
})
