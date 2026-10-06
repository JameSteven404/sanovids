// Settings search: level filter without a query; accent-free, multi-word matching across both levels with a query.
import { describe, expect, it } from 'vitest'
import { ABOUT_DESC, ABOUT_KEYWORDS, ABOUT_TITLE } from '../../../lib/aboutModel'
import { BIG_PROJECT_ROW, NODE_EDITOR_ROW } from '../../../lib/canvasPrefs'
import { foldText, matchSettings, resultCount, searchWords, type SearchGroup } from '../settingsSearch'

const groups: SearchGroup[] = [
  {
    id: 'downloads',
    level: 'basic',
    title: 'Tải video',
    rows: [
      { id: 'askWhere', label: 'Hỏi nơi lưu & đổi tên mỗi lần tải', keywords: 'save as hộp thoại' },
      { id: 'withPrompt', label: 'Kèm file .txt chứa prompt', hint: 'Lưu thêm file .txt cạnh video' },
    ],
  },
  { id: 'playback', level: 'basic', title: 'Âm thanh video', rows: [{ id: 'sound', label: 'Bật tiếng khi xem video', keywords: 'loa mute' }] },
  {
    id: 'files',
    level: 'advanced',
    title: 'Tên file & file .zip',
    rows: [
      { id: 'nameTemplate', label: 'Cách đặt tên file', keywords: 'template' },
      { id: 'zipPrompts', label: 'Kèm prompts.txt trong file .zip' },
    ],
  },
  { id: 'gateway', level: 'advanced', title: 'Cổng canvasapp.io.vn', desc: 'Đăng nhập canvasapp', keywords: 'credit thật' },
]

const ids = (m: ReturnType<typeof matchSettings>) => m.map((x) => `${x.group.id}:${x.rows.map((r) => r.id).join(',')}`)

describe('matchSettings', () => {
  it('no query: every group of the chosen level, all rows', () => {
    expect(ids(matchSettings(groups, 'basic', ''))).toEqual(['downloads:askWhere,withPrompt', 'playback:sound'])
    expect(ids(matchSettings(groups, 'advanced', '   '))).toEqual(['files:nameTemplate,zipPrompts', 'gateway:'])
  })

  it('a query looks in both levels, ignoring case and accents', () => {
    expect(ids(matchSettings(groups, 'basic', 'TXT'))).toEqual(['downloads:withPrompt', 'files:zipPrompts'])
    expect(ids(matchSettings(groups, 'advanced', 'am thanh'))).toEqual(['playback:sound'])
    expect(ids(matchSettings(groups, 'basic', 'đổi tên'))).toEqual(['downloads:askWhere'])
    expect(ids(matchSettings(groups, 'basic', 'doi ten'))).toEqual(['downloads:askWhere'])
  })

  it('every word must match; the group title counts for all its rows', () => {
    expect(ids(matchSettings(groups, 'basic', 'tải hộp thoại'))).toEqual(['downloads:askWhere'])
    expect(ids(matchSettings(groups, 'basic', 'tai video'))).toEqual(['downloads:askWhere,withPrompt'])
    expect(ids(matchSettings(groups, 'basic', 'zip template'))).toEqual(['files:nameTemplate'])
    expect(matchSettings(groups, 'basic', 'không có gì')).toEqual([])
  })

  it('a block group is found by its title, description or keywords', () => {
    expect(ids(matchSettings(groups, 'basic', 'credit'))).toEqual(['gateway:'])
    expect(ids(matchSettings(groups, 'basic', 'dang nhap'))).toEqual(['gateway:'])
  })

  it('resultCount counts rows, a block as one', () => {
    expect(resultCount(matchSettings(groups, 'basic', 'txt'))).toBe(2)
    expect(resultCount(matchSettings(groups, 'basic', 'credit'))).toBe(1)
  })
})

describe('Giới thiệu (about block)', () => {
  // The same entry as SettingsDialog GROUPS (a block group: no rows; searched by title, description and keywords).
  const about: SearchGroup = { id: 'about', level: 'basic', title: ABOUT_TITLE, desc: ABOUT_DESC, keywords: ABOUT_KEYWORDS }
  const all = [...groups, about]

  it('is listed last in Cơ bản and found from both levels by author, partner and signature words', () => {
    expect(ids(matchSettings(all, 'basic', '')).at(-1)).toBe('about:')
    for (const q of ['giới thiệu', 'gioi thieu', 'tac gia', 'chu ky so', 'chữ ký', 'jame', 'JAME STEVEN', 'nguyen giang minh', 'sano group', 'đồng hành', 'vân tay', 'phiên bản']) {
      expect(ids(matchSettings(all, 'advanced', q))).toEqual(['about:'])
    }
    expect(resultCount(matchSettings(all, 'basic', 'jame'))).toBe(1)
  })
})

describe('Dây nối & canvas: the scene-card editor and big projects', () => {
  // The same rows as SettingsDialog GROUPS 'canvas' (texts from lib/canvasPrefs).
  const canvas: SearchGroup = {
    id: 'canvas',
    level: 'basic',
    title: 'Dây nối & canvas',
    desc: 'Cách dây nối, thẻ cảnh và video hiện trên canvas.',
    rows: [
      { id: 'nodeEditor', ...NODE_EDITOR_ROW },
      { id: 'clickToCut', label: 'Bấm vào dây để cắt', keywords: 'hủy nối huỷ nối bỏ nối cắt dây x kẹt wire' },
      { id: 'minimap', label: 'Bản đồ thu nhỏ', keywords: 'minimap bản đồ góc' },
      { id: 'bigProject', ...BIG_PROJECT_ROW },
    ],
  }
  const all = [...groups, canvas]

  it('finds the editor on the scene card, from both levels', () => {
    for (const q of ['sua prompt tren the', 'sửa prompt trên thẻ', 'inline', 'nhập trực tiếp', 'thu gon', 'trinh sua']) {
      expect(ids(matchSettings(all, 'advanced', q)), q).toEqual(['canvas:nodeEditor'])
    }
  })

  it('finds the big-project optimisations by what users type when it is slow', () => {
    for (const q of ['du an lon', 'hiệu năng', 'hieu nang', 'lag', 'giật', 'performance', 'chậm']) {
      expect(ids(matchSettings(all, 'basic', q)), q).toEqual(['canvas:bigProject'])
    }
    // "bản đồ" is in both the minimap row and the big-project hint
    expect(ids(matchSettings(all, 'basic', 'ban do thu nho'))).toEqual(['canvas:minimap,bigProject'])
  })
})

describe('foldText / searchWords', () => {
  it('folds Vietnamese', () => {
    expect(foldText('Đổi Tên Âm Thanh')).toBe('doi ten am thanh')
    expect(searchWords('  Hỏi   nơi lưu ')).toEqual(['hoi', 'noi', 'luu'])
    expect(searchWords('')).toEqual([])
  })
})
