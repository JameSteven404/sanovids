// Settings → "Nâng cao": motion & toasts, file names & .zip, side-panel layout, backup / restore of the settings,
// the development mode summary (the canvasapp gateway is GatewaySection.tsx).
import { Braces, Bug, FileDown, FileUp, LayoutPanelLeft, RotateCcw, ScrollText, TriangleAlert, Zap } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FocusEvent } from 'react'
import { DEFAULT_NAME_TEMPLATE, checkNameTemplate, nameDate, nameTime, NAME_TOKENS, renderNameTemplate, type NameValues } from '../../core/nameTemplate'
import { MOTION_LABEL, MOTION_LEVELS, systemReducedMotion, useCanvasPrefs, useMotionLevel, type MotionLevel } from '../../lib/canvasPrefs'
import { openDevPanel } from '../../actions'
import { formatCredits } from '../../lib/credits'
import { browserDownload, canSaveAs, saveFilesAs, useDownloadPrefs } from '../../lib/downloads'
import {
  applySettings,
  backupSettings,
  readSettingsFile,
  resetAllSettings,
  restoreSettings,
  settingsFileText,
  SETTINGS_FILE_NAME,
} from '../../lib/settings'
import { PROVIDER_LABEL } from '../../providers'
import { DEV_SPEED_LABEL, devServer, startDevSnapshotTicker, useDevServer, type DevSpeed } from '../../providers/dev'
import { useProject } from '../../store/project'
import { TOAST_BASE_MS, TOAST_SCALE, TOAST_TIME_LABEL, TOAST_TIMES, toast, useUI } from '../../store/ui'
import { resetPanelLayout, restorePanelLayout } from '../common/PanelResizer'
import { useActiveProvider } from '../runs/shared'
import { activeFaultCount } from '../dev/devModel'
import './dialogs.css'
import { Segmented } from './Segmented'
import { Field, Section, Toggle, useSettingsCtx, type RowProps } from './settingsUi'
import { errorText } from './shared'

// ---------------- Chuyển động & thông báo ----------------
const MOTION_HINT: Record<MotionLevel, string> = {
  full: 'Dây trượt, thẻ lướt',
  reduced: 'Chỉ mờ dần',
  off: 'Không hiệu ứng',
}

export function MotionSetting({ label, hint }: RowProps) {
  const pref = useCanvasPrefs((s) => s.animations)
  const set = useCanvasPrefs((s) => s.set)
  const effective = useMotionLevel()
  const osNote = pref === 'full' && effective === 'reduced' && systemReducedMotion() ? ' Máy đang bật “Giảm chuyển động” nên app dùng mức Giảm bớt.' : ''
  return (
    <Field label={label} hint={`${hint ?? ''}${osNote}`}>
      <Segmented
        label={label}
        value={pref}
        onChange={(animations) => set({ animations })}
        options={MOTION_LEVELS.map((m) => ({ id: m, label: MOTION_LABEL[m], hint: MOTION_HINT[m] }))}
      />
    </Field>
  )
}

const seconds = (scale: number) => Math.max(1, Math.round((TOAST_BASE_MS * scale) / 1000))

export function ToastTimeSetting({ label, hint }: RowProps) {
  const toastTime = useUI((s) => s.toastTime)
  const setToastTime = useUI((s) => s.setToastTime)
  return (
    <Field
      label={label}
      hint={hint}
      value={
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => toast(`Thông báo mẫu — hiện khoảng ${seconds(TOAST_SCALE[useUI.getState().toastTime])} giây.`)}
          title="Hiện một thông báo mẫu với thời gian đang chọn"
        >
          Xem thử
        </button>
      }
    >
      <Segmented
        label={label}
        value={toastTime}
        onChange={setToastTime}
        options={TOAST_TIMES.map((t) => ({ id: t, label: TOAST_TIME_LABEL[t], hint: `≈ ${seconds(TOAST_SCALE[t])} giây` }))}
      />
    </Field>
  )
}

// ---------------- Tên file & file .zip ----------------
/** Example values for the preview (a fixed scene; today's date). */
function sampleValues(project: string): NameValues {
  const now = Date.now()
  return { scene: 'S03', take: 'T2', title: 'Ánh sáng trong hang', project, date: nameDate(now), time: nameTime(now), model: 'Seedance 2.5' }
}

/**
 * "Cách đặt tên file": the template of the default video name. A valid edit is saved at once (every later save uses
 * it); an invalid one shows why and is not saved. Chips insert a token at the caret.
 */
