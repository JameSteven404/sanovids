// Domain model for "Bàn Dựng Phim".
// The project (assets, blocks, presets, scenes, positions) is undoable.
// Runs (takes + jobs) live in a separate store and are NOT part of undo history.

export type ModelId = 'seedance_2_5' | 'minimax_h3'
export type Mode = 't2v' | 'i2v' | 'transform'
export type AssetKind = 'character' | 'location' | 'prop' | 'style'
export type BlockPlacement = 'before' | 'after'
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
  /** Mention tag without "@", unique per project, e.g. "Elara" -> typed as @Elara in prompts. */
  tag: string
  description: string
  /** Keys into the image store (IndexedDB). First image is the primary one. */
  imageIds: string[]
  color: string
  /** Shown as a node on the canvas when set. Assets always exist in the library regardless. */
  position: XY | null
}

/** Reusable prompt paragraph (style bible). Applied to every scene unless the scene overrides it. */
export interface PromptBlock {
  id: string
  title: string
  text: string
  placement: BlockPlacement
  /** Default on/off for scenes that have no override. */
  defaultOn: boolean
  color: string
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
  /** Scene-specific prompt. May contain @Tag mentions (asset tags). */
  prompt: string
  /** Ordered asset ids used as reference images. Order decides @image_N numbering. */
  refs: string[]
  /** Per-scene override of block on/off. Missing key = use block.defaultOn. */
  blockOverrides: Record<string, boolean>
  /** Preset the settings came from (informational; settings are copied, not linked). */
  presetId: string | null
  settings: VideoSettings
  /** Previous scene this one continues from (story sequence edge). */
  continueFrom: string | null
  /** H3 transform frames: asset ids for first and last frame. */
  firstFrame: string | null
  lastFrame: string | null
  color: string | null
  position: XY
  note: string
}

export interface ProjectSettings {
  /** Template for the auto-generated references paragraph. Tokens: {list} */
  referencesTemplate: string
  /** Whether to add the auto references paragraph at all. */
  autoReferences: boolean
  /** Add "Continue from the previous scene (Sxx: title)." line when continueFrom is set. */
  autoContinuity: boolean
}

export interface Project {
  id: string
  name: string
  schemaVersion: 1
  createdAt: number
  updatedAt: number
  assets: Asset[]
  blocks: PromptBlock[]
  presets: Preset[]
  scenes: Scene[]
  settings: ProjectSettings
}

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'

/** One generation attempt of a scene. */
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
  /** Scene prompt (raw, with @Tags) at the time of the run, for "restore prompt". */
  rawPromptSnapshot: string
  refsSnapshot: string[]
  settings: VideoSettings
  cost: number
  starred: boolean
  /** Image-store key of the poster frame. */
  posterId: string | null
  /** Image-store key of a short demo video (webm) when the mock could record one. */
  videoId: string | null
  error: string | null
}

export interface CompiledImage {
  /** 1-based N in @image_N */
  n: number
  assetId: string
  imageId: string
}

export interface CompiledPrompt {
  text: string
  images: CompiledImage[]
  /** Assets in reference order. */
  assetIds: string[]
  charCount: number
  limit: number
  warnings: string[]
}
