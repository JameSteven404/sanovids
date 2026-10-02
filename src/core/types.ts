// Domain model for "SanoVids" (schema v2).
// The project (assets, presets, scenes, positions) is undoable.
// Runs (takes + jobs) live in a separate store and are NOT part of undo history.
//
// v2: the prompt is exactly what the user writes. Media references are numbered tokens:
//   @image_N — N-th reference image of the scene (scene.refs order, each image of an asset gets its own number)
//   @video_N — N-th reference video of the scene (scene.videoRefs order, ids of completed takes)
// Tokens are renumbered automatically when references are reordered/removed (see core/compile.ts remapTokens).

export type ModelId = 'seedance_2_5' | 'minimax_h3'
export type Mode = 't2v' | 'i2v' | 'transform'
export type AssetKind = 'character' | 'location' | 'prop' | 'style'
export type EdgeMode = 'hidden' | 'selected' | 'all'
export type ViewMode = 'canvas' | 'table' | 'storyboard'

export interface XY {
  x: number
  y: number
}

/** Canvas node size set by the user (resize handle). Missing/null = default size. */
export interface Size {
  w: number
  h: number
}

/** A reusable reference: a character, a location, a prop... One asset can hold several images. */
export interface Asset {
  id: string
  kind: AssetKind
  name: string
  /** Short tag without "@", unique per project (search + legacy @Tag mentions). */
  tag: string
  description: string
  /** Keys into the media store (IndexedDB). First image is the primary one. */
  imageIds: string[]
  color: string
  /** Shown as a node on the canvas when set. Assets always exist in the library regardless. */
  position: XY | null
  /** Canvas node size (null/undefined = default). */
  size?: Size | null
}

export interface VideoSettings {
  model: ModelId
  mode: Mode
  duration: number
  resolution: string
  ratio: string
}

export interface Preset extends VideoSettings {
  id: string
  name: string
}

export interface Scene {
  id: string
  /** Display order, 1-based. S01, S02... Kept dense by the store. */
  order: number
  title: string
  /** The prompt exactly as it will be sent, with @image_N / @video_N tokens. */
  prompt: string
  /** Ordered asset ids used as reference images. Order decides @image_N numbering. */
  refs: string[]
  /** Ordered take ids (completed videos) used as reference videos. Order decides @video_N numbering. */
  videoRefs: string[]
  /** Preset the settings came from (informational; settings are copied, not linked). */
  presetId: string | null
  settings: VideoSettings
  /** H3 transform frames: asset ids for first and last frame. */
  firstFrame: string | null
  lastFrame: string | null
  color: string | null
  position: XY
  /** Canvas card size (null/undefined = default). */
  size?: Size | null
  note: string
}

export interface ProjectSettings {
  /** Rewrite @image_N / @video_N tokens when references are reordered or removed. */
  autoRenumber: boolean
}

/**
 * A folder on the user's computer shown as a "Thư mục" node on the canvas. Wires into it copy finished videos there:
 *   take  → folder ('save')     that video (+ its prompt .txt) is copied when wired, or as soon as it finishes;
 *   scene → folder ('autosave') every take of that scene that finishes from then on is copied there.
 * Files are never overwritten (" (2)" is added). The wires are project data (undoable); the files are not.
 */
export interface SaveFolder {
  id: string
  /** Shown on the node: the folder's own name. */
  name: string
  /**
   * Desktop app: absolute path of the folder. The main process only writes to folders the user picked on this
   * computer, so a path from another machine (imported project) asks to "Chọn lại thư mục". Web: null — the browser
   * keeps a folder handle per folder id (lib/saveFolders.ts), never a path.
   */
  path: string | null
  position: XY
  /** Canvas node size (null/undefined = default). */
  size?: Size | null
  /** What a wire into the folder does. Only 'copy' for now (the video stays in SanoVids too). */
  mode: 'copy'
  /** Scenes wired in ('autosave'): each of their takes that completes from then on is saved here. */
  autoScenes?: string[]
  /** Takes wired in ('save'): copied when wired, or when they finish. */
  takes?: string[]
}

