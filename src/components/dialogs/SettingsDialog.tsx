import { Coins, Download, FileUp, RotateCcw, Sparkles, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_REFERENCES_TEMPLATE } from '../../core/compile'
import { createDemo, exportProjectFile, importProjectFile } from '../../store/persist'
import { useProject } from '../../store/project'
import { useRuns, type MockSpeed } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { Modal } from '../common/Modal'
import './dialogs.css'

const SPEEDS: { id: MockSpeed; label: string; hint: string }[] = [
  { id: 'fast', label: 'Nhanh', hint: '3–6 giây / video' },
  { id: 'normal', label: 'Vừa', hint: '9–16 giây / video' },
  { id: 'slow', label: 'Chậm', hint: '22–38 giây / video' },
]

const SAMPLE_LIST = '@image_1 = Elara (young woman, auburn braid); @image_2 = Làng núi'

export function SettingsDialog() {
  const closeDialog = useUI((s) => s.closeDialog)
  return (
    <Modal title="Cài đặt" onClose={closeDialog} size="wide" footer={<button className="btn btn-primary" onClick={closeDialog}>Xong</button>}>
      <div className="dg-settings">
        <div className="dg-settings-col">
          <PromptSettings />
          <DataSettings onDone={closeDialog} />
        </div>
        <div className="dg-settings-col">
          <MockSettings />
          <CreditSettings />
        </div>
      </div>
    </Modal>
  )
}

function Section({ title, desc, children, badge }: { title: string; desc?: ReactNode; children: ReactNode; badge?: ReactNode }) {
  return (
    <section className="dg-section">
      <header>
        <h3>
          {title}
          {badge}
        </h3>
        {desc && <p>{desc}</p>}
      </header>
      {children}
    </section>
  )
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="dg-toggle-row">
      <span className="dg-toggle-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      <span className={`dg-switch ${checked ? 'on' : ''}`}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <i />
      </span>
    </label>
  )
}

// ---------------------------------------------------------------------------------------------

function PromptSettings() {
  const settings = useProject((s) => s.project.settings)
  const update = useProject((s) => s.updateProjectSettings)
  const [tpl, setTpl] = useState(settings.referencesTemplate)
  const tplRef = useRef(tpl)
  tplRef.current = tpl
  const projectId = useRef(useProject.getState().project.id)

  // Template edits are committed on blur / close (one undo step instead of one per key).
  // Skipped if another project was opened meanwhile (import / new demo from this dialog).
  const commit = () => {
    const { project } = useProject.getState()
    if (project.id !== projectId.current) return
    if (tplRef.current !== project.settings.referencesTemplate) useProject.getState().updateProjectSettings({ referencesTemplate: tplRef.current })
  }
  useEffect(() => () => commit(), [])

  const missingToken = !tpl.includes('{list}')
  const preview = (tpl || DEFAULT_REFERENCES_TEMPLATE).replace('{list}', SAMPLE_LIST)

  return (
    <Section title="Prompt cuối" desc="Những phần được tự động thêm khi biên dịch prompt của mỗi cảnh.">
      <Toggle
        checked={settings.autoReferences}
        onChange={(v) => update({ autoReferences: v })}
        label="Tự thêm đoạn References"
        hint="Liệt kê @image_N = tên (mô tả) theo đúng thứ tự ảnh được nối."
      />
      <Toggle
        checked={settings.autoContinuity}
        onChange={(v) => update({ autoContinuity: v })}
        label="Tự thêm câu nối tiếp cảnh trước"
        hint="“Continue directly from the previous scene (S03: …)” khi cảnh có Tiếp nối từ."
      />
      <div className={`dg-field ${settings.autoReferences ? '' : 'disabled'}`}>
        <div className="dg-label-row">
          <span className="label">Mẫu đoạn References</span>
          <button
            className="btn btn-ghost btn-sm"
            disabled={tpl === DEFAULT_REFERENCES_TEMPLATE}
            onClick={() => {
              setTpl(DEFAULT_REFERENCES_TEMPLATE)
              tplRef.current = DEFAULT_REFERENCES_TEMPLATE
              commit()
            }}
          >
            <RotateCcw size={12} /> Mặc định
          </button>
        </div>
        <textarea className="textarea dg-tpl" rows={3} value={tpl} onChange={(e) => setTpl(e.target.value)} onBlur={commit} spellCheck={false} />
        <div className="dg-field-hint">
          <code>{'{list}'}</code> được thay bằng danh sách ảnh tham chiếu.
          {missingToken && (
            <span className="dg-warn-inline">
              <TriangleAlert size={12} /> Thiếu <code>{'{list}'}</code> — danh sách sẽ không xuất hiện.
            </span>
          )}
        </div>
        <div className="dg-tpl-preview">
          <span className="label">Ví dụ</span>
          <p>{preview}</p>
        </div>
      </div>
    </Section>
  )
}

