// seedvis adapter end to end on the strict simulated seedvis (track A-SIM: providers/dev/seedvis/{server,bridge,
// validate,routes,state,faults,render}.ts) — plan §16.2 / §17.5 row A2: every §7 path and every fault of the §11.1
// catalogue, driven on the adapter directly (the engine runs come with B2's runs-engine / runs-mixed).
//
// SKIPPED until integration: A-SIM and A-MAP (mapping.ts, wording.ts, prepareImages.ts) are built in parallel as new
// files. TODO(integration):
//   - build the provider like index.ts seedvisProviderFor('seedvis-dev') will: createSeedvisProvider({ id: 'seedvis-dev',
//     bridge: the A-SIM bridge over a memory state, words: wording.ts (simulated variant), prepare: mapping
//     .toGenerationBody + prepareImages, echo: mapping.echoCheck, limitsFromModels: mapping.limitsFromModels,
//     now / sleep / monotonic: the sim clock, keyMemoryMs: 120_000 (the sim's key memory, plan §7.3),
//     storage: memoryStorage() });
//   - count jobs per Idempotency-Key on the sim server: "0 duplicate jobs" = no key with two jobs;
//   - replace each it.todo below with the test; keep the names (they are the acceptance list).
import { describe, it } from 'vitest'

describe.skip('seedvis-dev e2e — adapter on the A-SIM simulation (integration)', () => {
  describe('submit', () => {
    it.todo('Seedance 2.5 text-to-video: 202 queued → queued (position, estimated start) → processing → completed → video downloaded (badge "seedvis · DEV")')
    it.todo('Seedance 2.0 Fast image-to-video with 3 images: reference_images in @image_N order, the sim echo matches, no note')
    it.todo('Veo 3.1 all four modes: t2v / first (image) / i2v (referenceImages 1–3) / transform (image + lastFrame) — A-SIM validate accepts every body')
    it.todo('body is byte-identical before / after moveScene (scene-neutral file names): a same-key re-send is never answered 409')
    it.todo('202 then the job is created in the background: polls answer 404 for N polls after the 202, the take stays processing, then completes (M14, M22)')
    it.todo('lost answer after the job was created, key memory 120 s: the automatic +15 s re-send gets the same job (Idempotency-Replayed) — 0 duplicate jobs')
    it.todo('lost answer then 429 / 503 / 422 / 409 on the re-sends: uncertain, never deferred or refused (M6)')
    it.todo('2 Mbps upload, 8 MiB body, lost answer: re-sends only while the gate holds — 0 duplicate jobs (M5)')
    it.todo('30 MiB body at 2 Mbps, lost answer, explicit "Chạy lại" at 1:30: refused by the gate (unverifiable), no POST — 0 duplicate jobs (M5)')
    it.todo('upload slows to a quarter during the re-send: the sim bridge aborts at mustFinishBy (deadline, sent:false) → unverifiable — 0 duplicate jobs (M5)')
    it.todo('key forgotten after N s (sim memory shorter than the gate assumes): documents why SEEDVIS_KEY_MEMORY_MS stays null until seedvis confirms in writing')
    it.todo('SEEDVIS_KEY_MEMORY_MS = null (shipped): every lost answer is unverifiable at once — 0 same-key POSTs')
    it.todo('explicit retry in the window with the same prepared bytes: one same-key POST with mustFinishBy; with a changed body: unverifiable, no POST (M7)')
    it.todo('retryOfUnknown with a cleared ledger / a dropped key: unverifiable, no POST (M8)')
    it.todo('409 idempotency_conflict (same key, other body): uncertain, never a new key (M9)')
    it.todo('402 insufficient_credits sync → refused (remoteCode); 402 via poll after a 202 → failed, code insufficient_credits')
    it.todo('422 slots full → deferred, concurrency() lowered; "slots full for 10 min": bytes uploaded ≤ body × 8, every take sent once the slots free up (with B2 back-off, M29)')
    it.todo('429 + Retry-After → deferred with retryAfterMs; deferDelayMs honours it')
    it.todo('503 server_busy → deferred; 503 model_maintenance / 404 model_not_found → refused, /models read again')
    it.todo('JSON 502 / 504 generation_failed → gated same-key re-send')
    it.todo('content_policy sync (refused) and via poll (failed, no refund promise)')
    it.todo('invalid_image keyed reference_images[i] / referenceImages[i] / image / lastFrame → the slot named in the text')
    it.todo('the three error formats (native errors map, OpenAI error.param, Google error.status) parse to the same SeedvisApiErrorInfo')
    it.todo('cancel during the first upload → submit ends uncertain when the body was sent, cancelled when it was not')
    it.todo('another account\'s key pasted after a lost answer (DevPanel "another account\'s key"): "Chạy lại" sends nothing (uncertain, key-changed) — the sim scopes keys per account: 0 duplicate jobs; the original key back inside the window → the same job')
    it.todo('key swapped during the automatic +15 / +45 / +90 s re-sends → they stop, no POST under the other key (0 duplicate jobs)')
    it.todo('key status unreadable at the first POST, then a lost answer → unverifiable at once (key-unknown), never re-sent')
    it.todo('sim key memory counted from the request start (not the last byte): slow first upload, lost answer → no re-send fits, 0 duplicate jobs')
    it.todo('wall clock stepped back during the window: the gate uses the monotonic clock (no stretched window), mustFinishBy moved earlier by the step')
    it.todo('development mode locked after a lost answer → "Chạy lại" is uncertain / unverifiable, never a plain "unavailable" (M6)')
    it.todo('2xx with a numeric job id → the job; 2xx without any id → unverifiable, detail created-no-id, the shape logged without values')
    it.todo('a take deleted (gone) while its POST is in flight → orphan + awaited cancel; a take merely cancelled / its scene deleted → no orphan')
  })

  describe('poll', () => {
    it.todo('queue position + next.after_seconds pacing: ≤ 4 polls / min / job, ≤ 2 GETs in flight')
    it.todo('not_started after N minutes → failed, code not_started (not billed, M13)')
    it.todo('failed + cancelled → cancelled, code cancelled (refunded)')
    it.todo('HTML 404 (maintenance) for hours → never ends the take (M22)')
    it.todo('JSON generation_not_found forever → ends only after ≥ 3 answers over ≥ 30 min with the same key → failed not_found (M22)')
    it.todo('job of another key (DevPanel "another account\'s key") → held, never polled, never failed; re-pasting the key releases it (M23)')
    it.todo('401 / no key on a poll → login-required thrown, takes kept; 403 on every job → login-required; 403 on one job only → that take keeps running with a note, the others are polled')
    it.todo('a final answer with an unknown status ("succeeded") → the take keeps running (never failed, never remembered); a plain "cancelled" status → cancelled (refunded)')
  })

  describe('cancel', () => {
    it.todo('queued → refunded; processing → 409 not_cancellable → running; finished → finished')
    it.todo('409 + Retry-After: 2 → one retry; 503 cancel_unavailable → ≤ 3 retries then unknown; partial with running_outputs → running')
    it.todo('a 2xx cancel without evidence (empty body / no cancellation / a running job) → the job is read: refunded only when it shows failed + cancelled')
  })

  describe('downloads', () => {
    it.todo('expired CDN link → fresh GET → download; expired again on a job completed ≥ 24 h ago → definitive expired-link (isResultExpired)')
    it.todo('expired twice right after completion (CDN not replicated yet) → a plain, retried failure; the take stays fetchable (M27)')
    it.todo('a finished job of another key: fetchResult is held (deferred + held.keyHint), no request, until that key is back (M23)')
    it.todo('download failing N times → counted failures; failing while offline (even after bytes) or a network failure before any byte → deferred, not counted (M27)')
    it.todo('completed with empty outputs → one more round, then no-output')
    it.todo('application/octet-stream video → mime sniffed (video/mp4), never .webm')
    it.todo('CDN requests carry no Authorization / X-API-Key / x-goog-api-key (sim check, S8)')
    it.todo('short echo (fewer references than images sent) → note only, the job is kept (M19)')
  })

  describe('ledger and restart', () => {
    it.todo('restart with a remoteId → polling resumes; without → recover() reads the ledger only, never a POST (M4)')
    it.todo('the simulated ledger (bdp:dev:seedvis:ledger) never mixes with the real one; resetDevMode wipes it')
    it.todo('no request ever reaches real seedvis.com (stress trap registered as "seedvis", M21)')
  })
})
