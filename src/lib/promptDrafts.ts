// Prompt drafts that are not in the store yet. A prompt editor keeps what is typed in local state and commits it a
// moment later (components/inspector/PromptEditor: 160 ms throttle). Every mounted editor registers its flush here,
// per scene — several editors may show the same scene (the inspector, and from 0.6.0 the editor on a scene card).
// Anything that changes a scene's structure (link / unlink media, cut a wire, run) calls flushScenes(ids) first, so
// the text being typed is committed — and renumbered with the change — instead of being overwritten by it.
// No React; a flush never throws out of here.

export type DraftFlush = () => void

const registry = new Map<string, Set<DraftFlush>>()
/** Flushes running right now: a flush that leads to another flush of the same editor does not run it twice. */
const running = new Set<DraftFlush>()

/** Register the flush of a mounted editor of `sceneId`. Returns its unregister function. */
export function register(sceneId: string, flush: DraftFlush): () => void {
  let set = registry.get(sceneId)
  if (!set) {
    set = new Set()
    registry.set(sceneId, set)
  }
  set.add(flush)
  return () => unregister(sceneId, flush)
}

/** Forget one flush (the other editors of the scene stay registered). */
export function unregister(sceneId: string, flush: DraftFlush): void {
  const set = registry.get(sceneId)
  if (!set) return
  set.delete(flush)
  if (!set.size) registry.delete(sceneId)
}

function runFlush(sceneId: string, flush: DraftFlush): void {
  // Taken from a snapshot: an editor unmounted by an earlier flush is not called any more.
  if (running.has(flush) || !registry.get(sceneId)?.has(flush)) return
  running.add(flush)
  try {
    flush()
  } catch (e) {
    // One broken editor must not stop the structural change (or the other editors' commits).
    console.error('[SanoVids] prompt draft flush failed', e)
  } finally {
    running.delete(flush)
  }
}

/** Commit the drafts of these scenes (every editor of each; no-op for a scene without one). */
export function flushScenes(sceneIds: Iterable<string>): void {
  for (const id of new Set(sceneIds)) {
    const set = registry.get(id)
    if (set) for (const flush of [...set]) runFlush(id, flush)
  }
}

/** Commit every draft (before an app update restarts the app, before a save). */
export function flushAll(): void {
  for (const [id, set] of [...registry]) for (const flush of [...set]) runFlush(id, flush)
}

/** Number of editors registered for a scene (tests, diagnostics). */
export function draftCount(sceneId: string): number {
  return registry.get(sceneId)?.size ?? 0
}