export function NameTemplateSetting({ label, hint }: RowProps) {
  const saved = useDownloadPrefs((s) => s.nameTemplate)
  const set = useDownloadPrefs((s) => s.set)
  const projectName = useProject((s) => s.project.name)
  const { epoch } = useSettingsCtx()
  // No draft = showing the saved template; a draft = what is being typed. A reset / import (new epoch) drops it.
  const [typed, setTyped] = useState<{ epoch: number; text: string } | null>(null)
  const draft = typed && typed.epoch === epoch ? typed.text : null
  const setDraft = (text: string | null) => setTyped(text === null ? null : { epoch, text })
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const value = draft ?? saved
  const check = checkNameTemplate(value)
  const used = check.ok ? check.template : saved

  const change = (next: string) => {
    setDraft(next)
    const c = checkNameTemplate(next)
    if (c.ok && c.template !== useDownloadPrefs.getState().nameTemplate) set({ nameTemplate: c.template })
  }
  const insert = (token: string) => {
    const el = inputRef.current
    const text = `{${token}}`
    // The field's own text (a separator just typed at the end is not trimmed away), with its caret.
    const cur = el ? el.value : value
    const start = Math.min(el?.selectionStart ?? cur.length, cur.length)
    const end = Math.min(el?.selectionEnd ?? cur.length, cur.length)
    change(cur.slice(0, start) + text + cur.slice(end))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + text.length, start + text.length)
    })
  }
  /**
   * Leaving the field (or a chip): a valid text goes back to following the saved template (trimmed); an invalid one
   * stays with its error. Moving between the field and its chips keeps the draft as typed (" - " before a chip).
   */
  const onLeave = (e: FocusEvent<HTMLElement>) => {
    const to = e.relatedTarget
    if (to instanceof Element && (to === inputRef.current || to.closest('.dg-name-tpl .dg-token'))) return
    if (checkNameTemplate(draft).ok) setDraft(null)
  }

  const sample = sampleValues(projectName || 'Phim ngắn')
  const example = renderNameTemplate(used, sample) || 'S03_T2'
  const exampleNoTitle = renderNameTemplate(used, { ...sample, title: '' }) || 'S03_T2'
  const isDefault = used === DEFAULT_NAME_TEMPLATE && check.ok

  return (
    <div className="dg-field dg-name-tpl">
      <div className="dg-label-row">
        <label className="label" htmlFor={id}>
          {label}
        </label>
        {(!isDefault || !check.ok) && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setDraft(null)
              set({ nameTemplate: DEFAULT_NAME_TEMPLATE })
            }}
            title={`Về mẫu mặc định ${DEFAULT_NAME_TEMPLATE}`}
          >
            <RotateCcw size={12} /> Mặc định
          </button>
        )}
      </div>
      <div className="dg-name-input">
        <Braces size={14} aria-hidden />
        <input
          ref={inputRef}
          id={id}
          className="input mono"
          value={value}
          spellCheck={false}
          autoComplete="off"
          maxLength={200}
          aria-invalid={!check.ok}
          aria-describedby={`${id}-help ${id}-msg`}
          onChange={(e) => change(e.target.value)}
          onBlur={onLeave}
        />
      </div>
      <div className="dg-tokens" role="group" aria-label="Chèn mã vào mẫu tên">
        {NAME_TOKENS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="dg-token mono"
            // A mouse press keeps the focus (and the caret) in the field: the chip inserts where the caret is.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(t.id)}
            onBlur={onLeave}
            title={`${t.label} — ví dụ “${t.example}”. Bấm để chèn.`}
          >
            {`{${t.id}}`}
          </button>
        ))}
      </div>
      <div id={`${id}-msg`} aria-live="polite">
        {!check.ok ? (
          <div className="dg-field-error">
            <TriangleAlert size={13} />
            <span>
              {check.error} Đang dùng: <span className="mono">{saved}</span>
            </span>
          </div>
        ) : check.warning ? (
          <div className="dg-field-warn">
            <TriangleAlert size={13} />
            <span>{check.warning}</span>
          </div>
        ) : null}
      </div>
      <div className="dg-name-preview" id={`${id}-help`}>
        <span className="faint">Ví dụ:</span> <b className="mono">{example}.mp4</b>
        {exampleNoTitle !== example && (
          <>
            <span className="faint"> · cảnh chưa có tên:</span> <span className="mono">{exampleNoTitle}.mp4</span>
          </>
        )}
      </div>
      {hint && <div className="dg-field-hint">{hint}</div>}
    </div>
  )
}

