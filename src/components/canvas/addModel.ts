// UI-04 (docs/UI-MUOT.md): what the toolbar's "+ Thêm" popover (AddPopover) offers, and its search / filter — pure.
// Only things this build can really put on the canvas; the popover maps each id to an existing command.
import { foldText, searchWords } from '../dialogs/settingsSearch'

export type AddKind = 'scene' | 'image' | 'folder'
export type AddFilter = 'all' | AddKind
export type AddItemId = 'add-next' | 'add-empty' | 'add-images' | 'add-import' | 'add-folder'

export interface AddItem {
  id: AddItemId
  group: 'common' | 'more'
  kind: AddKind
  label: string
  hint: string
  /** Extra words people may type (accent-free search). */
  keywords: string
}

export const ADD_GROUP_LABEL: Record<AddItem['group'], string> = { common: 'Thường dùng', more: 'Nhập & lưu' }
export const ADD_FILTERS: readonly { id: AddFilter; label: string }[] = [
  { id: 'all', label: 'Tất cả' },
  { id: 'scene', label: 'Cảnh' },
  { id: 'image', label: 'Ảnh' },
  { id: 'folder', label: 'Thư mục' },
]

export const ADD_ITEMS: readonly AddItem[] = [
  { id: 'add-next', group: 'common', kind: 'scene', label: 'Cảnh tiếp theo', hint: 'Giữ ảnh tham chiếu và cấu hình của cảnh đang chọn', keywords: 'canh moi next tiep' },
  { id: 'add-empty', group: 'common', kind: 'scene', label: 'Cảnh trống', hint: 'Viết nội dung, nối ảnh, tạo video', keywords: 'canh moi trong blank' },
  { id: 'add-images', group: 'common', kind: 'image', label: 'Ảnh từ máy…', hint: 'Nhân vật, bối cảnh, đạo cụ — đặt giữa khung đang xem', keywords: 'anh hinh image picture nhan vat boi canh dao cu tai len upload' },
  { id: 'add-import', group: 'more', kind: 'scene', label: 'Nhập nhiều prompt…', hint: 'Dán hoặc mở file .txt — mỗi đoạn thành một cảnh', keywords: 'nhap prompt txt dan import nhieu canh' },
  { id: 'add-folder', group: 'more', kind: 'folder', label: 'Thư mục lưu video…', hint: 'Nối video vào để lưu, hoặc tự lưu mọi video của một cảnh', keywords: 'thu muc folder luu save video' },
]

/** Items matching the filter chip and every word of the query (accent-free: "anh" finds "Ảnh"), in list order. */
export function filterAddItems(query: string, filter: AddFilter, items: readonly AddItem[] = ADD_ITEMS): AddItem[] {
  const words = searchWords(query)
  return items.filter((item) => {
    if (filter !== 'all' && item.kind !== filter) return false
    const text = foldText(`${item.label} ${item.hint} ${item.keywords}`)
    return words.every((w) => text.includes(w))
  })
}
