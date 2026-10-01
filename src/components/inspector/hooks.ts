// Store hooks shared by the inspector panels. All selections are stable (zustand v5): derived lists are
// selected as primitive keys through useShallow and parsed back in useMemo.
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { takeCode } from '../../core/compile'
import type { JobStatus } from '../../core/types'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'


const SEP = '\u0001'

export const STATUS_TEXT: Record<JobStatus, string> = {
  queued: 'Đang chờ',
  processing: 'Đang tạo',
  completed: 'Xong',
  failed: 'Lỗi',
  cancelled: 'Đã huỷ',
}

export interface TakeInfo {
  id: string
  /** null when the take was deleted. */
  sceneId: string | null
  number: number
  status: JobStatus | null
  progress: number
  posterId: string | null
  /** "S03·T2" */
  label: string
}

function parseTakeKey(key: string, order: number | undefined): TakeInfo {
  const [id, sceneId, number, status, progress, posterId] = key.split(SEP)
  if (!sceneId) return { id, sceneId: null, number: 0, status: null, progress: 0, posterId: null, label: 'video đã xoá' }
  return {
    id,
    sceneId,
    number: Number(number),
    status: status as JobStatus,
    progress: Number(progress),
    posterId: posterId || null,
    label: takeCode(order, Number(number)),
  }
}

/** Info about takes by id (in the given order); deleted takes come back with `status: null`. */
export function useTakeInfos(takeIds: string[]): TakeInfo[] {
  const keys = useRuns(
    useShallow((s) =>
      takeIds.map((id) => {
        const t = s.takes.find((x) => x.id === id)
        return t ? [t.id, t.sceneId, t.number, t.status, t.progress, t.posterId ?? ''].join(SEP) : id
      }),
    ),
  )
  const sceneIds = useMemo(() => keys.map((k) => k.split(SEP)[1] ?? ''), [keys])
  const orders = useProject(useShallow((s) => sceneIds.map((id) => s.project.scenes.find((x) => x.id === id)?.order ?? 0)))
  return useMemo(() => keys.map((k, i) => parseTakeKey(k, orders[i] || undefined)), [keys, orders])
}

export interface TakeOption extends TakeInfo {
  sceneTitle: string
  sceneOrder: number
  starred: boolean
}

/** Completed takes of every scene except `excludeSceneIds`, sorted by scene order then take number. */
export function useCompletedTakes(excludeSceneIds: string[]): TakeOption[] {
  const keys = useRuns(
    useShallow((s) =>
      s.takes
        .filter((t) => t.status === 'completed' && !excludeSceneIds.includes(t.sceneId))
        .map((t) => [t.id, t.sceneId, t.number, t.status, t.progress, t.posterId ?? '', t.starred ? '1' : ''].join(SEP)),
    ),
  )
  const sceneKeys = useProject(useShallow((s) => s.project.scenes.map((x) => `${x.id}${SEP}${x.order}${SEP}${x.title}`)))
  return useMemo(() => {
    const scenes = new Map(
      sceneKeys.map((k) => {
        const [id, order, title] = k.split(SEP)
        return [id, { order: Number(order), title }]
      }),
    )
    return keys
      .map((k) => {
        const sceneId = k.split(SEP)[1]
        const sc = scenes.get(sceneId)
        const info = parseTakeKey(k, sc?.order)
        return { ...info, sceneTitle: sc?.title ?? '', sceneOrder: sc?.order ?? 0, starred: k.split(SEP)[6] === '1' }
      })
      .filter((t) => t.sceneOrder > 0)
      .sort((a, b) => a.sceneOrder - b.sceneOrder || a.number - b.number)
  }, [keys, sceneKeys])
}
