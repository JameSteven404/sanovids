/**
 * The seedvis.com provider is switched on for users (plan §17.6: wave C flips it, and only once track B2 — the engine's
 * per-scene provider, the adapter and the desktop gateway — has merged: before that store/runs would hand a seedvis
 * scene to the canvasapp queue). While false this build behaves exactly as before seedvis: the seedvis routes exist in
 * the catalogue (core/models CATALOGUE, the ModelId union, every Record over it) but are never offered or run — migrate
 * keeps a scene / preset / take on a seedvis id as a newer build's model / provider (blocked, parked), as it always did.
 *
 * Before flipping it, every run gate must judge a scene by its own provider (providers/index providerForModel), not by
 * activeProviderId(): store/runs check() / enqueue (settingsBlock, B2), components/runs/shared useSettingsRunBlock and
 * useSceneRunBlock (B3) and the useActiveLimits callers (plan §17.5 caller table) — else a Veo 8 s scene is judged by
 * canvasapp's Seedance profile and blocked.
 *
 * Read it through core/models (MODELS, isModelId, PICKER_ORDER… and the SEEDVIS_ENABLED re-export), never directly.
 * Its own module so a test can run the build that ships seedvis:
 *   vi.mock('<path>/core/seedvisFlag', () => ({ SEEDVIS_ENABLED: true }))
 */
export const SEEDVIS_ENABLED: boolean = false