function MockSettings() {
  const mock = useRuns((s) => s.mock)
  const setMock = useRuns((s) => s.setMock)
  return (
    <Section title="Nhà cung cấp giả lập" badge={<span className="badge accent">demo</span>} desc="Không gọi mạng, không tốn tiền. Dùng để thử hàng đợi, lỗi và take.">
      <div className="dg-field">
        <span className="label">Tốc độ tạo video</span>
        <div className="dg-seg dg-seg-full">
          {SPEEDS.map((s) => (
            <button key={s.id} className={mock.speed === s.id ? 'active' : ''} onClick={() => setMock({ speed: s.id })} title={s.hint}>
              {s.label}
              <small>{s.hint}</small>
            </button>
          ))}
        </div>
      </div>
      <div className="dg-field">
        <div className="dg-label-row">
          <span className="label">Tỉ lệ lỗi giả</span>
          <span className="dg-value mono">{Math.round(mock.failRate * 100)}%</span>
        </div>
        <input
          className="dg-range"
          type="range"
          min={0}
          max={50}
          step={5}
          value={Math.round(mock.failRate * 100)}
          onChange={(e) => setMock({ failRate: Number(e.target.value) / 100 })}
        />
        <div className="dg-field-hint">Job lỗi được hoàn credit, giống nhà cung cấp thật.</div>
      </div>
      <div className="dg-field">
        <div className="dg-label-row">
          <span className="label">Số job chạy cùng lúc</span>
          <span className="dg-value mono">{mock.concurrency}</span>
        </div>
        <div className="dg-seg dg-seg-full">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} className={mock.concurrency === n ? 'active' : ''} onClick={() => setMock({ concurrency: n })}>
              {n}
            </button>
          ))}
        </div>
      </div>
      <Toggle
        checked={mock.recordVideo}
        onChange={(v) => setMock({ recordVideo: v })}
        label="Ghi video webm giả"
        hint="Tạo đoạn video 3 giây cho mỗi take. Tắt nếu máy chậm — khi đó chỉ có poster."
      />
    </Section>
  )
}

function CreditSettings() {
  const credits = useRuns((s) => s.credits)
  const spent = useRuns((s) => s.spent)
  const addCredits = useRuns((s) => s.addCredits)
  return (
    <Section title="Credit demo">
      <div className="dg-credit">
        <div className="dg-credit-num">
          <Coins size={18} />
          <b>{credits.toLocaleString('vi-VN')}</b>
          <span>credit còn lại</span>
        </div>
        <div className="dg-credit-spent faint">Đã dùng {spent.toLocaleString('vi-VN')} credit</div>
        <button
          className="btn"
          onClick={() => {
            addCredits(100)
            toast('Đã nạp +100 credit demo.', { tone: 'success' })
          }}
        >
          +100 credit demo
        </button>
      </div>
    </Section>
  )
}

function DataSettings({ onDone }: { onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<null | 'export' | 'import' | 'demo'>(null)

  const run = async (kind: 'export' | 'import' | 'demo', fn: () => Promise<void>, ok: string, close = false) => {
    setBusy(kind)
    try {
      await fn()
      toast(ok, { tone: 'success' })
      if (close) onDone()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Có lỗi xảy ra.', { tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section title="Dữ liệu" desc="Dự án được lưu tự động trong trình duyệt này (ảnh và video trong IndexedDB). Xuất file để sao lưu hoặc chuyển máy.">
      <div className="dg-data-actions">
        <button className="btn" disabled={!!busy} onClick={() => run('export', exportProjectFile, 'Đã xuất dự án (.bdp.json).')}>
          <Download size={14} /> {busy === 'export' ? 'Đang xuất…' : 'Xuất dự án'}
        </button>
        <button className="btn" disabled={!!busy} onClick={() => fileRef.current?.click()}>
          <FileUp size={14} /> {busy === 'import' ? 'Đang nhập…' : 'Nhập file .bdp.json'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void run('import', () => importProjectFile(f), `Đã mở dự án từ “${f.name}”.`, true)
          }}
        />
        <button className="btn" disabled={!!busy} onClick={() => run('demo', createDemo, 'Đã tạo dự án demo mới.', true)}>
          <Sparkles size={14} /> {busy === 'demo' ? 'Đang tạo…' : 'Tạo lại dự án demo'}
        </button>
      </div>
      <div className="dg-field-hint">“Tạo lại dự án demo” mở một dự án demo mới; dự án hiện tại vẫn nằm trong danh sách Dự án.</div>
    </Section>
  )
}
