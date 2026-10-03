// "Bảng phát triển → Cập nhật": drives the simulated app updater of development mode (providers/dev/updates) so the
// update UI can be tried in a browser: top-bar pill, "Cập nhật SanoVids" dialog, Settings → Cập nhật, toasts and
// "Cập nhật khi xong" — and the simulated code-signature self-check shown in Settings → Giới thiệu
// (providers/dev/appSignature). Nothing is downloaded or checked, no network. Only offered outside Electron
// (DevPanel / devPanelTabs).
import { CloudDownload, FlaskConical, RotateCcw, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { isUpdateVersion } from '../../lib/updateModel'
import type { UpdateKind } from '../../lib/updateTypes'
import { DEV_SIGNATURE_OPTIONS, devSignature, devSignaturePresetOf, useDevSignature, type DevSignaturePreset } from '../../providers/dev/appSignature'
import { DEV_NEXT_CHECK_LABEL, devUpdates, useDevUpdates, type DevNextCheck } from '../../providers/dev/updates'
import { Segmented } from '../dialogs/Segmented'

const KIND_OPTIONS: { id: UpdateKind; label: string; title: string }[] = [
  { id: 'installer', label: 'Bản cài', title: 'Bản cài (Setup): tự tải và tự cài bản mới' },
  { id: 'portable', label: 'Bản portable', title: 'Bản portable: chỉ báo có bản mới' },
  { id: 'dev', label: 'Bản phát triển', title: 'Chạy từ mã nguồn: không tự cập nhật' },
]

const NEXT_CHECKS: DevNextCheck[] = ['none', 'available', 'offline', 'no-release']

function UpdCard({ title, icon, children, wide }: { title: string; icon: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <section className={wide ? 'dv-card dv-grid-wide' : 'dv-card'}>
      <header>
        <span className="dv-card-icon" aria-hidden="true">
          {icon}
        </span>
        <h3>{title}</h3>
      </header>
      {children}
    </section>
  )
}

export function DevUpdatesTab() {
  const state = useDevUpdates((s) => s.state)
  const nextCheck = useDevUpdates((s) => s.nextCheck)
  const draft = useDevUpdates((s) => s.draft)
  const currentOk = isUpdateVersion(draft.current)
  const versionOk = isUpdateVersion(draft.version)
  const sigStatus = useDevSignature((s) => s.status)
  const sigPackaged = useDevSignature((s) => s.packaged)
  const sigSigner = useDevSignature((s) => s.signer)
  const sigPreset = devSignaturePresetOf({ status: sigStatus, packaged: sigPackaged, signer: sigSigner })

  return (
    <div className="dv-upd">
      <p className="dv-hint dv-upd-intro">
        Giả lập trình cập nhật của bản cài Windows để thử giao diện (thanh trên cùng, hộp thoại, Cài đặt). Không tải gì, không gọi mạng.
      </p>
      <div className="dv-grid">
        <UpdCard title="Bản đang chạy" icon={<FlaskConical size={15} />}>
          <div className="dv-field">
            <span className="label">Loại bản</span>
            <Segmented<UpdateKind> label="Loại bản" value={state.kind} onChange={(kind) => devUpdates.simulate({ kind })} options={KIND_OPTIONS} />
          </div>
          <div className="dv-upd-versions">
            <label className="dv-field">
              <span className="label">Phiên bản đang chạy</span>
              <input
                className={`input mono${currentOk ? '' : ' dv-upd-bad'}`}
                value={draft.current}
                maxLength={64}
                spellCheck={false}
                aria-invalid={!currentOk}
                onChange={(e) => devUpdates.setDraft({ current: e.target.value })}
              />
            </label>
            <label className="dv-field">
              <span className="label">Phiên bản mới</span>
              <input
                className={`input mono${versionOk ? '' : ' dv-upd-bad'}`}
                value={draft.version}
                maxLength={64}
                spellCheck={false}
                aria-invalid={!versionOk}
                onChange={(e) => devUpdates.setDraft({ version: e.target.value })}
              />
            </label>
          </div>
          {(!currentOk || !versionOk) && <p className="dv-hint dv-upd-warn">Phiên bản phải có dạng 1.2.3 (có thể thêm hậu tố như 1.2.3-beta.1).</p>}
          <label className="dv-field">
            <span className="label">Ghi chú phát hành</span>
            <textarea className="textarea mono dv-upd-notes" rows={6} value={draft.notes} spellCheck={false} onChange={(e) => devUpdates.setDraft({ notes: e.target.value })} />
          </label>
          <label className="dv-field">
            <span className="label">Lần kiểm tra tới</span>
            <select className="select" value={nextCheck} onChange={(e) => devUpdates.setNextCheck(e.target.value as DevNextCheck)}>
              {NEXT_CHECKS.map((o) => (
                <option key={o} value={o}>
                  {DEV_NEXT_CHECK_LABEL[o]}
                </option>
              ))}
            </select>
          </label>
          <p className="dv-hint">Dùng khi bấm “Kiểm tra ngay” (Cài đặt → Cập nhật) hoặc “Thử lại” trong hộp thoại cập nhật.</p>
        </UpdCard>

        <UpdCard title="Đặt trạng thái" icon={<CloudDownload size={15} />}>
          <div className="dv-actions">
            <button type="button" className="btn btn-sm" onClick={() => devUpdates.announce()}>
              Có bản mới
            </button>
            <button type="button" className="btn btn-sm" onClick={() => devUpdates.runDownload()}>
              Đang tải
            </button>
            <button type="button" className="btn btn-sm" onClick={() => devUpdates.markReady()}>
              Đã tải xong
            </button>
            <button type="button" className="btn btn-sm" onClick={() => devUpdates.failNetwork()}>
              Lỗi mạng
            </button>
            <button
              type="button"
              className="btn btn-sm"
              title="Bản cập nhật tải về không có chữ ký số của tác giả nên bị bỏ"
              onClick={() => devUpdates.failSignature()}
            >
              Lỗi chữ ký số
            </button>
            <button
              type="button"
              className="btn btn-sm"
              title="Không kiểm tra được chữ ký số của bản cập nhật (máy chặn hoặc quá lâu): chưa cài, “Thử lại” kiểm tra lại"
              onClick={() => devUpdates.failSignature('signature-unverified')}
            >
              Chưa kiểm tra được chữ ký
            </button>
            <button type="button" className="btn btn-sm" onClick={() => devUpdates.markNone()}>
              Không có bản mới
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => devUpdates.reset()}>
              <RotateCcw size={13} /> Về trạng thái đầu
            </button>
          </div>
          <p className="dv-hint">
            “Có bản mới” làm như lần kiểm tra vừa thấy bản mới: bản cài đang bật “Tự động tải bản cập nhật” sẽ tự tải ngay. Bản phát triển được đổi sang bản cài trước khi đặt
            trạng thái.
          </p>
          <div className="dv-field">
            <h4 className="dv-upd-heading">Trạng thái hiện tại</h4>
            <pre className="dv-json dv-upd-state">{JSON.stringify(state, null, 2)}</pre>
          </div>
        </UpdCard>

        <UpdCard title="Chữ ký số (Giới thiệu)" icon={<ShieldCheck size={15} />} wide>
          <div className="dv-field">
            <span className="label">Kết quả tự kiểm tra chữ ký số</span>
            <Segmented<DevSignaturePreset> label="Kết quả tự kiểm tra chữ ký số" value={sigPreset} onChange={(p) => devSignature.simulate(p)} options={DEV_SIGNATURE_OPTIONS} />
          </div>
          <p className="dv-hint">
            Trạng thái mà Cài đặt → Giới thiệu hiển thị. Bản desktop tự kiểm tra chữ ký số của file SanoVids.exe khi mở; ở đây chỉ giả lập, không kiểm tra gì.
          </p>
        </UpdCard>
      </div>
    </div>
  )
}
