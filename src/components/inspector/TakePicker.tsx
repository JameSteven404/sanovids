// Picker of completed takes (videos), used to add @video references.
import { Film, Star } from 'lucide-react'
import { useMemo, type RefObject } from 'react'
import { MediaImg } from '../common/Media'
import { useCompletedTakes } from './hooks'
import { fold, PickerPopover, type PickItem } from './shared'

/** Picker of completed takes (videos) of other scenes. */
export function TakePicker({
  excludeSceneIds,
  exclude,
  title,
  ignoreRef,
  onPick,
  onClose,
}: {
  excludeSceneIds: string[]
  exclude: string[]
  title: string
  ignoreRef: RefObject<HTMLElement | null>
  onPick: (takeId: string) => void
  onClose: () => void
}) {
  const takes = useCompletedTakes(excludeSceneIds)
  const items = useMemo<PickItem[]>(
    () =>
      takes
        .filter((t) => !exclude.includes(t.id))
        .map((t) => ({
          id: t.id,
          label: t.label,
          sub: t.sceneTitle || 'Chưa đặt tên',
          search: fold(`${t.label} ${t.label.replace(/[^\p{L}\p{N}]/gu, '')} ${t.sceneTitle}`),
          leading: <span className="in-vref-thumb is-sm">{t.posterId ? <MediaImg id={t.posterId} className="media-img" /> : <Film size={12} />}</span>,
          trailing: t.starred ? <Star size={12} className="in-star" fill="currentColor" /> : undefined,
        })),
    [takes, exclude],
  )
  return (
    <PickerPopover
      items={items}
      onPick={onPick}
      onClose={onClose}
      title={title}
      ignoreRef={ignoreRef}
      placeholder="Tìm video (S03, T2, tên cảnh…)"
      emptyText="Chưa có video nào tạo xong ở các cảnh khác."
    />
  )
}
