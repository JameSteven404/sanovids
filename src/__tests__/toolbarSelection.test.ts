import { afterEach, expect, it } from 'vitest'
import { selectScenesWithoutVideo } from '../actions'
import { migrateTake } from '../core/migrate'
import { useProject } from '../store/project'
import { downloadFailedError, UNKNOWN_SUBMIT_ERROR, useRuns } from '../store/runs'
import { useUI } from '../store/ui'

const project = useProject.getState().project
const takes = useRuns.getState().takes
const ui = useUI.getState()
afterEach(() => {
  useProject.setState({ project })
  useRuns.setState({ takes })
  useUI.setState(ui)
})

it('selects only scenes with no completed, active, foreign or possibly billed take; never queues work', () => {
  const ids = ['empty', 'failed', 'cancelled', 'done', 'active', 'unknown', 'old-unknown', 'paid', 'sent-cancel', 'foreign', 'parked', 'failed-then-cancelled']
  useProject.setState({ project: { ...project, scenes: ids.map((id, index) => ({ ...project.scenes[0], id, order: index + 1 })) } })
  const take = (sceneId: string, over = {}) => migrateTake({ id: `t-${sceneId}`, sceneId, number: 1, status: 'failed', provider: 'canvasapp', ...over })
  const current = [
    take('failed'), take('cancelled', { status: 'cancelled' }), take('done', { status: 'completed' }),
    take('active', { status: 'processing' }), take('unknown', { submitUnknown: true }),
    take('old-unknown', { error: UNKNOWN_SUBMIT_ERROR }),
    take('paid', { remoteId: 'remote', error: downloadFailedError('test') }),
    take('sent-cancel', { remoteId: 'remote', status: 'cancelled' }),
    { ...take('foreign'), foreignModel: 'new-model' }, { ...take('parked'), foreignProvider: 'new-provider', foreignStatus: 'processing' as const },
    take('failed-then-cancelled'), take('failed-then-cancelled', { id: 'latest', number: 2, status: 'cancelled' }),
  ]
  useRuns.setState({ takes: current })
  useUI.setState({ dialog: { kind: 'none' } })
  const all = selectScenesWithoutVideo()
  expect(all.ids).toEqual(['empty', 'failed', 'cancelled', 'failed-then-cancelled'])
  expect(all.review).toEqual(['unknown', 'old-unknown', 'paid', 'sent-cancel'])
  expect(useUI.getState().selectedIds).toEqual(all.ids)
  expect(useUI.getState().dialog.kind).toBe('none')
  expect(useRuns.getState().takes).toBe(current)
  expect(selectScenesWithoutVideo(true).ids).toEqual(['failed'])
  expect(useUI.getState().toasts.at(-1)?.text).toContain('Bỏ qua 4 cảnh')
})
