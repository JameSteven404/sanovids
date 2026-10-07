// Settings search: level filter without a query; accent-free, multi-word matching across both levels with a query.
import { describe, expect, it } from 'vitest'
import { FOLDER_UNLINK_TRASH_ROW } from '../../../core/folderTrash'
import { ABOUT_DESC, ABOUT_KEYWORDS, ABOUT_TITLE, PLACEMENT_KEYWORDS } from '../../../lib/aboutModel'
import { BIG_PROJECT_ROW, NODE_EDITOR_ROW } from '../../../lib/canvasPrefs'
import { KEEP_LOGIN_KEYWORDS } from '../keepLoginModel'
import settingsDialogSource from '../SettingsDialog.tsx?raw'
import { deepLinkStep, foldText, matchSettings, resultCount, searchWords, visibleGroups, type SearchGroup } from '../settingsSearch'

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

  it('"Giữ đăng nhập canvasapp trên máy này" is found through the gateway group’s keywords', () => {
    const withKeep: SearchGroup[] = groups.map((g) => (g.id === 'gateway' ? { ...g, keywords: `${g.keywords} ${KEEP_LOGIN_KEYWORDS}` } : g))
    for (const q of ['giữ đăng nhập', 'giu dang nhap', 'nhớ đăng nhập', 'ghi nho', 'đăng nhập lại']) expect(ids(matchSettings(withKeep, 'basic', q)), q).toEqual(['gateway:'])
    // the real group carries them (SettingsDialog GROUPS)
    expect(settingsDialogSource).toContain('${KEEP_LOGIN_KEYWORDS}')
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

describe('Tải video: the Recycle Bin on unlinking a folder wire', () => {
  // The same row as SettingsDialog GROUPS 'downloads' (texts from core/folderTrash).
  const downloads: SearchGroup = {
    id: 'downloads',
    level: 'basic',
    title: 'Tải video',
    rows: [
      { id: 'withPrompt', label: 'Kèm file .txt chứa prompt', hint: 'Lưu thêm file .txt cạnh video' },
      { id: 'folderUnlinkTrash', ...FOLDER_UNLINK_TRASH_ROW },
    ],
  }
  const all = [downloads, groups[1], groups[2], groups[3]]

  it('is found by what users type, from both levels, accents or not', () => {
    for (const q of ['thung rac', 'Thùng rác', 'recycle bin', 'xoa file', 'xóa file', 'bo noi', 'cat day', 'go dong bo']) {
      expect(ids(matchSettings(all, 'advanced', q)), q).toEqual(['downloads:folderUnlinkTrash'])
    }
  })
})

describe('Ứng dụng: the Portable / temp-copy reminder', () => {
  // The same block entry as SettingsDialog GROUPS 'app'.
  const app: SearchGroup = {
    id: 'app',
    level: 'basic',
    title: 'Ứng dụng',
    desc: 'Bản app desktop cho Windows và macOS, hoặc cài thành app trên trình duyệt.',
    keywords: `cài app desktop exe windows pwa mac macos dmg applications finder thử nghiệm ${PLACEMENT_KEYWORDS}`,
  }
  it('is found by icon / shortcut / Start menu / portable words', () => {
    for (const q of ['icon', 'lối tắt', 'loi tat', 'shortcut', 'start menu', 'ghim', 'portable', 'setup', 'mac', 'macos', 'dmg', 'applications', 'finder', 'thu nghiem']) {
      expect(ids(matchSettings([...groups, app], 'advanced', q)), q).toEqual(['app:'])
    }
  })
})

describe('foldText / searchWords', () => {
  it('folds Vietnamese', () => {
    expect(foldText('Đổi Tên Âm Thanh')).toBe('doi ten am thanh')
    expect(searchWords('  Hỏi   nơi lưu ')).toEqual(['hoi', 'noi', 'luu'])
    expect(searchWords('')).toEqual([])
  })
})

describe('development mode locked: visibleGroups', () => {
  const all: SearchGroup[] = [
    { id: 'appearance', level: 'basic', title: 'Giao diện', rows: [{ id: 'theme', label: 'Chế độ giao diện' }] },
    { id: 'gateway', level: 'advanced', title: 'Cổng canvasapp.io.vn', desc: 'Nhà cung cấp video cho take mới', keywords: 'canvasapp cổng nhà cung cấp' },
    { id: 'dev', level: 'basic', title: 'Chế độ Phát triển', desc: 'canvasapp giả lập', keywords: 'dev phát triển giả lập debug credit dev' },
    { id: 'about', level: 'basic', title: 'Giới thiệu' },
  ]
  it('open: everything as declared', () => {
    expect(visibleGroups(all, true)).toEqual(all)
  })
  it('locked: no "dev" group at either level or in search; "gateway" in Cơ bản at its place; deep link "dev" unknown', () => {
    const v = visibleGroups(all, false)
    expect(v.map((g) => `${g.id}:${g.level}`)).toEqual(['appearance:basic', 'gateway:basic', 'about:basic'])
    for (const q of ['phát triển', 'phat trien', 'dev', 'giả lập', 'debug']) {
      for (const level of ['basic', 'advanced'] as const) expect(matchSettings(v, level, q).map((m) => m.group.id)).not.toContain('dev')
    }
    expect(matchSettings(v, 'basic', '').map((m) => m.group.id)).toContain('gateway')
    expect(matchSettings(v, 'advanced', '').map((m) => m.group.id)).not.toContain('gateway')
    expect(v.find((g) => g.id === 'dev')).toBeUndefined()
    // the declared list is untouched
    expect(all.find((g) => g.id === 'gateway')?.level).toBe('advanced')
  })
  it('SettingsDialog filters its GROUPS through visibleGroups with the lock (search and deep link)', () => {
    expect(settingsDialogSource).toContain('const groups = useMemo(() => visibleGroups(GROUPS, devOpen), [devOpen])')
    expect(settingsDialogSource).toContain('const target = section ? groups.find((g) => g.id === section) : undefined')
    expect(settingsDialogSource).toContain('matchSettings(groups, level, query)')
    expect(settingsDialogSource).not.toContain('matchSettings(GROUPS')
  })
  // Regression: opened through a deep link to 'gateway' while locked (the one-time notice, the "Chưa bật" pill, the
  // Run toast), the owner unlocks from Giới thiệu; the lock flip hands 'gateway' back as the "Nâng cao" object. The
  // dialog must NOT follow it there: the Cơ bản column (Giới thiệu with the unlock box and its one-time authenticator
  // link offer) would unmount and the link window be cancelled, burning the one-time code.
  it('a lock flip never re-targets a deep link (only a new request does)', () => {
    const locked = visibleGroups(all, false)
    const open = visibleGroups(all, true)
    // first render, locked: the gateway in Cơ bản
    const first = deepLinkStep(null, 'gateway', locked)
    expect(first?.id).toBe('gateway')
    expect(first?.level).toBe('basic')
    // unlocked: the same request with other group objects (gateway now in Nâng cao) → stay
    expect(open.find((g) => g.id === 'gateway')?.level).toBe('advanced')
    expect(deepLinkStep('gateway', 'gateway', open)).toBeUndefined()
    // locked again: still the same request → stay
    expect(deepLinkStep('gateway', 'gateway', locked)).toBeUndefined()
    // an id unknown while locked ('dev') that appears after the unlock: already followed → stay
    expect(deepLinkStep(null, 'dev', locked)).toBeUndefined()
    expect(deepLinkStep('dev', 'dev', open)).toBeUndefined()
    // a NEW request while open moves the dialog; no request does nothing
    expect(deepLinkStep('gateway', 'about', open)?.id).toBe('about')
    expect(deepLinkStep(null, undefined, open)).toBeUndefined()
    expect(deepLinkStep('gateway', undefined, open)).toBeUndefined()
  })
  it('SettingsDialog follows deep links through deepLinkStep, keyed on the request — not on the group object', () => {
    expect(settingsDialogSource).toContain('const next = deepLinkStep(followedSection.current, section, groups)')
    expect(settingsDialogSource).toContain('followedSection.current = section')
    expect(settingsDialogSource).toContain('}, [section, groups])')
    expect(settingsDialogSource).not.toContain('}, [target])')
  })
})
