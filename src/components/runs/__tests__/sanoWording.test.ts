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
import { activeProviderId } from '../../../providers'
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

beforeEach(() => {
  vi.stubGlobal('window', { __SANO_GATEWAY__: {} })
  applyDevAccessState(bareState('locked')) // what initialDevAccess gives inside SANO
  useProject.setState({ project: { ...blank, id: 'sano', scenes: [scene], assets: [], folders: [] } })
})
afterEach(() => {
  vi.unstubAllGlobals()
  applyDevAccessState(bareState('build'))
  useProject.setState({ project: blank })
})

describe('SANO wording', () => {
  it('new takes go to the SANO server', () => {
    expect(activeProviderId()).toBe('sano-gateway')
  })

  it('Run dialog: SANO badge, note and footer; no canvasapp, no balance', () => {
    const html = renderToStaticMarkup(createElement(RunConfirmDialog, { sceneIds: ['s1'] }))
    expect(html).toContain('Tạo video qua máy chủ SANO')
    expect(html).toContain('chi phí do SANO quản lý')
    expect(html).toContain('chỉ dừng được job còn đang chờ trên SANO')
    expect(html).not.toMatch(/canvasapp/i)
    expect(html).not.toContain('Số dư')
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
