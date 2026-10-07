// "Nhập job" (reverse sync, docs/GATEWAY-CANVASAPP.md §4): jobs the user made on canvasapp's own page — "Tạo video" on a
// node of the "SanoVids bridge" session — become takes of the open project. Read-only toward canvasapp (GET only),
// never billed, never re-submittable: an imported take is born `processing` with its remote id (store/runs
// importTakes) and "Chạy lại" on it makes a NEW take through the cost dialog (actions.rerunTake).
// Steps: scanForImport (adapter scanSiteJobs: list + saved canvas) → the user ticks jobs (ImportJobsDialog) →
// importSiteJobs (GET …/prompt of each, reconstructSiteJob, then importTakes claims them in the adapter's ledger,
// synchronously, with the project pinned). Everything goes through the adapter that runs the takes
// (providers gatewayProvider: the registry's instance), in development mode the simulated site.
//
// ---- API for the UI ----
//   openImportJobs({ back?, provider? }) open the dialog (`back`: the dialog to show again when it closes; `provider`:
//                                      the gateway to read — default the one new takes use).
//   scanForImport(provider?): Promise<ImportScan>
//   importSiteJobs(scan, jobIds)       → ImportTakesResult | null (null: an import is already running); toasts the
//                                      outcome with "Bỏ nhập" (dropImported).
//   dropImported(takeIds, words)       delete the takes just imported (asks only when one is used as @video).
import { deleteTakes, takeLabel } from './actions'
import { sceneCode } from './core/compile'
import { importToastText, importWords, dropToastText, type ImportWords } from './components/runs/importJobsModel'
import { activeGateway, gatewayFor, gatewayProvider, providerOf, type Gateway } from './providers'
import { canvasNodeId, decodeRemoteId, sceneNodeId } from './providers/canvasapp/mapping'
import { MAX_IMPORT_BATCH, reconstructSiteJob, type SiteJobScan } from './providers/canvasapp/siteJobs'
import { useProject } from './store/project'
import { useRuns, type ImportTakesResult } from './store/runs'
import { toast, useUI, type DialogState } from './store/ui'

/** One scan, for the project and the gateway it was made for. */
export interface ImportScan {
  pid: 'dev' | 'canvasapp'
  simulated: boolean
  /** The SanoVids project the scan was made for (importSiteJobs imports nothing into another one). */
  projectId: string
  scan: SiteJobScan
}

export function openImportJobs(opts: { back?: DialogState; provider?: 'dev' | 'canvasapp' } = {}): void {
  const { back, provider } = opts
  useUI.getState().openDialog({
    kind: 'importJobs',
    ...(back && back.kind !== 'none' && back.kind !== 'importJobs' ? { back } : {}),
    ...(provider ? { provider } : {}),
  })
}

/** The gateway "Nhập job" reads: `provider`'s, else the one new takes use. */
export const importGateway = (provider?: 'dev' | 'canvasapp'): Gateway => (provider ? gatewayFor(provider)! : activeGateway())

/** The jobs of a gateway's bridge session (default: the active one), sorted against the open project. Throws like the adapter (401…). */
export async function scanForImport(provider?: 'dev' | 'canvasapp'): Promise<ImportScan> {
  const gw = importGateway(provider)
  const project = useProject.getState().project
  const sceneByNode = new Map<string, string>()
  // a scene's node of this project, and the one older builds named by the scene id alone
  for (const s of project.scenes) sceneByNode.set(canvasNodeId(s.id), s.id)
  for (const s of project.scenes) sceneByNode.set(sceneNodeId(project.id, s.id), s.id)
  const takes = useRuns.getState().takes
  const takeJobIds = new Set<string>()
  for (const t of takes) {
    const id = t.remoteId && providerOf(t) === gw.id ? decodeRemoteId(t.remoteId)?.jobId : undefined
    if (id) takeJobIds.add(id)
  }
  const scan = await gatewayProvider(gw.id).scanSiteJobs({
    sceneByNode,
    sceneOrder: new Map(project.scenes.map((s) => [s.id, s.order])),
    takeJobIds,
    takeIds: new Set(takes.map((t) => t.id)),
  })
  return { pid: gw.id, simulated: gw.simulated, projectId: project.id, scan }
}

let importing = false

/**
 * Import the ticked jobs (at most MAX_IMPORT_BATCH): their prompts are read one by one, then the takes are made and
 * claimed in ONE synchronous step — nothing at all when another project was opened meanwhile. A 401 while reading
 * the prompts imports nothing (thrown). Says the outcome in a toast ("Bỏ nhập" undoes it).
 */
export async function importSiteJobs(s: ImportScan, jobIds: readonly string[]): Promise<ImportTakesResult | null> {
  if (importing) return null
  importing = true
  try {
    const wanted = new Set(jobIds)
    const picked = s.scan.candidates.filter((c) => wanted.has(c.jobId)).slice(0, MAX_IMPORT_BATCH)
    const w = importWords(s.simulated)
    const tell = (res: ImportTakesResult) => {
      const project = useProject.getState().project
      const codes = res.takeIds.map((id) => {
        const t = useRuns.getState().takes.find((x) => x.id === id)
        const scene = t ? project.scenes.find((x) => x.id === t.sceneId) : undefined
        return scene ? sceneCode(scene.order) : 'S??'
      })
      const said = importToastText(res, codes, w)
      toast(said.text, {
        tone: said.ok ? (res.skipped.length ? 'warning' : 'success') : 'warning',
        ...(res.takeIds.length ? { action: { label: 'Bỏ nhập', run: () => dropImported(res.takeIds, w) } } : {}),
      })
      return res
    }
    if (useProject.getState().project.id !== s.projectId) return tell({ takeIds: [], skipped: picked.map((c) => ({ jobId: c.jobId, code: 'project-changed' })) })
    if (!picked.length) return tell({ takeIds: [], skipped: [] })
    const provider = gatewayProvider(s.pid)
    const prompts = await provider.siteJobPrompts(picked.map((c) => c.jobId))
    const project = useProject.getState().project
    const drafts = picked.map((c) => {
      const scene = project.scenes.find((x) => x.id === c.sceneId)
      // a picture → the asset holding it: one of the scene's references first, else any asset of the project
      const assetOf = (imageId: string): string | null => {
        const holders = project.assets.filter((a) => a.imageIds.includes(imageId))
        return (holders.find((a) => scene?.refs.includes(a.id)) ?? holders[0])?.id ?? null
      }
      return reconstructSiteJob(c, prompts[c.jobId] ?? null, assetOf)
    })
    return tell(useRuns.getState().importTakes({ projectId: s.projectId, provider: s.pid, drafts, claim: (claims) => provider.claimSiteJobs(claims) }))
  } finally {
    importing = false
  }
}

/** "Bỏ nhập": delete the takes just imported (the jobs stay on the site; a later scan offers them again, unticked). */
export function dropImported(takeIds: readonly string[], w: ImportWords): void {
  const live = new Set(useRuns.getState().takes.map((t) => t.id))
  const ids = takeIds.filter((id) => live.has(id))
  if (!ids.length) return
  // the toast button is the confirmation: ask only when another scene uses one of them as @video
  const n = deleteTakes(ids, { confirm: 'usedOnly', toast: false })
  if (n === null || !n) return
  toast(dropToastText(n, w), { tone: 'success' })
}

/** "S03·T2" of a take of the open project, null when it is not one (deleted, or another project). */
export function pendingTakeLabel(takeId: string): string | null {
  return useRuns.getState().takes.some((t) => t.id === takeId) ? takeLabel(takeId) : null
}
