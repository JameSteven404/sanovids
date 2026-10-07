// Invariants of the stress tester. Each returns Violations (empty = holds). Ids (used in reports):
//   P1 scene order dense 1..n, unique scene / asset ids        P2 refs: no duplicates, every ref exists
//   P3 character sync: after a structural change every @image_N still names the SAME picture (or became text)
//   P4 first / last frames name existing assets                 P5 video refs without duplicates (dangling allowed)
//   P6 folder nodes: wired scenes exist, never a real path      T1 take ids unique (numbers per scene: warning)
//   T3 no take may run on the real canvasapp                    X1 structural changes never lose prompt text
//   X2 legacy @video tokens unchanged (warning until "Đợt V")   H1 undo → redo gives the same project
//   H2 undo history ≤ 200                                       C1 a job's pictures = the take's @image order
//   C2 a job prompt never names a picture it does not send      $1 one job (one charge) per take
//   E1 ≤ MAX_REMOTE_CONCURRENCY running at once                 E2 the queue drains once faults are gone
//   D1 a saved project reads back the same                      D2 migrate never throws and is idempotent
//   R1 no console.error / unhandled error                       S1–S3 guards (sandbox / session)
import { imageKey, imageSlotsFor, parseTokens, TOKEN_RE } from '../../core/compile'
import { dropVideoRefs, migrateProject } from '../../core/migrate'
import { MODELS, usesRefs } from '../../core/models'
import type { Asset, Project, Scene, Take } from '../../core/types'
import { clientRequestIdFor } from '../../providers/canvasapp/mapping'
import type { DevServerSnapshot } from '../../providers/dev'
import { useProject } from '../../store/project'
import { MAX_REMOTE_CONCURRENCY, requestImages } from '../../store/runs'
import type { Violation } from './types'

const err = (invariant: string, message: string, detail?: unknown, kind: Violation['kind'] = 'app'): Violation => ({ invariant, severity: 'error', message, kind, detail })
const warn = (invariant: string, message: string, detail?: unknown, kind: Violation['kind'] = 'app'): Violation => ({ invariant, severity: 'warning', message, kind, detail })

const short = (s: string, n = 80) => (s.length > n ? s.slice(0, n) + '…' : s)

// ---------------------------------------------------------------------------------------------
// Project shape (P1, P2, P4, P5, P6, T1)
// ---------------------------------------------------------------------------------------------