export interface Project {
  id: string
  name: string
  schemaVersion: 2
  createdAt: number
  updatedAt: number
  assets: Asset[]
  presets: Preset[]
  scenes: Scene[]
  settings: ProjectSettings
  /** "Thư mục" nodes (missing in projects made before folders existed = none). */
  folders?: SaveFolder[]
}

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'

/** One generation attempt of a scene. Shown as a Take (video) node on the canvas. */
export interface Take {
  id: string
  sceneId: string
  /** 1-based number within the scene: T1, T2... */
  number: number
  status: JobStatus
  progress: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  /** Exact compiled prompt that was sent. */
  promptSnapshot: string
  /** Scene prompt at the time of the run, for "restore prompt". */
  rawPromptSnapshot: string
  refsSnapshot: string[]
  videoRefsSnapshot: string[]
  settings: VideoSettings
  cost: number
  starred: boolean
  /** Media-store key of the poster frame. */
  posterId: string | null
  /** Media-store key of the (demo) video. */
  videoId: string | null
  error: string | null
  /** Canvas position once the user dragged the node; null = auto (to the right of its scene). */
  position: XY | null
  /** Canvas node size (null/undefined = default). */
  size?: Size | null
  /**
   * File name the user gave the video, without extension (sanitized, see core/fileNames cleanTakeFileName). Every save
   * uses it (download, zip, auto-download, folder nodes). Missing = the default "S01_T1 - <scene title>".
   */
  fileName?: string
  // ---- provider fields (optional: takes saved before providers existed have none; migrateTake fills them) ----
  /** Video provider that runs this take. Missing = 'mock' (the old demo). */
  provider?: TakeProvider
  /** Job id at the provider once submitted — lets the engine resume polling after a reload. Null = not submitted. */
  remoteId?: string | null
  /**
   * A remote submit whose outcome is unknown (answer lost: maybe created and billed at the provider). Kept through
   * retries and cancel until a job id is stored; such a take is only re-sent as itself (same key), never as a new take.
   */
  submitUnknown?: boolean
  /** Cost was taken from the local (demo) credit counter → refunded on failure/cancel. Missing = true. */
  charged?: boolean
  /**
   * H3 transform frames at enqueue time: "assetId:imageId" (the exact picture sent), or a bare asset id for takes of
   * older versions. Missing = read from the scene when submitting.
   */
  framesSnapshot?: { first: string | null; last: string | null }
  /**
   * Image keys (`assetId:imageId`, see core/compile imageKey) of the scene's references at enqueue time, in
   * @image_N order — the full list, before the model's image cap. Lets "restore prompt" renumber exactly.
   */
  imageKeysSnapshot?: string[]
}

/**
 * Provider that runs a take (same ids as providers/types ProviderId):
 *   'dev'        development mode — an in-app simulation of canvasapp.io.vn (no network, fake credits);
 *   'canvasapp'  the real canvasapp.io.vn gateway (desktop only, real credits);
 *   'mock'       the old demo provider ("Demo cũ"): only takes saved before development mode existed.
 */
export type TakeProvider = 'mock' | 'canvasapp' | 'dev'

export interface CompiledImage {
  /** 1-based N in @image_N */
  n: number
  assetId: string
  imageId: string
}

export interface CompiledVideo {
  /** 1-based N in @video_N */
  n: number
  takeId: string
}

export interface CompiledPrompt {
  text: string
  images: CompiledImage[]
  videos: CompiledVideo[]
  /** Assets in reference order (only those that send at least one image). */
  assetIds: string[]
  charCount: number
  limit: number
  /** Problems that likely produce a wrong video. */
  warnings: string[]
  /** Low-priority hints (e.g. a connected image never mentioned in the prompt). */
  notes: string[]
  /**
   * Tokens of the compiled prompt that have NO media behind them in this request (beyond the images/videos actually
   * sent, in a mode that sends none, or unbound "@image_?N" placeholders). A take with any of these must not run.
   */
  unsentTokens: string[]
}
