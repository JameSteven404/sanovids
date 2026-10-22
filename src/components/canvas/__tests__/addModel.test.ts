import { describe, expect, it } from 'vitest'
import { ADD_ITEMS, filterAddItems } from '../addModel'

const ids = (list: { id: string }[]) => list.map((i) => i.id)

describe('"+ Thêm" popover search / filter (UI-04)', () => {
  it('no query, "Tất cả": every item in list order', () => {
    expect(ids(filterAddItems('', 'all'))).toEqual(ids([...ADD_ITEMS]))
  })
  it('accent-free words, all of them must match (label, hint or keywords)', () => {
    expect(ids(filterAddItems('anh', 'all'))).toContain('add-images')
    expect(ids(filterAddItems('Ảnh', 'all'))).toContain('add-images')
    expect(ids(filterAddItems('thu muc', 'all'))).toEqual(['add-folder'])
    expect(ids(filterAddItems('txt', 'all'))).toEqual(['add-import'])
    expect(filterAddItems('xyz không có', 'all')).toEqual([])
  })
  it('a filter chip keeps only its kind, combined with the query', () => {
    expect(ids(filterAddItems('', 'scene'))).toEqual(['add-next', 'add-empty', 'add-import'])
    expect(ids(filterAddItems('', 'folder'))).toEqual(['add-folder'])
    expect(ids(filterAddItems('trong', 'scene'))).toEqual(['add-empty'])
    expect(filterAddItems('thu muc', 'image')).toEqual([])
  })
})
