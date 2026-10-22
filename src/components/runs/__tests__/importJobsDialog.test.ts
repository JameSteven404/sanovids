// The "Nhập job" dialog mounted for real under React's StrictMode (what `npm run dev` runs: mount, unmount, mount again
// keeping refs): the scan's answer must reach the body, never stay on "Đang đọc danh sách job…". The scan and the
// Modal shell are stand-ins (no DOM in vitest); the body's props are read from the Modal's children.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/imageStore', () => ({
  putBlob: vi.fn(async () => 'x'),
  getBlob: vi.fn(async () => null),
  getUrl: vi.fn(async () => null),
  cachedUrl: () => null,
  deleteMedia: vi.fn(async () => undefined),
  dataUrlToBlob: () => new Blob(),
  useMediaUrl: () => null,
}))
const scanForImport = vi.fn()
vi.mock('../../../siteJobActions', () => ({
  importGateway: () => ({ simulated: true }),
  scanForImport: (...a: unknown[]) => scanForImport(...a),
  importSiteJobs: vi.fn(async () => null),
  pendingTakeLabel: () => null,
}))
vi.mock('../../topbar/CreditPill', () => ({ loginToCanvasapp: vi.fn(async () => false) }))
const shown: Phase[] = []
vi.mock('../../common/Modal', () => ({
  Modal: ({ children }: { children: ReactElement<{ phase: Phase }> }) => {
    shown.push(children.props.phase)
    return null
  },
}))

import { act, createElement, StrictMode, type ReactElement } from 'react'
import type { ImportScan } from '../../../siteJobActions'
import { mountWithoutDom, settle } from '../../common/__tests__/nullRoot'
import { ImportJobsDialog, type Phase } from '../ImportJobsDialog'

const scanned: ImportScan = { pid: 'dev', simulated: true, projectId: 'p', scan: { projectId: 'proj1', listHasKeys: false, candidates: [], skipped: [] } }

afterEach(() => {
  shown.length = 0
  scanForImport.mockReset()
})

describe('ImportJobsDialog', () => {
  it('StrictMode (npm run dev): the scan’s answer is shown — not “Đang đọc danh sách job…” forever', async () => {
    scanForImport.mockResolvedValue(scanned)
    const root = mountWithoutDom(createElement(StrictMode, null, createElement(ImportJobsDialog, { provider: 'dev' })))
    await settle()
    expect(scanForImport).toHaveBeenCalledWith('dev')
    expect(shown.at(-1)).toEqual({ kind: 'ready', data: scanned })
    act(() => root.unmount())
  })

  it('StrictMode: a scan error is shown too (with the right button)', async () => {
    scanForImport.mockRejectedValue(new Error('mất mạng'))
    const root = mountWithoutDom(createElement(StrictMode, null, createElement(ImportJobsDialog, { provider: 'dev' })))
    await settle()
    expect(shown.at(-1)).toMatchObject({ kind: 'error', login: false })
    act(() => root.unmount())
  })
})