export function checkProject(p: Project, takes: readonly Take[]): Violation[] {
  const out: Violation[] = []
  const assetIds = new Set<string>()
  for (const a of p.assets) {
    if (assetIds.has(a.id)) out.push(err('P1', `Trùng id nhân vật/bối cảnh ${a.id}.`))
    assetIds.add(a.id)
  }
  const sceneIds = new Set<string>()
  const orders = p.scenes.map((s) => s.order).sort((a, b) => a - b)
  for (let i = 0; i < orders.length; i++) {
    if (orders[i] !== i + 1) {
      out.push(err('P1', `Thứ tự cảnh không liền mạch: vị trí ${i + 1} có số ${orders[i]}.`, { orders: orders.slice(Math.max(0, i - 3), i + 3) }))
      break
    }
  }
  for (const s of p.scenes) {
    if (sceneIds.has(s.id)) out.push(err('P1', `Trùng id cảnh ${s.id}.`))
    sceneIds.add(s.id)
    if (new Set(s.refs).size !== s.refs.length) out.push(err('P2', `Cảnh S${s.order}: một nhân vật được nối hai lần.`, { refs: s.refs }))
    const missing = s.refs.filter((r) => !assetIds.has(r))
    if (missing.length) out.push(err('P2', `Cảnh S${s.order}: dây nối tới nhân vật đã xoá (${missing.length}).`, { missing }))
    for (const which of ['firstFrame', 'lastFrame'] as const) {
      const f = s[which]
      if (f !== null && !assetIds.has(f)) out.push(err('P4', `Cảnh S${s.order}: ${which === 'firstFrame' ? 'khung đầu' : 'khung cuối'} trỏ tới nhân vật đã xoá.`, { assetId: f }))
    }
    if (new Set(s.videoRefs).size !== s.videoRefs.length) out.push(err('P5', `Cảnh S${s.order}: một video tham chiếu bị nối hai lần.`, { videoRefs: s.videoRefs }))
    if (typeof s.prompt !== 'string') out.push(err('P1', `Cảnh S${s.order}: prompt không phải chuỗi.`))
  }
  for (const f of p.folders ?? []) {
    if (f.path !== null) out.push(err('P6', `Thư mục “${short(f.name)}” trỏ tới một thư mục thật (${short(String(f.path))}).`, undefined, 'harness'))
    const gone = (f.autoScenes ?? []).filter((id) => !sceneIds.has(id))
    if (gone.length) out.push(warn('P6', `Thư mục “${short(f.name)}” còn dây tới ${gone.length} cảnh đã xoá.`, { gone }))
  }
  const takeIds = new Set<string>()
  const numbers = new Set<string>()
  for (const t of takes) {
    if (takeIds.has(t.id)) out.push(err('T1', `Trùng id take ${t.id}.`))
    takeIds.add(t.id)
    const key = `${t.sceneId}#${t.number}`
    if (numbers.has(key)) out.push(warn('T1', `Hai take cùng số T${t.number} trong một cảnh.`, { sceneId: t.sceneId }))
    numbers.add(key)
  }
  for (const f of p.folders ?? []) {
    const gone = (f.takes ?? []).filter((id) => !takeIds.has(id))
    if (gone.length) out.push(warn('P6', `Thư mục “${short(f.name)}” còn dây tới ${gone.length} video đã xoá.`, { gone }))
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Structural changes (P3 character sync, X1 text kept)
// ---------------------------------------------------------------------------------------------

/** Image keys named by the in-range @image_N tokens of a prompt, in text order. */
export function tokenKeys(prompt: string, assets: Asset[], refs: string[]): { keys: string[]; slots: Set<string> } {
  const slots = imageSlotsFor(assets, refs).map(imageKey)
  const keys: string[] = []
  for (const t of parseTokens(prompt)) if (t.kind === 'image' && t.n >= 1 && t.n <= slots.length) keys.push(slots[t.n - 1])
  return { keys, slots: new Set(slots) }
}

const stripTokens = (s: string) => s.replace(TOKEN_RE, '')

/** `a` is a subsequence of `b` (code units). */
export function isSubsequence(a: string, b: string): boolean {
  if (a.length > b.length) return false
  let j = 0
  for (let i = 0; i < b.length && j < a.length; i++) if (b.charCodeAt(i) === a.charCodeAt(j)) j++
  return j === a.length
}

/**
 * After a change of references / pictures / scenes (not a prompt edit): for every scene that still exists and changed,
 *  P3 the pictures its tokens name are the same, in the same order (a token may only drop out, as text; a token may
 *     newly name a picture that was not in the scene before — typed ahead, then linked);
 *  X1 no prompt text was lost (the text without tokens before is kept, in order, in the text after).
 */
export function checkStructural(before: Project, after: Project, label: string, strictVideo = false): Violation[] {
  if (before === after) return []
  if (!before.settings.autoRenumber || !after.settings.autoRenumber) return []
  const out: Violation[] = []
  const prev = new Map(before.scenes.map((s) => [s.id, s]))
  for (const s of after.scenes) {
    const b = prev.get(s.id)
    if (!b || b === s) continue
    if (b.prompt === s.prompt && b.refs === s.refs && before.assets === after.assets) continue
    if (b.prompt !== s.prompt) {
      // X2: @video tokens (legacy data) stay byte for byte — until "Đợt V" a removed take / video ref rewrites them.
      const vb = videoTokens(b.prompt)
      const va = videoTokens(s.prompt)
      if (vb.length !== va.length || vb.some((t, i) => t !== va[i])) {
        out.push((strictVideo ? err : warn)('X2', `Token @video của S${s.order} bị đổi sau “${label}” (${vb.join(' ') || 'không có'} → ${va.join(' ') || 'không còn'}).`, { before: vb, after: va }))
      }
    }
    const kb = tokenKeys(b.prompt, before.assets, b.refs)
    const ka = tokenKeys(s.prompt, after.assets, s.refs)
    let j = 0
    for (const key of ka.keys) {
      if (!kb.slots.has(key)) continue // a picture new to this scene
      while (j < kb.keys.length && kb.keys[j] !== key) j++
      if (j >= kb.keys.length) {
        out.push(err('P3', `Lệch nhân vật ở S${s.order} sau “${label}”: một @image_N giờ trỏ sang ảnh khác.`, { before: short(b.prompt, 300), after: short(s.prompt, 300), beforeKeys: kb.keys, afterKeys: ka.keys }))
        break
      }
      j++
    }
    if (b.prompt !== s.prompt && !isSubsequence(stripTokens(b.prompt), stripTokens(s.prompt))) {
      out.push(err('X1', `Mất chữ trong prompt S${s.order} sau “${label}”.`, { before: short(b.prompt, 300), after: short(s.prompt, 300) }))
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Legacy video tokens (X2, see checkStructural)
// ---------------------------------------------------------------------------------------------

/** @video_N / @video_?N tokens of a prompt, in order (legacy data until "Đợt V"). */
export const videoTokens = (prompt: string): string[] => prompt.match(/@video_\??\d+/gi) ?? []

/** How many scenes still carry @video tokens (report note). */
export const scenesWithVideoTokens = (p: Project) => p.scenes.filter((s) => videoTokens(s.prompt).length).length

// ---------------------------------------------------------------------------------------------
// History (H1, H2)
// ---------------------------------------------------------------------------------------------

/** JSON of a project without the save time (undo puts back old `updatedAt`s). */
export const projectKey = (p: Project) => JSON.stringify({ ...p, updatedAt: 0 })

export function checkHistorySize(): Violation[] {
  const n = useProject.temporal.getState().pastStates.length
  return n > 200 ? [err('H2', `Lịch sử hoàn tác vượt 200 bước (${n}).`)] : []
}

// ---------------------------------------------------------------------------------------------
// Jobs at the simulated canvasapp (C1, C2, $1, T3) and the engine (E1)
// ---------------------------------------------------------------------------------------------

/** Remembers the jobs already checked (the server forgets old ones past 200). */
export class JobAudit {
  private seen = new Map<string, string>() // job id → client_request_id
  private perKey = new Map<string, number>()
  jobs = 0

  audit(snap: DevServerSnapshot, takes: readonly Take[], assets: Asset[], dedupe: boolean): Violation[] {
    const out: Violation[] = []
    const byKey = new Map<string, Take>()
    for (const t of takes) byKey.set(clientRequestIdFor(t.id), t)
    const uploadImage = new Map(snap.uploads.map((u) => [u.upload_id, u.imageId]))
    for (const job of snap.jobs) {
      if (this.seen.has(job.job_id)) continue
      this.seen.set(job.job_id, job.client_request_id)
      this.jobs++
      const count = (this.perKey.get(job.client_request_id) ?? 0) + 1
      this.perKey.set(job.client_request_id, count)
      const take = byKey.get(job.client_request_id)
      if (count > 1) {
        out.push((dedupe ? warn : err)('$1', `Một take bị tạo ${count} job (trả tiền ${count} lần)${take ? ` — take ${take.id}` : ''}.`, { key: job.client_request_id }))
      }
      if (!take) continue // deleted since: nothing to compare with
      if (take.provider === 'canvasapp') out.push(err('T3', 'Một take chạy trên canvasapp thật trong lúc thử nghiệm.', { takeId: take.id }))
      // C2: every @image_N of the prompt sent has a picture in the request.
      const sent = job.upload_ids.length
      const named = parseTokens(job.prompt).filter((t) => t.kind === 'image')
      const over = named.filter((t) => t.n > sent)
      if (over.length) out.push(err('C2', `Job gửi prompt nhắc @image_${over[0].n} nhưng chỉ gửi ${sent} ảnh (nhân vật trỏ vào khoảng trống).`, { prompt: short(job.prompt, 300), sent }))
      // C1: pictures sent = the take's @image order.
      if (usesRefs(take.settings)) {
        const spec = MODELS[take.settings.model] ?? MODELS.seedance_2_5
        const expected = requestImages(take, assets, spec.maxRefImages).map((i) => i.imageId)
        const got = job.upload_ids.map((u) => uploadImage.get(u))
        if (got.every((g) => g !== undefined && g !== null)) {
          const same = expected.length === got.length && expected.every((id, i) => (got[i] ?? '') === id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60))
          if (!same) out.push(err('C1', `Ảnh gửi đi không đúng thứ tự @image của take (lệch nhân vật).`, { takeId: take.id, expected, got }))
        }
      }
      if (job.prompt !== take.promptSnapshot.trim()) out.push(err('C1', 'Prompt gửi đi khác prompt đã chụp khi xếp hàng.', { takeId: take.id, sent: short(job.prompt, 200), snapshot: short(take.promptSnapshot, 200) }))
    }
    return out
  }
}

export function checkEngine(takes: readonly Take[]): Violation[] {
  const running = takes.filter((t) => t.status === 'processing' && (t.provider === 'dev' || t.provider === 'canvasapp')).length
  const out: Violation[] = []
  if (running > MAX_REMOTE_CONCURRENCY) out.push(err('E1', `${running} take chạy cùng lúc (giới hạn ${MAX_REMOTE_CONCURRENCY}).`))
  if (takes.some((t) => t.provider === 'canvasapp' && (t.status === 'queued' || t.status === 'processing'))) out.push(err('T3', 'Có take xếp hàng trên canvasapp thật.'))
  return out
}

// ---------------------------------------------------------------------------------------------
// Data round trips (D1, D2)
// ---------------------------------------------------------------------------------------------

/** First path where two JSON values differ (for the report). */
export function firstDiff(a: unknown, b: unknown, path = ''): string | null {
  if (a === b) return null
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return path || '(gốc)'
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)])
  for (const k of keys) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`)
    if (d) return d
  }
  return null
}

/**
 * D1: the project as saved (JSON) and read back (migrateProject) is the same project; as exported / imported (video
 * references dropped, like importedProject) it keeps every scene, picture and reference.
 */
export function checkRoundTrip(p: Project): Violation[] {
  const out: Violation[] = []
  let back: Project
  try {
    back = migrateProject(JSON.parse(JSON.stringify(p)))
  } catch (e) {
    return [err('D1', `Đọc lại dự án đã lưu bị lỗi: ${(e as Error).message}`)]
  }
  const a = JSON.parse(JSON.stringify(p))
  const b = JSON.parse(JSON.stringify(back))
  const d = firstDiff(a, b)
  if (d) out.push(warn('D1', `Dự án đọc lại khác bản đang mở ở ${d}.`, { path: d }))
  const imported = dropVideoRefs(back)
  if (imported.scenes.length !== p.scenes.length || imported.assets.length !== p.assets.length) {
    out.push(err('D1', `Xuất/nhập làm mất cảnh hoặc nhân vật (${p.scenes.length}→${imported.scenes.length} cảnh).`))
  }
  for (let i = 0; i < imported.scenes.length; i++) {
    const s = imported.scenes[i]
    const o = p.scenes[i]
    if (o && s.refs.join() !== o.refs.join()) {
      out.push(err('D1', `Xuất/nhập đổi dây nối ảnh của S${o.order}.`))
      break
    }
  }
  return out
}

/** D2: migrateProject on any input never throws, gives a valid project, and migrating twice changes nothing. */
export function checkMigrate(raw: unknown): Violation[] {
  let once: Project
  try {
    once = migrateProject(raw)
  } catch (e) {
    return [err('D2', `Đọc dữ liệu hỏng làm migrate bị lỗi: ${(e as Error).message}`, { raw: short(safeJson(raw), 400) })]
  }
  const out = checkProject(once, []).map((v): Violation => ({ ...v, severity: 'warning', invariant: 'D2', message: 'Sau migrate dữ liệu hỏng: ' + v.message }))
  try {
    const twice = migrateProject(JSON.parse(JSON.stringify(once)))
    const d = firstDiff(JSON.parse(JSON.stringify(once)), JSON.parse(JSON.stringify(twice)))
    if (d) out.push(err('D2', `migrate hai lần cho kết quả khác ở ${d}.`, { path: d }))
  } catch (e) {
    out.push(err('D2', `migrate lần hai bị lỗi: ${(e as Error).message}`))
  }
  return out
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

/** Scenes of a project ordered like the UI (by `order`). */
export const ordered = (p: Project): Scene[] => [...p.scenes].sort((a, b) => a.order - b.order)