export function ZipPromptsSetting({ label, hint }: RowProps) {
  const zipPrompts = useDownloadPrefs((s) => s.zipPrompts)
  const set = useDownloadPrefs((s) => s.set)
  return <Toggle checked={zipPrompts} onChange={(v) => set({ zipPrompts: v })} label={label} hint={hint} />
}

// ---------------- Bố cục ----------------
export function ResetLayoutSetting({ label, hint }: RowProps) {
  return (
    <div className="dg-action-row">
      <span className="dg-toggle-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          const before = resetPanelLayout()
          toast('Đã đặt lại bố cục khung bên.', { tone: 'success', action: { label: 'Hoàn tác', run: () => restorePanelLayout(before) } })
        }}
      >
        <LayoutPanelLeft size={13} /> Đặt lại
      </button>
    </div>
  )
}

// ---------------- Sao lưu & khôi phục ----------------
/** Settings files are tiny: anything bigger is not one (and is not read into memory). */
const MAX_SETTINGS_FILE = 256 * 1024

export function BackupSetting({ label, hint }: RowProps) {
  const { resync } = useSettingsCtx()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const exportFile = async () => {
    if (busy) return
    setBusy(true)
    const file = { name: SETTINGS_FILE_NAME, data: settingsFileText() }
    try {
      if (useDownloadPrefs.getState().askWhere && canSaveAs()) {
        const res = await saveFilesAs([file], { title: 'Lưu file cài đặt' })
        if (res.to === 'canceled') return
        if (res.to === 'chosen') toast(`Đã xuất cài đặt${res.path ? ` → ${res.path}` : ` → “${res.names[0]}”`}.`, { tone: 'success', ms: 5000 })
        else toast(`Đã tải “${SETTINGS_FILE_NAME}” về thư mục Tải xuống.`, { tone: 'success' })
      } else {
        browserDownload(file)
        toast(`Đã tải “${SETTINGS_FILE_NAME}” về thư mục Tải xuống.`, { tone: 'success' })
      }
    } catch (e) {
      toast(`Không xuất được cài đặt: ${errorText(e)}`, { tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const importFile = async (f: File) => {
    if (f.size > MAX_SETTINGS_FILE) {
      toast('File này quá lớn, không phải file cài đặt SanoVids.', { tone: 'error' })
      return
    }
    let text: string
    try {
      text = await f.text()
    } catch (e) {
      toast(`Không đọc được file: ${errorText(e)}`, { tone: 'error' })
      return
    }
    const read = readSettingsFile(text)
    if (!read.ok) {
      toast(read.error, { tone: 'error' })
      return
    }
    const before = backupSettings()
    applySettings(read.patch)
    resync()
    const skipped = read.rejected.length ? ` (bỏ qua ${read.rejected.length} giá trị không hợp lệ)` : ''
    toast(`Đã nhập ${read.accepted} cài đặt từ “${f.name}”${skipped}.`, {
      tone: read.rejected.length ? 'warning' : 'success',
      action: {
        label: 'Hoàn tác',
        run: () => {
          restoreSettings(before)
          resync()
        },
      },
    })
  }

  return (
    <div className="dg-field">
      <span className="dg-toggle-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      <div className="dg-data-actions">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void exportFile()}>
          <FileDown size={13} /> Xuất cài đặt
        </button>
        <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}>
          <FileUp size={13} /> Nhập cài đặt…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void importFile(f)
          }}
        />
      </div>
    </div>
  )
}

/** "Khôi phục cài đặt mặc định" with an inline confirmation (Huỷ has the focus) and Hoàn tác afterwards. */
export function ResetAllSetting({ label, hint }: RowProps) {
  const { resync } = useSettingsCtx()
  const [confirm, setConfirm] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (confirm) cancelRef.current?.focus()
    else if (wasOpen.current) triggerRef.current?.focus()
    wasOpen.current = confirm
  }, [confirm])

  const reset = () => {
    const before = resetAllSettings()
    const layout = resetPanelLayout()
    resync()
    setConfirm(false)
    toast('Đã khôi phục cài đặt mặc định.', {
      tone: 'success',
      action: {
        label: 'Hoàn tác',
        run: () => {
          restoreSettings(before)
          restorePanelLayout(layout)
          resync()
        },
      },
    })
  }

  return (
    <div className="dg-field">
      <div className="dg-action-row">
        <span className="dg-toggle-text">
          <span>{label}</span>
          {hint && <small>{hint}</small>}
        </span>
        {!confirm && (
          <button ref={triggerRef} type="button" className="btn btn-sm btn-danger" onClick={() => setConfirm(true)}>
            <RotateCcw size={13} /> Khôi phục…
          </button>
        )}
      </div>
      {confirm && (
        <div className="dg-callout warn dg-confirm" role="group" aria-label="Xác nhận khôi phục cài đặt mặc định">
          <TriangleAlert size={15} />
          <div>
            <b>Đặt mọi cài đặt trên máy này về mặc định?</b> Giao diện, tải video, âm thanh, dây nối, chuyển động, thông báo, tên file, tự động tải bản cập nhật; nhà cung cấp
            video về {PROVIDER_LABEL.dev}; khung bên về như mới; các mẹo hiện lại. Dự án, video, thư mục đã chọn và đăng nhập canvasapp giữ nguyên.
          </div>
          <div className="dg-confirm-actions">
            <button ref={cancelRef} type="button" className="btn btn-sm" onClick={() => setConfirm(false)}>
              Huỷ
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={reset}>
              Khôi phục mặc định
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------- Chế độ Phát triển ----------------
/**
 * "Chế độ Phát triển": the simulated canvasapp of development mode at a glance (account, balance, armed faults) with
 * the settings used most; everything else is in "Bảng phát triển" (components/dev/DevPanel).
 */
export function DevBlock() {
  const provider = useActiveProvider()
  const snap = useDevServer((st) => st.snapshot)
  // Creates the simulated server if needed and keeps the numbers fresh while this dialog is open.
  useEffect(() => startDevSnapshotTicker(), [])
  const armed = activeFaultCount(snap)
  return (
    <Section
      title="Chế độ Phát triển"
      badge={<span className="badge dg-dev-badge">DEV</span>}
      desc="canvasapp.io.vn giả lập ngay trong SanoVids để tìm và sửa lỗi: cùng mã với chế độ thật, không gọi mạng, credit dev không phải tiền thật."
    >
      {provider !== 'dev' && (
        <div className="dg-field-hint">Take mới đang dùng {PROVIDER_LABEL[provider]} — các cài đặt dưới đây chỉ áp dụng khi chọn {PROVIDER_LABEL.dev}.</div>
      )}
      {snap && (
        <div className="dg-dev-summary">
          <span className={`dg-dev-dot${snap.authenticated ? ' on' : ''}`} aria-hidden="true" />
          <span>{snap.authenticated ? 'Đã đăng nhập tài khoản giả lập' : 'Chưa đăng nhập tài khoản giả lập'}</span>
          <span className="faint">·</span>
          <b className="mono">{formatCredits(snap.balance, 'dev')}</b>
          {armed > 0 && (
            <>
              <span className="faint">·</span>
              <button type="button" className="dg-dev-armed" onClick={() => openDevPanel('faults')}>
                <Zap size={12} /> {armed} lỗi giả đang bật
              </button>
            </>
          )}
        </div>
      )}
      {snap && (
        <div className="dg-field">
          <span className="label">Tốc độ tạo video giả lập</span>
          <Segmented<DevSpeed>
            label="Tốc độ tạo video giả lập"
            value={snap.config.speed}
            onChange={(speed) => devServer().setConfig({ speed })}
            options={(['fast', 'realistic'] as DevSpeed[]).map((id) => ({ id, label: DEV_SPEED_LABEL[id] }))}
          />
        </div>
      )}
      <div className="dg-data-actions">
        <button className="btn btn-primary" onClick={() => openDevPanel()}>
          <Bug size={14} /> Mở Bảng phát triển
        </button>
        <button className="btn" onClick={() => openDevPanel('faults')} title="Mất mạng, mất câu trả lời, hết credit, job lỗi…">
          <Zap size={14} /> Gây lỗi
        </button>
        <button className="btn" onClick={() => openDevPanel('log')} title="Mọi yêu cầu SanoVids gửi tới canvasapp giả lập và câu trả lời">
          <ScrollText size={14} /> Nhật ký yêu cầu
        </button>
      </div>
      <div className="dg-field-hint">Video giả dài 3 giây, ghi nhãn @image_N trên từng ảnh tham chiếu theo đúng thứ tự canvasapp nhận — nhìn là biết có đúng nhân vật không.</div>
    </Section>
  )
}
