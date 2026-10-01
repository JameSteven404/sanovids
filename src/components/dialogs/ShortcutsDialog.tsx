import { Fragment, type ReactNode } from 'react'
import { useUI } from '../../store/ui'
import { Modal } from '../common/Modal'
import './dialogs.css'

/** Keys: '+' joins a combo, '/' separates alternatives. */
type Row = [keys: string, label: ReactNode]
interface Group {
  title: string
  rows: Row[]
}

const KEY_GROUPS: Group[] = [
  {
    title: 'Chung',
    rows: [
      ['Ctrl+Z', 'Hoàn tác'],
      ['Ctrl+Shift+Z / Ctrl+Y', 'Làm lại'],
      ['Ctrl+S', 'Lưu ngay'],
      ['Ctrl+K', 'Tìm trong thư viện'],
      ['1 / 2 / 3', 'Canvas / Bảng cảnh / Storyboard'],
      ['Esc', 'Bỏ chọn · đóng hộp thoại'],
      ['?', 'Mở bảng phím tắt này'],
    ],
  },
  {
    title: 'Cảnh & chọn',
    rows: [
      ['N', 'Cảnh mới · cảnh tiếp theo sau cảnh đang chọn (giữ nhân vật, khối, cấu hình)'],
      ['Ctrl+D', 'Nhân bản cảnh đang chọn'],
      ['Delete / Backspace', 'Xoá cảnh · ẩn thẻ khỏi canvas · cắt dây đang chọn'],
      ['Ctrl+A', 'Chọn tất cả cảnh'],
      ['C', 'Nối mọi nhân vật đang chọn vào mọi cảnh đang chọn'],
      ['Ctrl+Enter', 'Chạy các cảnh đang chọn'],
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
    title: 'Bảng cảnh & Storyboard',
    rows: [
      ['↑ / ↓', 'Chuyển cảnh (Shift để chọn thêm)'],
      ['Shift+Click / Ctrl+Click', 'Chọn một dải / chọn thêm từng dòng'],
      ['Space', 'Phát liền: phát / tạm dừng'],
      ['← / →', 'Phát liền: cảnh trước / sau'],
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
    title: 'Cách nối',
    rows: [
      ['Chấm teal → thẻ cảnh', 'Kéo từ nhân vật, thả ở bất kỳ đâu trên thẻ cảnh để nối. Nếu cảnh đó đang được chọn cùng cảnh khác → nối vào tất cả.'],
      ['Thả ra chỗ trống', 'Menu: “Tạo cảnh mới có @Tag” hoặc “Nối vào N cảnh đang chọn”.'],
      ['Chấm phải của cảnh', 'Kéo sang cảnh khác → cảnh đó tiếp nối cảnh này. Thả ra chỗ trống → tạo cảnh tiếp theo.'],
      ['Thư viện → cảnh', 'Kéo thẻ (hoặc nhiều thẻ đã chọn) từ thư viện thả vào cảnh trên canvas hoặc dòng trong Bảng cảnh.'],
      ['Thư viện → nền', 'Đặt nhân vật lên canvas tại điểm thả. Thả file ảnh → tạo nhân vật mới.'],
      ['Đầu dây → cảnh khác', 'Chuyển tham chiếu sang cảnh khác.'],
      ['Bấm dây', 'Chọn dây; Delete hoặc nút × ở giữa dây để cắt.'],
      ['Gõ @Tên', 'Trong prompt: chèn nhân vật và tự nối vào cảnh.'],
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
              <span className="kbd">{k}</span>
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
              {g.rows.map(([keys, label]) => (
                <div key={keys} className="dg-sc-row">
                  <span className="dg-sc-label">{label}</span>
                  <Keys keys={keys} />
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="dg-sc-col">
          {GESTURES.map((g) => (
            <section key={g.title} className="dg-sc-group">
              <h4>{g.title}</h4>
              {g.rows.map(([gesture, label]) => (
                <div key={gesture} className="dg-sc-row gesture">
                  <span className="dg-sc-gesture">{gesture}</span>
                  <span className="dg-sc-label">{label}</span>
                </div>
              ))}
            </section>
          ))}
          <p className="dg-note">Phím tắt không hoạt động khi đang gõ trong ô nhập, trừ Ctrl+Enter, Ctrl+S và Esc.</p>
        </div>
      </div>
    </Modal>
  )
}
