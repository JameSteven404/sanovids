// Domain model for "Bàn Dựng Phim" (schema v2).
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
  note: string
}

export interface ProjectSettings {
  /** Rewrite @image_N / @video_N tokens when references are reordered or removed. */
  autoRenumber: boolean
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
}

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
}
