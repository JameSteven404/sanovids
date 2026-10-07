import { type ReactNode } from 'react'
import { useUI } from '../../store/ui'
import { Modal } from '../common/Modal'
import './dialogs.css'
import { KEY_ACTIONS, FIXED_KEYS, chordLabel } from '../../core/keymap'
import { IS_MAC } from '../../lib/keyEvents'
import { useKeymap } from '../../lib/keymapPrefs'

const GROUP_TITLES = { keys: 'Chung', keysScene: 'Cảnh & chọn', keysTake: 'Video', keysCanvas: 'Canvas' }
const UNBOUND = 'Chưa gán'
const FIXED_TITLE = 'Phím cố định'

/** Keys: '+' joins a combo, ' / ' separates alternatives. */
type Row = [keys: string, label: ReactNode]
interface Group {
  title: string
  rows: Row[]
}

const GESTURES: Group[] = [
  {
    title: 'Sửa cảnh trên node',
    rows: [
      ['Enter', 'Gõ prompt ngay trên node của cảnh đang chọn (khi chỉ chọn một cảnh)'],
      ['Esc', 'Đang gõ trên node: thôi gõ, cảnh vẫn được chọn'],
      ['Ctrl+Enter / ⌘Enter', 'Chạy khi đang gõ trên node: chỉ cảnh đó'],
    ],
  },
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

export function ShortcutsDialog() {
  const resolved = useKeymap((s) => s.resolved)
  const closeDialog = useUI((s) => s.closeDialog)
  return (
    <Modal title="Phím tắt & thao tác" onClose={closeDialog} size="xwide">
      <div className="dg-shortcuts">
        <div className="dg-sc-col">
          <p className="dg-note">Phím mặc định giống Adobe Premiere Pro. Dưới đây là bộ phím đang dùng trên máy này.</p>
          <button className="btn" onClick={() => useUI.getState().openDialog({ kind: 'settings', section: 'keys' })}>Đổi phím tắt…</button>
          {(['keys', 'keysScene', 'keysTake', 'keysCanvas'] as const).map((group) => (
            <section key={group} className="dg-sc-group">
              <h4>{GROUP_TITLES[group]}</h4>
              <div className="dg-sc-list">{KEY_ACTIONS.filter((a) => a.group === group).map((a) => (
                <div key={a.id} className="dg-sc-row">
                  <span className="dg-sc-label" title={a.help}>{a.label}</span>
                  <span>{resolved.byAction[a.id].map((c) => <span className="kbd" key={c}>{chordLabel(c, IS_MAC)}</span>)}{!resolved.byAction[a.id].length && UNBOUND}</span>
                </div>
              ))}</div>
            </section>
          ))}
          <section className="dg-sc-group"><h4>{FIXED_TITLE}</h4>{FIXED_KEYS.filter((r) => !r.macOnly || IS_MAC).map((r, i) => (
            <div className="dg-sc-row" key={i}><span className="dg-sc-label">{r.label}</span><span>{r.keys.map((c) => chordLabel(c, IS_MAC)).join(' / ')}</span></div>
          ))}</section>
          <section className="dg-sc-group"><h4>Thư viện</h4>
            <p>Sau khi bấm vào Thư viện: {resolved.allLabels['selection.delete'] || UNBOUND}{IS_MAC ? ' / ⌫' : ''} xoá mục thư viện; {resolved.allLabels['selection.selectAll'] || UNBOUND} chọn mọi thẻ đang thấy. Không tác động lên cảnh trên canvas.</p>
          </section>
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
          <p className="dg-note">Khi đang gõ, chỉ dùng được Lưu ({resolved.allLabels['project.save'] || UNBOUND}), Chạy ({resolved.allLabels['scene.run'] || UNBOUND}) và Esc.</p>
        </div>
      </div>
    </Modal>
  )
}
