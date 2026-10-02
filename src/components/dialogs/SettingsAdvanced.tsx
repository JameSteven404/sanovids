// Settings → "Nâng cao": motion & toasts, file names & .zip, side-panel layout, backup / restore of the settings,
// the demo provider and the demo wallet (the canvasapp gateway is GatewaySection.tsx).
import { Braces, FileDown, FileUp, FlaskConical, LayoutPanelLeft, Plus, RotateCcw, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { DEFAULT_NAME_TEMPLATE, checkNameTemplate, nameDate, nameTime, NAME_TOKENS, renderNameTemplate, type NameValues } from '../../core/nameTemplate'
import { MOTION_LABEL, MOTION_LEVELS, systemReducedMotion, useCanvasPrefs, useMotionLevel, type MotionLevel } from '../../lib/canvasPrefs'
import { DEMO_CREDIT_HINT, DEMO_CREDITS_DEFAULT, formatCreditNumber, formatCredits } from '../../lib/credits'
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
import { MAX_MOCK_FAIL_RATE, MAX_MOCK_CONCURRENCY } from '../../providers/mock'
import { useProject } from '../../store/project'
import { useRuns, type MockSpeed } from '../../store/runs'
import { TOAST_BASE_MS, TOAST_SCALE, TOAST_TIME_LABEL, TOAST_TIMES, toast, useUI } from '../../store/ui'
import { resetPanelLayout, restorePanelLayout } from '../common/PanelResizer'
import { useActiveProvider } from '../runs/shared'
import { LOW_CREDITS } from '../topbar/creditPillModel'
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
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    change(value.slice(0, start) + text + value.slice(end))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + text.length, start + text.length)
    })
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
          onBlur={() => {
            // A valid text goes back to following the saved template (trimmed); an invalid one stays with its error.
            if (checkNameTemplate(draft).ok) setDraft(null)
          }}
        />
      </div>
      <div className="dg-tokens" role="group" aria-label="Chèn mã vào mẫu tên">
        {NAME_TOKENS.map((t) => (
          <button key={t.id} type="button" className="dg-token mono" onClick={() => insert(t.id)} title={`${t.label} — ví dụ “${t.example}”. Bấm để chèn.`}>
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
            <b>Đặt mọi cài đặt trên máy này về mặc định?</b> Giao diện, tải video, âm thanh, dây nối, chuyển động, thông báo, tên file, nhà cung cấp giả lập; nhà cung cấp
            video về {PROVIDER_LABEL.mock}; khung bên về như mới; các mẹo hiện lại. Dự án, video, thư mục đã chọn và đăng nhập canvasapp giữ nguyên.
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

// ---------------- Nhà cung cấp giả lập ----------------
const SPEEDS: { id: MockSpeed; label: string; hint: string }[] = [
  { id: 'fast', label: 'Nhanh', hint: '3–6 giây / video' },
  { id: 'normal', label: 'Vừa', hint: '9–16 giây / video' },
  { id: 'slow', label: 'Chậm', hint: '22–38 giây / video' },
]

/** Shown on top of the demo provider group when new takes go to canvasapp. */
export function MockIntro() {
  const provider = useActiveProvider()
  if (provider === 'mock') return null
  return <div className="dg-field-hint">Take mới đang dùng {PROVIDER_LABEL[provider]} — các cài đặt dưới đây chỉ áp dụng khi chọn {PROVIDER_LABEL.mock}.</div>
}

export function MockSpeedSetting({ label, hint }: RowProps) {
  const speed = useRuns((s) => s.mock.speed)
  const setMock = useRuns((s) => s.setMock)
  return (
    <Field label={label} hint={hint}>
      <Segmented label={label} value={speed} onChange={(v) => setMock({ speed: v })} options={SPEEDS.map((s) => ({ id: s.id, label: s.label, hint: s.hint, title: s.hint }))} />
    </Field>
  )
}

export function MockFailSetting({ label, hint }: RowProps) {
  const failRate = useRuns((s) => s.mock.failRate)
  const setMock = useRuns((s) => s.setMock)
  const id = useId()
  const pct = Math.round(failRate * 100)
  return (
    <Field label={label} labelId={id} hint={hint} value={<span className="dg-value mono">{pct}%</span>}>
      <input
        className="dg-range"
        type="range"
        min={0}
        max={Math.round(MAX_MOCK_FAIL_RATE * 100)}
        step={5}
        value={pct}
        aria-labelledby={id}
        aria-valuetext={`${pct}%`}
        onChange={(e) => setMock({ failRate: Number(e.target.value) / 100 })}
      />
    </Field>
  )
}

export function MockConcurrencySetting({ label, hint }: RowProps) {
  const concurrency = useRuns((s) => s.mock.concurrency)
  const setMock = useRuns((s) => s.setMock)
  return (
    <Field label={label} hint={hint} value={<span className="dg-value mono">{concurrency}</span>}>
      <Segmented
        label={label}
        value={concurrency}
        onChange={(v) => setMock({ concurrency: v })}
        options={Array.from({ length: MAX_MOCK_CONCURRENCY }, (_, i) => i + 1).map((n) => ({ id: n, label: String(n) }))}
      />
    </Field>
  )
}

export function MockRecordSetting({ label, hint }: RowProps) {
  const recordVideo = useRuns((s) => s.mock.recordVideo)
  const setMock = useRuns((s) => s.setMock)
  return <Toggle checked={recordVideo} onChange={(v) => setMock({ recordVideo: v })} label={label} hint={hint} />
}

// ---------------- Credit demo (block) ----------------
/** "+100" demo credits (play money; the run dialog offers the same amount when the demo balance is short). */
const DEMO_TOPUP = 100

/** The local demo wallet (store/runs): play money spent only by the demo provider. Real credits: GatewaySection. */
export function CreditBlock() {
  const credits = useRuns((s) => s.credits)
  const spent = useRuns((s) => s.spent)
  const addCredits = useRuns((s) => s.addCredits)
  const resetDemoCredits = useRuns((s) => s.resetDemoCredits)
  const atDefault = credits === DEMO_CREDITS_DEFAULT && spent === 0
  return (
    <Section
      title="Credit demo"
      badge={<span className="badge dg-demo-badge">giả lập</span>}
      desc={`${DEMO_CREDIT_HINT}. Chỉ ${PROVIDER_LABEL.mock} dùng credit này; take tạo trên ${PROVIDER_LABEL.canvasapp} trừ credit thật trong tài khoản canvasapp của bạn (xem mục Cổng canvasapp).`}
    >
      <div className="dg-credit demo" title={DEMO_CREDIT_HINT}>
        <div className="dg-credit-num">
          <FlaskConical size={18} />
          <span>Credit demo:</span>
          <b className={credits < LOW_CREDITS ? 'low' : undefined}>{formatCreditNumber(credits)}</b>
        </div>
        <div className="dg-credit-spent faint">Đã dùng {formatCredits(spent, 'demo')}</div>
        <div className="dg-credit-actions">
          <button
            className="btn"
            onClick={() => {
              addCredits(DEMO_TOPUP)
              toast(`Đã thêm ${formatCredits(DEMO_TOPUP, 'demo')} (giả lập, không phải tiền thật).`, { tone: 'success' })
            }}
            title={`Thêm ${formatCredits(DEMO_TOPUP, 'demo')} — giả lập, không phải tiền thật`}
          >
            <Plus size={14} /> {formatCreditNumber(DEMO_TOPUP)}
          </button>
          <button
            className="btn"
            disabled={atDefault}
            onClick={() => {
              resetDemoCredits()
              toast(`Đã đặt lại credit demo về ${formatCredits(DEMO_CREDITS_DEFAULT, 'demo')}.`, { tone: 'success' })
            }}
            title={`Đặt số dư credit demo về ${formatCreditNumber(DEMO_CREDITS_DEFAULT)} và xoá số đã dùng`}
          >
            <RotateCcw size={14} /> Đặt lại ({formatCreditNumber(DEMO_CREDITS_DEFAULT)})
          </button>
        </div>
      </div>
    </Section>
  )
}
