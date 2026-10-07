import { Fragment, type ReactNode } from 'react'
import { useUI } from '../../store/ui'
import { Modal } from '../common/Modal'
import './dialogs.css'

/** Keys: '+' joins a combo, ' / ' separates alternatives. */
type Row = [keys: string, label: ReactNode]
interface Group {
  title: string
  rows: Row[]
}

/** Same test as hooks/useShortcuts: Mac keyboards use ⌘ and ⌫ where Windows uses Ctrl and Delete. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
/** Key names as printed on this keyboard. */
const keyName = (k: string) => (IS_MAC && k === 'Ctrl' ? '⌘' : k)

const KEY_GROUPS: Group[] = [
  {
    title: 'Chung',
    rows: [
      ['Ctrl+Z', 'Hoàn tác'],
      ['Ctrl+Shift+Z / Ctrl+Y', 'Làm lại'],
      ['Ctrl+S', 'Lưu ngay'],
      ['Ctrl+K', 'Tìm trong thư viện'],
      ['Esc', 'Bỏ chọn · đóng hộp thoại'],
      ['?', 'Mở bảng phím tắt này'],
    ],
  },
  {
    title: 'Cảnh & chọn',
    rows: [
      ['N', 'Cảnh tiếp theo, đặt ngay bên dưới cảnh đang chọn (giữ ảnh tham chiếu và cấu hình) · cảnh mới khi chưa chọn gì'],
      ['Ctrl+D', 'Nhân bản cảnh đang chọn'],
      [
        IS_MAC ? 'Delete / ⌫' : 'Delete',
        'Xoá cảnh và video (take) đang chọn · ẩn thẻ khỏi canvas · cắt dây đang chọn. Video chọn cùng cảnh của nó chỉ ẩn theo cảnh (hoàn tác được).',
      ],
      ['Ctrl+A', 'Chọn tất cả cảnh trên canvas'],
      ['C', 'Nối mọi nhân vật (ảnh tham chiếu) đang chọn vào mọi cảnh đang chọn'],
      ['Ctrl+Enter', 'Chạy các cảnh đang chọn · đang gõ trên node: chỉ cảnh đó (xem chi phí trước)'],
      // the scene node is the editor (E2): typing on the node itself
      ['Enter', 'Gõ prompt ngay trên node của cảnh đang chọn (khi chỉ chọn một cảnh)'],
      ['Esc', 'Đang gõ trên node: thôi gõ, cảnh vẫn được chọn'],
    ],
  },
  {
    // Library scope of the same keys (libraryActions): only after a click in the library, never the canvas selection.
    title: 'Thư viện',
    rows: [
      [
        IS_MAC ? 'Delete / ⌫' : 'Delete',
        'Sau khi bấm vào Thư viện: xoá các thẻ đang chọn (đang thấy) khỏi thư viện và mọi cảnh — xoá ngay; chỉ hỏi một lần khi prompt đang nhắc ảnh của thẻ (sẽ thành chữ đỏ) hoặc cảnh mất khung đầu / cuối · hoàn tác được.',
      ],
      ['Ctrl+A', 'Sau khi bấm vào Thư viện: chọn mọi thẻ đang thấy'],
    ],
  },
  {
    title: 'Canvas',
    rows: [
      ['F', 'Vừa màn hình (vùng chọn hoặc tất cả)'],
      ['E', 'Đổi cách hiện dây: Ẩn → Đang chọn → Tất cả'],
      ['H / V', 'Chế độ Tay / Chọn'],
      ['M', 'Bật/tắt bản đồ nhỏ'],
    ],
  },
  {
    title: 'Thứ tự cảnh',
    rows: [['Alt+↑ / Alt+↓', 'Dời cảnh đang chọn lên trước / ra sau một chỗ. Giữ phím để dời nhiều chỗ, Ctrl+Z trả lại cả lượt']],
  },
  {
    // One table for every player (core/transportKeys): the take viewer, a take's "Phóng to" and Phát liền.
    title: 'Trình phát video (xem take, video phóng to, Phát liền)',
    rows: [
      ['Space / K', 'Phát – dừng (K luôn dừng)'],
      ['L / J', 'Tua tới / tua lùi — bấm thêm: 2×, 4×'],
      ['← / →', 'Từng khung hình (Shift: 5 khung)'],
      ['↑ / ↓', 'Take trước / sau (Phát liền: cảnh trước / sau · video phóng to: âm lượng)'],
      ['Home / End', 'Về đầu / về cuối (Phát liền: cảnh đầu / cuối)'],
      [IS_MAC ? '`' : 'Ctrl+` / `', 'Bật / tắt toàn màn hình · Esc chỉ thoát toàn màn hình (lần nữa: đóng)'],
      ['M', 'Chọn ★ take đang xem (cửa sổ xem take, video phóng to)'],
      [IS_MAC ? '⌘E' : 'Ctrl+M', 'Tải video đang xem (cửa sổ xem take)'],
      ['F / Esc', 'Thoát video phóng to (lúc đó các phím khác của app không chạy)'],
    ],
  },
]

