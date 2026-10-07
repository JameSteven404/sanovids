// Every user-facing phrase that depends on the operating system (lib/platform): the file manager, the downloads folder,
// the trash, the save dialog, the account that protects local data, the input-method tools, the modifier key, the
// system settings path… Callers build their sentences around these pieces, so a Mac never reads "Windows", "Ctrl" or
// "File Explorer" and Windows never reads "Finder" or "⌘". Pure: no stores, no React. Tested in
// __tests__/platformText.test.ts (both platforms define every key, Mac copy never names Windows things and back).
//
// ---- API ----
//   PlatformTexts                  the phrases of one platform (keys below).
//   PLATFORM_TEXTS                 { win, mac }.
//   textsFor(platform)             the phrases of a platform (tests, previews).
//   platformText                   the phrases of THIS device (lib/platform PLATFORM).
import { PLATFORM, type Platform } from './platform'

export interface PlatformTexts {
  /** The operating system's name. */
  os: string
  /** The file manager: 'File Explorer' / 'Finder' ("Mở … trong Finder"). */
  fileManager: string
  /** The downloads folder, as a noun phrase ("vào thư mục Tải về (Downloads)"). */
  downloads: string
  /** The trash files go to ("chuyển file vào Thùng rác của Windows"). */
  trash: string
  /** Why a file could not go to the trash (a parenthesis appended to the sentence that says so). */
  trashFailReason: string
  /** How to get a trashed file back, as a clause ("Bản cũ vẫn nằm trong Thùng rác — <this>."). */
  trashRestore: string
  /** The native save dialog. */
  saveDialog: string
  /** The account whose login protects local data ("dùng chung một tài khoản Windows"). */
  account: string
  /** Where a device pref is kept ("Phím tắt được lưu trên máy này, theo tài khoản Windows."). */
  accountScope: string
  /** What encrypts a secret kept on this device ("Phiên được mã hoá bằng <this>."). */
  encryptedWith: string
  /** Vietnamese input-method tools people use there ("bộ gõ (Unikey, EVKey, OpenKey…)"). */
  inputTools: string
  /** The main modifier key as written in UI text: 'Ctrl' / '⌘'. */
  mod: string
  /** Modifier + click: 'Ctrl + bấm' / '⌘ + bấm' (on a Mac ⌃ + click is a right-click). */
  modClick: string
  /** Modifier or Shift + click (multi-select): 'Ctrl/Shift + bấm' / '⌘/Shift + bấm'. */
  modShiftClick: string
  /** How to open a context menu ("<this>: mở menu"). */
  secondaryClick: string
  /** The system settings app. */
  systemSettings: string
  /** Where to set the clock right ("Vào <this>, rồi thử lại."). */
  clockSync: string
  /** The desktop app (the same on both: there is one app). */
  desktopApp: string
}

export const PLATFORM_TEXTS: Readonly<Record<Platform, Readonly<PlatformTexts>>> = Object.freeze({
  win: Object.freeze({
    os: 'Windows',
    fileManager: 'File Explorer',
    downloads: 'thư mục Tải xuống (Downloads)',
    trash: 'Thùng rác của Windows',
    trashFailReason: '(file đang mở trong chương trình khác, hoặc Thùng rác của ổ này đang tắt / đầy / không có)',
    trashRestore: 'mở Thùng rác để khôi phục',
    saveDialog: 'hộp thoại Lưu của Windows',
    account: 'tài khoản Windows',
    accountScope: 'theo tài khoản Windows',
    encryptedWith: 'tài khoản Windows của bạn',
    inputTools: 'Unikey, EVKey, OpenKey…',
    mod: 'Ctrl',
    modClick: 'Ctrl + bấm',
    modShiftClick: 'Ctrl/Shift + bấm',
    secondaryClick: 'Chuột phải',
    systemSettings: 'Cài đặt Windows',
    clockSync: 'Cài đặt Windows → Thời gian & ngôn ngữ → Đồng bộ ngay',
    desktopApp: 'bản desktop SanoVids',
  }),
  mac: Object.freeze({
    os: 'macOS',
    fileManager: 'Finder',
    downloads: 'thư mục Tải về (Downloads)',
    trash: 'Thùng rác',
    trashFailReason: '(ổ này không có Thùng rác — ví dụ ổ mạng — hoặc macOS chưa cho SanoVids truy cập thư mục)',
    trashRestore: 'mở Thùng rác trên Dock rồi kéo file về thư mục',
    saveDialog: 'hộp thoại Lưu của macOS',
    account: 'tài khoản người dùng trên máy Mac',
    accountScope: 'theo tài khoản người dùng trên máy Mac',
    encryptedWith: 'Chuỗi khoá (Keychain) trên máy Mac của bạn',
    inputTools: 'EVKey, OpenKey, GoTiếngViệt…',
    mod: '⌘',
    modClick: '⌘ + bấm',
    modShiftClick: '⌘/Shift + bấm',
    secondaryClick: '⌃ + bấm hoặc bấm hai ngón',
    systemSettings: 'Cài đặt hệ thống',
    clockSync: 'Cài đặt hệ thống → Chung → Ngày & Giờ',
    desktopApp: 'bản desktop SanoVids',
  }),
})

/** The phrases of `platform` (anything unexpected → Windows, the default wording). */
export function textsFor(platform: Platform): Readonly<PlatformTexts> {
  return platform === 'mac' ? PLATFORM_TEXTS.mac : PLATFORM_TEXTS.win
}

/** The phrases of this device. */
export const platformText: Readonly<PlatformTexts> = textsFor(PLATFORM)
