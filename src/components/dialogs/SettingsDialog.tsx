// "Cài đặt": every user-tunable preference, in two levels — "Cơ bản" (everyday) and "Nâng cao" — with a search box
// that looks in both (label, hint and keywords, accents ignored; Ctrl+F focuses it). The rows are declared once in
// GROUPS below: the same label / hint feeds the row and the search (settingsSearch.ts). Each row component
// subscribes to its own pref and applies at once; the stores persist and validate (see lib/settings.ts for the list,
// the reset to defaults and the export / import of a settings file). Rows: SettingsBasic.tsx / SettingsAdvanced.tsx.
// Deep link: `{ kind: 'settings', section: <group id> }` (actions.openSettings(section)) opens on that group's level and
// scrolls the group into view (its <Section> carries data-set-anchor, settingsUi.tsx).
import { Search, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { CLICK_TO_CUT_TRASH_NOTE, FOLDER_UNLINK_TRASH_ROW } from '../../core/folderTrash'
import { ABOUT_DESC, ABOUT_KEYWORDS, ABOUT_TITLE, PLACEMENT_KEYWORDS } from '../../lib/aboutModel'
import { BIG_PROJECT_ROW, NODE_EDITOR_ROW } from '../../lib/canvasPrefs'
import { oneOf, parsePref, useUI } from '../../store/ui'
import { Modal } from '../common/Modal'
import './dialogs.css'
import { GatewaySection } from './GatewaySection'
import { KEEP_LOGIN_KEYWORDS } from './keepLoginModel'
import { Segmented } from './Segmented'
import {
  BackupSetting,
  DevBlock,
  MotionSetting,
  NameTemplateSetting,
  ResetAllSetting,
  ResetLayoutSetting,
  ToastTimeSetting,
  ZipPromptsSetting,
} from './SettingsAdvanced'
import {
  AboutBlock,
  AppBlock,
  AskWhereSetting,
  AutoDownloadSetting,
  AutoRenumberSetting,
  BigProjectSetting,
  ClickToCutSetting,
  DataBlock,
  DownloadFolderSetting,
  EdgeModeSetting,
  FolderUnlinkTrashSetting,
  InteractionSetting,
  MinimapSetting,
  NodeEditorSetting,
  RateSetting,
  SoundSetting,
  TakeDisplaySetting,
  ThemeSetting,
  UpdateAutoDownloadSetting,
  UpdateCheckSetting,
  UpdateStatusIntro,
  VolumeSetting,
  WithPromptSetting,
} from './SettingsBasic'
import { matchSettings, resultCount, searchWords, SETTINGS_LEVEL_LABEL, SETTINGS_LEVELS, type GroupMatch, type SearchGroup, type SearchRow, type SettingsLevel } from './settingsSearch'
import { Section, SectionAnchorCtx, SettingsCtx, type RowProps } from './settingsUi'

interface Row extends SearchRow {
  C: ComponentType<RowProps>
}

interface Group extends SearchGroup<Row> {
  /** Column on wide screens (one column under 760 px). */
  col: 0 | 1
  badge?: ReactNode
  /** Shown on top of the rows (a note that depends on state). */
  Intro?: ComponentType
  /** A section that renders itself (no rows; searched by title, description and keywords). */
  Block?: ComponentType
}

const GROUPS: Group[] = [
  // ------------------------------------------------ Cơ bản ------------------------------------------------
  {
    id: 'appearance',
    level: 'basic',
    col: 0,
    title: 'Giao diện',
    desc: 'Chế độ sáng hoặc tối cho toàn bộ ứng dụng.',
    rows: [{ id: 'theme', label: 'Chế độ giao diện', hint: 'Lựa chọn được nhớ trên máy này.', keywords: 'sáng tối hệ thống dark light theme màu nền', C: ThemeSetting }],
  },
  {
    id: 'downloads',
    level: 'basic',
    col: 0,
    title: 'Tải video',
    desc: 'Nút “Tải video” lưu file video đặt tên theo cảnh (S03_T2 - tên cảnh). Đổi cách đặt tên ở Nâng cao → Tên file.',
    rows: [
      {
        id: 'askWhere',
        label: 'Hỏi nơi lưu & đổi tên mỗi lần tải',
        hint: 'Bấm “Tải video” hoặc tải .zip sẽ mở hộp thoại để chọn thư mục và đặt tên file. Tự tải và thư mục trên canvas không hỏi.',
        keywords: 'save as lưu thành chọn nơi lưu vị trí đổi tên hộp thoại popup',
        C: AskWhereSetting,
      },
      {
        id: 'withPrompt',
        label: 'Kèm file .txt chứa prompt',
        hint: 'Lưu thêm “S03_T2 - tên cảnh.txt” chứa đúng prompt đã gửi, cạnh file video — khi tải, tự tải và lưu vào thư mục trên canvas. Tắt để chỉ lưu video.',
        keywords: 'txt prompt văn bản kèm theo file phụ',
        C: WithPromptSetting,
      },
      { id: 'folderUnlinkTrash', ...FOLDER_UNLINK_TRASH_ROW, C: FolderUnlinkTrashSetting },
      {
        id: 'autoDownload',
        label: 'Tự tải khi video xong',
        hint: 'Mỗi take hoàn thành được lưu ngay vào thư mục tải mặc định, không cần bấm, không hỏi.',
        keywords: 'tự động tải tự lưu auto download',
        C: AutoDownloadSetting,
      },
      {
        id: 'folder',
        label: 'Thư mục tải mặc định',
        hint: 'Nơi lưu video tự tải (và video tải khi tắt “Hỏi nơi lưu”).',
        keywords: 'downloads thư mục lưu folder chọn thư mục',
        C: DownloadFolderSetting,
      },
    ],
  },
  {
    id: 'prompt',
    level: 'basic',
    col: 0,
    title: 'Prompt',
    desc: 'Prompt được gửi đúng như bạn viết. Ảnh và video tham chiếu được gọi bằng số: @image_1, @video_1…',
    badge: <span className="badge" title="Lưu trong dự án đang mở, không phải cài đặt của máy">dự án này</span>,
    rows: [
      {
        id: 'autoRenumber',
        label: 'Tự đánh lại số @image/@video khi đổi tham chiếu',
        hint: 'Khi bỏ nối, đổi thứ tự hoặc thêm/bớt ảnh của nhân vật, các token trong prompt được sửa để vẫn trỏ đúng ảnh/video (hoàn tác được). Tắt nếu muốn tự quản lý số.',
        keywords: 'token image video đánh số renumber tham chiếu',
        C: AutoRenumberSetting,
      },
    ],
  },
  {
    id: 'updates',
    level: 'basic',
    col: 0,
    title: 'Cập nhật',
    desc: 'Bản cài (Setup) tự tìm và tải bản mới, rồi cài khi bạn khởi động lại hoặc tắt app. Dự án và cài đặt giữ nguyên.',
    keywords: 'update cập nhật nâng cấp phiên bản version bản mới tự động tải về khởi động lại github',
    Intro: UpdateStatusIntro,
    rows: [
      {
        id: 'updateAutoDownload',
        label: 'Tự động tải bản cập nhật',
        hint: 'Bản mới được tải ngầm khi có mạng và tự cài khi bạn tắt SanoVids. Tắt: chỉ báo có bản mới, bạn bấm để tải.',
        keywords: 'tự động tải update download nền ngầm',
        C: UpdateAutoDownloadSetting,
      },
      { id: 'updateCheck', label: 'Kiểm tra cập nhật', hint: 'SanoVids tự kiểm tra khi mở và 4 giờ một lần.', keywords: 'check kiểm tra ngay', C: UpdateCheckSetting },
    ],
  },
  {
    id: 'app',
    level: 'basic',
    col: 0,
    title: 'Ứng dụng',
    desc: 'Bản app desktop cho Windows, hoặc cài thành app trên trình duyệt.',
    // Also the Portable / temp-copy reminder (no Desktop / Start icon, no auto-update): lib/aboutModel placementNote.
    keywords: `cài app desktop exe windows pwa ${PLACEMENT_KEYWORDS}`,
    Block: AppBlock,
  },
  {
    id: 'playback',
    level: 'basic',
    col: 1,
    title: 'Âm thanh video',
    desc: 'Cho trình phát trên canvas, cửa sổ xem take và “Phát liền” ở Storyboard. Nhớ trên máy này.',
    rows: [
      {
        id: 'sound',
        label: 'Bật tiếng khi xem video',
        hint: 'Tắt để mọi video phát không tiếng. Trình duyệt có thể tạm chặn tiếng tới khi bạn bấm vào trang.',
        keywords: 'âm thanh loa tiếng mute tắt tiếng',
        C: SoundSetting,
      },
      { id: 'volume', label: 'Âm lượng', hint: 'Mức âm lượng mặc định của mọi trình phát.', keywords: 'volume to nhỏ', C: VolumeSetting },
      { id: 'rate', label: 'Tốc độ phát mặc định', hint: 'Tốc độ khi bắt đầu phát một video; đổi trên trình phát cũng được nhớ ở đây.', keywords: 'speed nhanh chậm', C: RateSetting },
    ],
  },
  {
    id: 'canvas',
    level: 'basic',
    col: 1,
    title: 'Dây nối & canvas',
    desc: 'Cách dây nối, thẻ cảnh và video hiện trên canvas.',
    rows: [
      { id: 'nodeEditor', ...NODE_EDITOR_ROW, C: NodeEditorSetting },
      {
        id: 'clickToCut',
        label: 'Bấm vào dây để cắt',
        hint: `Một cú bấm vào dây tham chiếu, khung hình, @video hoặc dây lưu là bỏ nối ngay (có Hoàn tác) — không cần nhắm nút ×. Ctrl/Shift + bấm để chọn dây; dây cảnh → video không bao giờ bị cắt. Tắt: bấm để chọn, rồi Delete hoặc nút × để cắt. ${CLICK_TO_CUT_TRASH_NOTE}`,
        keywords: 'hủy nối huỷ nối bỏ nối cắt dây x kẹt wire',
        C: ClickToCutSetting,
      },
      { id: 'edgeMode', label: 'Hiển thị dây nối', hint: 'Cũng đổi được trên thanh công cụ canvas (phím E).', keywords: 'dây ẩn hiện tất cả đang chọn edge', C: EdgeModeSetting },
      {
        id: 'takeDisplay',
        label: 'Video trên canvas',
        hint: '“Chỉ take chọn”: mỗi cảnh chỉ hiện take ★ (chưa có ★ thì take xong mới nhất).',
        keywords: 'take video hiện ẩn chọn sao',
        C: TakeDisplaySetting,
      },
      {
        id: 'interaction',
        label: 'Kéo trên nền canvas để',
        hint: 'Di chuyển: Shift+kéo để chọn vùng. Chọn vùng: giữ Space hoặc chuột giữa để di chuyển.',
        keywords: 'chuột tay chọn vùng pan kéo',
        C: InteractionSetting,
      },
      { id: 'minimap', label: 'Bản đồ thu nhỏ', hint: 'Khung nhỏ ở góc canvas cho thấy toàn bộ dự án.', keywords: 'minimap bản đồ góc', C: MinimapSetting },
      { id: 'bigProject', ...BIG_PROJECT_ROW, C: BigProjectSetting },
    ],
  },
  {
    id: 'data',
    level: 'basic',
    col: 1,
    title: 'Dữ liệu dự án',
    desc: 'Xuất file để sao lưu hoặc chuyển dự án sang máy khác; nhập file .sanovids.json; tạo lại dự án mẫu.',
    keywords: 'xuất nhập dự án sao lưu json mẫu demo backup',
    Block: DataBlock,
  },

  // ------------------------------------------------ Nâng cao ------------------------------------------------
  {
    id: 'motion',
    level: 'advanced',
    col: 0,
    title: 'Chuyển động & thông báo',
    rows: [
      {
        id: 'animations',
        label: 'Hiệu ứng chuyển động',
        hint: 'Đầy đủ: dây cắt rồi thu về, dây mới vẽ ra, thẻ Storyboard lướt. Giảm bớt: chỉ mờ dần, không gì trượt. Tắt: không hiệu ứng nào trong toàn bộ app.',
        keywords: 'hoạt ảnh animation giảm motion mượt',
        C: MotionSetting,
      },
      { id: 'toastTime', label: 'Thời gian hiện thông báo', hint: 'Thông báo có nút (Hoàn tác…) hiện lâu hơn khoảng gấp đôi.', keywords: 'toast giây hiện lâu', C: ToastTimeSetting },
    ],
  },
  {
    id: 'files',
    level: 'advanced',
    col: 0,
    title: 'Tên file & file .zip',
    desc: 'Tên mặc định của video khi tải, tự tải, nén .zip và lưu vào thư mục. Tên bạn tự đặt cho từng video (nút bút chì trên thẻ video) luôn được ưu tiên.',
    rows: [
      {
        id: 'nameTemplate',
        label: 'Cách đặt tên file',
        hint: 'Bấm một mã để chèn. Mã không có giá trị (ví dụ cảnh chưa có tên) được bỏ cùng dấu nối bên cạnh.',
        keywords: 'mẫu tên template đặt tên đổi tên scene take title date ngày giờ model',
        C: NameTemplateSetting,
      },
      {
        id: 'zipPrompts',
        label: 'Kèm prompts.txt trong file .zip',
        hint: 'Nút “Tải tất cả video chọn (.zip)” thêm một file prompts.txt gom prompt của mọi video.',
        keywords: 'zip nén prompt txt',
        C: ZipPromptsSetting,
      },
    ],
  },
  {
    id: 'layout',
    level: 'advanced',
    col: 0,
    title: 'Bố cục',
    rows: [
      {
        id: 'resetLayout',
        label: 'Đặt lại bố cục khung bên',
        hint: 'Hiện lại thư viện (trái) và bảng chi tiết (phải) với độ rộng mặc định.',
        keywords: 'khung bên panel sidebar độ rộng layout',
        C: ResetLayoutSetting,
      },
    ],
  },
  {
    id: 'backup',
    level: 'advanced',
    col: 0,
    title: 'Sao lưu & khôi phục cài đặt',
    rows: [
      {
        id: 'backupFile',
        label: 'Xuất / nhập cài đặt (.json)',
        hint: 'Mang cài đặt sang máy khác. Không gồm dự án, thư mục đã chọn, đăng nhập hay nhà cung cấp video.',
        keywords: 'export import json chuyển máy file',
        C: BackupSetting,
      },
      {
        id: 'resetAll',
        label: 'Khôi phục cài đặt mặc định',
        hint: 'Đưa mọi cài đặt trên máy này về như lúc mới cài (có Hoàn tác). Đăng nhập canvasapp và “Giữ đăng nhập” giữ nguyên.',
        keywords: 'reset mặc định đặt lại',
        C: ResetAllSetting,
      },
    ],
  },
  {
    id: 'gateway',
    level: 'advanced',
    col: 1,
    title: 'Cổng canvasapp.io.vn',
    desc: 'Nhà cung cấp video cho take mới, đăng nhập canvasapp và credit thật.',
    keywords: `canvasapp cổng nhà cung cấp provider đăng nhập đăng xuất credit thật nạp tiền ${KEEP_LOGIN_KEYWORDS}`,
    Block: GatewaySection,
  },
  {
    id: 'dev',
    level: 'basic',
    col: 1,
    title: 'Chế độ Phát triển',
    desc: 'canvasapp giả lập ngay trong app để tìm và sửa lỗi: đăng nhập, credit dev, gây lỗi, nhật ký yêu cầu.',
    keywords: 'dev phát triển giả lập debug bug lỗi nhật ký log tốc độ credit dev',
    Block: DevBlock,
  },
  // Version, author, copyright and the app's code signature (texts: lib/aboutModel.ts).
  { id: 'about', level: 'basic', col: 1, title: ABOUT_TITLE, desc: ABOUT_DESC, keywords: ABOUT_KEYWORDS, Block: AboutBlock },
]

const LEVEL_KEY = 'bdp:pref:settingsLevel'
const isLevel = oneOf(SETTINGS_LEVELS)

function readLevel(): SettingsLevel {
  try {
    return parsePref(localStorage.getItem(LEVEL_KEY), 'basic', isLevel)
  } catch {
    return 'basic'
  }
}
function saveLevel(level: SettingsLevel) {
  try {
    localStorage.setItem(LEVEL_KEY, JSON.stringify(level))
  } catch {
    /* storage unavailable */
  }
}

const LEVEL_HINT: Record<SettingsLevel, string> = { basic: 'Dùng hằng ngày', advanced: 'Tên file, hiệu ứng, cổng…' }

/** `section`: id of a group to show (deep link, see the top of this file); unknown ids are ignored. */
export function SettingsDialog({ section }: { section?: string } = {}) {
  const closeDialog = useUI((s) => s.closeDialog)
  const target = section ? GROUPS.find((g) => g.id === section) : undefined
  const [level, setLevel] = useState<SettingsLevel>(() => target?.level ?? readLevel())
  const [query, setQuery] = useState('')
  const [epoch, setEpoch] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  /** Group to bring into view once its level is shown (set by a deep link). */
  const pendingAnchor = useRef<Group | undefined>(target)
  const resultsId = useId()
  const resync = useCallback(() => setEpoch((e) => e + 1), [])
  const ctx = useMemo(() => ({ close: closeDialog, resync, epoch }), [closeDialog, resync, epoch])
  const matches = useMemo(() => matchSettings(GROUPS, level, query), [level, query])
  const searching = searchWords(query).length > 0
  const count = searching ? resultCount(matches) : 0

  // Ctrl+F / ⌘F: the settings search (instead of the page's find bar) while the dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Deep link while the dialog is already open (another "Cài đặt → …" button): show that group's level, no search.
  // The level is not saved: the next plain opening uses the level the user chose.
  useEffect(() => {
    if (!target) return
    pendingAnchor.current = target
    setLevel(target.level)
    setQuery('')
  }, [target])

  // Bring the requested group into view once its level is rendered, and move the focus there (screen readers land on
  // it; Tab continues inside it). A group whose section has no anchor (the gateway block) only gets its level shown.
  useEffect(() => {
    const group = pendingAnchor.current
    if (!group || group.level !== level || searchWords(query).length) return
    pendingAnchor.current = undefined
    const root = resultsRef.current
    const el = [...(root?.querySelectorAll<HTMLElement>('[data-set-anchor]') ?? [])].find((x) => x.dataset.setAnchor === group.id)
    if (!el) {
      // The section that had the focus may just have left with the old level: keep the focus inside the dialog.
      const dialog = root?.closest<HTMLElement>('[role="dialog"]')
      if (dialog && !dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true })
      return
    }
    el.scrollIntoView({ block: 'start' })
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
    el.focus({ preventScroll: true })
  })

  const chooseLevel = (next: SettingsLevel) => {
    setLevel(next)
    saveLevel(next)
    setQuery('')
  }

  return (
    <Modal
      title="Cài đặt"
      onClose={closeDialog}
      size="wide"
      footer={
        <button className="btn btn-primary" onClick={closeDialog}>
          Xong
        </button>
      }
    >
      <SettingsCtx.Provider value={ctx}>
        <div className="dg-set">
          <div className="dg-set-bar">
            <div className={`dg-set-levels${searching ? ' searching' : ''}`}>
              <Segmented
                label="Mức cài đặt"
                value={level}
                onChange={chooseLevel}
                options={SETTINGS_LEVELS.map((l) => ({ id: l, label: SETTINGS_LEVEL_LABEL[l], hint: LEVEL_HINT[l] }))}
              />
            </div>
            <label className="dg-search dg-set-search" title="Tìm cài đặt (Ctrl+F)">
              <Search size={14} aria-hidden />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Tìm cài đặt…"
                aria-label="Tìm cài đặt"
                aria-controls={resultsId}
                autoComplete="off"
                spellCheck={false}
              />
              {query && (
                <button
                  type="button"
                  className="dg-x"
                  aria-label="Xoá tìm kiếm"
                  title="Xoá tìm kiếm"
                  onClick={() => {
                    setQuery('')
                    searchRef.current?.focus()
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </label>
          </div>
          <div className="dg-set-status" role="status">
            {searching && count > 0 ? `${count} cài đặt khớp “${query.trim()}” — tìm trong cả Cơ bản và Nâng cao.` : ''}
          </div>
          <div id={resultsId} ref={resultsRef}>
            {!searching ? (
              <Columns matches={matches} />
            ) : matches.length ? (
              // Search results: "Cơ bản" on the left, "Nâng cao" on the right (stacked on narrow screens).
              <div className="dg-settings">
                {SETTINGS_LEVELS.map((l) => {
                  const part = matches.filter((m) => m.group.level === l)
                  if (!part.length) return null
                  return (
                    <div key={l} className="dg-settings-col">
                      <h3 className="dg-set-level">{SETTINGS_LEVEL_LABEL[l]}</h3>
                      {part.map((m) => (
                        <GroupView key={m.group.id} match={m} />
                      ))}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="empty dg-set-empty">
                <span>Không có cài đặt nào khớp “{query.trim()}”.</span>
                <button type="button" className="btn btn-sm" onClick={() => setQuery('')}>
                  Xoá tìm kiếm
                </button>
              </div>
            )}
          </div>
        </div>
      </SettingsCtx.Provider>
    </Modal>
  )
}

/** The groups of one level in their two columns (one column on narrow screens). */
function Columns({ matches }: { matches: GroupMatch<Group>[] }) {
  const cols: GroupMatch<Group>[][] = [[], []]
  for (const m of matches) cols[m.group.col].push(m)
  return (
    <div className="dg-settings">
      {cols.map((list, i) =>
        list.length ? (
          <div className="dg-settings-col" key={i}>
            {list.map((m) => (
              <GroupView key={m.group.id} match={m} />
            ))}
          </div>
        ) : null,
      )}
    </div>
  )
}

function GroupView({ match: { group, rows } }: { match: GroupMatch<Group> }) {
  // A block renders its own <Section>: the context gives it this group's anchor (deep link).
  if (group.Block)
    return (
      <SectionAnchorCtx.Provider value={group.id}>
        <group.Block />
      </SectionAnchorCtx.Provider>
    )
  const Intro = group.Intro
  return (
    <Section title={group.title} desc={group.desc} badge={group.badge} anchor={group.id}>
      {Intro && <Intro />}
      {rows.map((r) => (
        <r.C key={r.id} label={r.label} hint={r.hint} />
      ))}
    </Section>
  )
}