const GESTURES: Group[] = [
  {
    title: 'Di chuyển trên canvas',
    rows: [
      ['Kéo nền', 'Di chuyển khung nhìn (chế độ Tay) · Shift+kéo để chọn vùng'],
      ['Chế độ Chọn', 'Kéo nền để chọn vùng · Space+kéo hoặc chuột giữa để di chuyển'],
      ['Lăn chuột', 'Thu phóng (cả Ctrl+lăn và chụm hai ngón)'],
      ['Nhấp đúp nền', 'Tạo cảnh mới tại đó'],
    ],
  },
  {
    title: 'Thứ tự cảnh',
    rows: [
      ['▲ / ▼ cạnh mã cảnh', 'Ở bảng bên phải: dời cảnh đang chọn lên trước / ra sau một chỗ'],
      [
        'Bấm vào mã cảnh (S05)',
        `Gõ vị trí mới để dời một lần tới đó. Các cảnh khác đánh số lại; Phát liền và file .zip đi theo thứ tự mới, thẻ trên canvas giữ chỗ cũ (bấm Sắp xếp để xếp lại). ${IS_MAC ? '⌘' : 'Ctrl'}+Z để hoàn tác.`,
      ],
    ],
  },
  {
    title: 'Cách nối',
    rows: [
      [
        'Chấm teal → thẻ cảnh',
        'Kéo từ chấm teal của nhân vật, thả ở bất kỳ đâu trên thẻ cảnh (không cần trúng chấm): thêm ảnh tham chiếu @image_N. Kéo từ một nhân vật trong nhóm đang chọn → nối cả nhóm; thả vào cảnh đang được chọn cùng cảnh khác → nối vào mọi cảnh đang chọn.',
      ],
      [
        'Chấm tím của video → Thư mục',
        'Kéo từ video (take) vào một Thư mục để lưu file. Video không dùng làm tham chiếu cho cảnh được nữa (thả lên cảnh: không nối gì).',
      ],
      [
        'Thả ra chỗ trống',
        'Từ nhân vật: “Tạo cảnh mới có @Tag” hoặc “Nối vào N cảnh đang chọn”. Từ video: “Tạo cảnh tiếp theo từ video này” (cảnh mới cạnh video, cùng ảnh tham chiếu và cấu hình của video đó, prompt để trống).',
      ],
      ['Thư viện → cảnh', 'Kéo thẻ nhân vật (một hay nhiều thẻ đã chọn) thả vào cảnh trên canvas.'],
      ['Thư viện → nền', 'Đặt nhân vật lên canvas tại điểm thả. Thả file ảnh → tạo nhân vật mới.'],
      ['Đầu dây → cảnh khác', 'Kéo đầu dây sang cảnh khác: chuyển tham chiếu sang cảnh đó. Thả đầu dây ra chỗ trống: cắt dây.'],
      [
        'Bấm dây',
        `Bấm vào dây (con trỏ hình kéo) là cắt ngay; ${IS_MAC ? '⌘' : 'Ctrl'}/Shift + bấm để chọn dây rồi ${IS_MAC ? 'Delete / ⌫' : 'Delete'}. Tắt “Bấm vào dây để bỏ nối” trong Cài đặt thì bấm chỉ chọn dây (cắt bằng Delete hoặc nút × giữa dây). Số @image trong prompt tự đánh lại (hoàn tác được).`,
      ],
      ['Gõ @', 'Trong prompt: chọn ảnh để chèn @image_N (ảnh chưa nối sẽ được nối luôn).'],
      ['ĐẦU / CUỐI', 'MiniMax-H3 chế độ Khung đầu → cuối: thả nhân vật vào chấm ĐẦU hoặc CUỐI.'],
    ],
  },
]

function Keys({ keys }: { keys: string }) {
  const alts = keys.split(' / ')
  return (
    <span className="dg-keys">
      {alts.map((alt, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="dg-keys-or">/</span>}
          {alt.split('+').map((k, j) => (
            <Fragment key={j}>
              {j > 0 && <span className="dg-keys-plus">+</span>}
              <span className="kbd">{keyName(k)}</span>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  )
}

export function ShortcutsDialog() {
  const closeDialog = useUI((s) => s.closeDialog)
  return (
    <Modal title="Phím tắt & thao tác" onClose={closeDialog} size="xwide">
      <div className="dg-shortcuts">
        <div className="dg-sc-col">
          {KEY_GROUPS.map((g) => (
            <section key={g.title} className="dg-sc-group">
              <h4>{g.title}</h4>
              <div className="dg-sc-list">
                {g.rows.map(([keys, label]) => (
                  <div key={keys} className="dg-sc-row">
                    <span className="dg-sc-label">{label}</span>
                    <Keys keys={keys} />
                  </div>
                ))}
              </div>
            </section>
          ))}
          <p className="dg-note">
            {IS_MAC
              ? 'Trên Mac: ⌘ thay cho Ctrl; ⌫ (hoặc fn+⌫) để xoá — nếu ngay sau ⌫ có phím khác (bộ gõ tiếng Việt vừa bỏ dấu), không xoá gì.'
              : 'Chỉ phím Delete xoá: Backspace không xoá trên Windows vì bộ gõ tiếng Việt (Unikey, EVKey, OpenKey…) gửi Backspace khi bỏ dấu, kể cả khi không gõ trong ô nhập. Trên Mac dùng ⌫.'}
          </p>
        </div>
        <div className="dg-sc-col">
          {GESTURES.map((g) => (
            <section key={g.title} className="dg-sc-group">
              <h4>{g.title}</h4>
              <div className="dg-sc-list">
                {g.rows.map(([gesture, label]) => (
                  <div key={gesture} className="dg-sc-row gesture">
                    <span className="dg-sc-gesture">{gesture}</span>
                    <span className="dg-sc-label">{label}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
          <p className="dg-note">Phím tắt không hoạt động khi đang gõ trong ô nhập, trừ {IS_MAC ? '⌘' : 'Ctrl'}+Enter, {IS_MAC ? '⌘' : 'Ctrl'}+S và Esc.</p>
        </div>
      </div>
    </Modal>
  )
}
