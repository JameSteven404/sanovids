// "Cài đặt": every user-tunable preference, in two levels — "Cơ bản" (everyday) and "Nâng cao" — with a search box
// that looks in both (label, hint and keywords, accents ignored; Ctrl+F focuses it). The rows are declared once in
// GROUPS below: the same label / hint feeds the row and the search (settingsSearch.ts). Each row component
// subscribes to its own pref and applies at once; the stores persist and validate (see lib/settings.ts for the list,
// the reset to defaults and the export / import of a settings file). Rows: SettingsBasic.tsx / SettingsAdvanced.tsx.
import { Search, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { oneOf, parsePref, useUI } from '../../store/ui'
import { Modal } from '../common/Modal'
import './dialogs.css'
import { GatewaySection } from './GatewaySection'
import { Segmented } from './Segmented'
import {
  BackupSetting,
  CreditBlock,
  MockConcurrencySetting,
  MockFailSetting,
  MockIntro,
  MockRecordSetting,
  MockSpeedSetting,
  MotionSetting,
  NameTemplateSetting,
  ResetAllSetting,
  ResetLayoutSetting,
  ToastTimeSetting,
  ZipPromptsSetting,
} from './SettingsAdvanced'
import {
  AppBlock,
  AskWhereSetting,
  AutoDownloadSetting,
  AutoRenumberSetting,
  ClickToCutSetting,
  DataBlock,
  DownloadFolderSetting,
  EdgeModeSetting,
  InteractionSetting,
  MinimapSetting,
  RateSetting,
  SoundSetting,
  TakeDisplaySetting,
  ThemeSetting,
  VolumeSetting,
  WithPromptSetting,
} from './SettingsBasic'
import { matchSettings, resultCount, searchWords, SETTINGS_LEVEL_LABEL, SETTINGS_LEVELS, type GroupMatch, type SearchGroup, type SearchRow, type SettingsLevel } from './settingsSearch'
import { Section, SettingsCtx, type RowProps } from './settingsUi'

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
  { id: 'app', level: 'basic', col: 0, title: 'Ứng dụng', desc: 'Dùng ngay trên web, hoặc cài thành app trên máy.', keywords: 'cài app pwa desktop exe phiên bản offline windows', Block: AppBlock },
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
    desc: 'Cách dây nối và video hiện trên canvas.',
    rows: [
      {
        id: 'clickToCut',
        label: 'Bấm vào dây để cắt',
        hint: 'Một cú bấm vào dây tham chiếu, khung hình, @video hoặc dây lưu là bỏ nối ngay (có Hoàn tác) — không cần nhắm nút ×. Ctrl/Shift + bấm để chọn dây; dây cảnh → video không bao giờ bị cắt. Tắt: bấm để chọn, rồi Delete hoặc nút × để cắt.',
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
    ],
  },
  {
    id: 'data',
    level: 'basic',
    col: 1,
    title: 'Dữ liệu dự án',
    desc: 'Xuất file để sao lưu hoặc chuyển dự án sang máy khác; nhập file .sanovids.json; tạo lại dự án demo.',
    keywords: 'xuất nhập dự án sao lưu json demo backup',
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
        hint: 'Đưa mọi cài đặt trên máy này về như lúc mới cài (có Hoàn tác).',
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
    keywords: 'canvasapp cổng nhà cung cấp provider đăng nhập đăng xuất credit thật nạp tiền',
    Block: GatewaySection,
  },
  {
    id: 'mock',
    level: 'advanced',
    col: 1,
    title: 'Nhà cung cấp giả lập',
    desc: 'Không gọi mạng, không tốn tiền. Dùng để thử hàng đợi, lỗi và take.',
    keywords: 'mock demo giả lập',
    badge: <span className="badge accent">demo</span>,
    Intro: MockIntro,
    rows: [
      { id: 'mockSpeed', label: 'Tốc độ tạo video', keywords: 'nhanh chậm', C: MockSpeedSetting },
      { id: 'mockFail', label: 'Tỉ lệ lỗi giả', hint: 'Job lỗi được hoàn credit demo.', keywords: 'lỗi fail', C: MockFailSetting },
      { id: 'mockConcurrency', label: 'Số job chạy cùng lúc', keywords: 'song song concurrency', C: MockConcurrencySetting },
      {
        id: 'mockRecord',
        label: 'Ghi video webm giả',
        hint: 'Tạo đoạn video 3 giây cho mỗi take. Tắt nếu máy chậm — khi đó chỉ có poster.',
        keywords: 'webm video giả',
        C: MockRecordSetting,
      },
    ],
  },
  { id: 'credits', level: 'advanced', col: 1, title: 'Credit demo', desc: 'Credit giả lập của Demo giả lập.', keywords: 'credit demo giả lập số dư', Block: CreditBlock },
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

export function SettingsDialog() {
  const closeDialog = useUI((s) => s.closeDialog)
  const [level, setLevel] = useState<SettingsLevel>(readLevel)
  const [query, setQuery] = useState('')
  const [epoch, setEpoch] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
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
          <div id={resultsId}>
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
  if (group.Block) return <group.Block />
  const Intro = group.Intro
  return (
    <Section title={group.title} desc={group.desc} badge={group.badge}>
      {Intro && <Intro />}
      {rows.map((r) => (
        <r.C key={r.id} label={r.label} hint={r.hint} />
      ))}
    </Section>
  )
}
