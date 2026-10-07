// seedvis.com provider — public surface of src/providers/seedvis (plan §7.1).
//
// TODO(integration, track B2): add `seedvisProviderFor(id: 'seedvis' | 'seedvis-dev')` here, building
// createSeedvisProvider with
//   - bridge: seedvisBridge() for 'seedvis'; the A-SIM simulated bridge (providers/dev/seedvis/bridge.ts) for
//     'seedvis-dev', only while devAllowed();
//   - words: the real / simulated variants of wording.ts (A-MAP), adapted to SeedvisAdapterWords;
//   - prepare: mapping.toGenerationBody + prepareImages (A-MAP), reusing `input.prep` copies byte for byte;
//   - echo: mapping.echoCheck; limitsFromModels: mapping.limitsFromModels (check its isJobNotFound agrees with
//     api.isJsonJobNotFound, or switch this adapter to it);
//   - keyStatus: store/seedvisKey; storage (REQUIRED, the money ledger): browserStorage (the ledger key follows the id;
//     memoryStorage only for the stress sandbox);
//   - releasePrep: lib/imageStore delete; onSubmitNote: runs.ts patch of Take.remoteNote.
// and register it in providers/index.ts getProvider().
// TODO(integration, B2 engine):
//   - submitTake passes `isGone: () => same project && !findTake(id)` beside isCancelled (orphans only for a take that
//     is really gone, §6.4 b); the engine still cancels / polls a take that was merely cancelled or lost its scene;
//   - fetchResult 'deferred' + `held` (isResultHeld): wait for the sending key (resumeProviderPolling), not for `online`;
//   - fetchResult 'expired-link' without `definitive`: a counted try (the take ends `fetchable`), never the expiry text;
//   - sameKeyRetry 'key-changed' (safeUntil null): no immediate dispatch, the unverifiable confirm text.
// TODO(main, A1): main could also refuse a same-key create whose saved key tag differs from the record's (the adapter
//   reads the key status right before each POST; a swap in the few ms before main sends it is not covered here).
export {
  ACCOUNT_TTL_MS,
  bodySignature,
  createSeedvisProvider,
  DEFAULT_CONCURRENCY,
  EXPIRED_LINK_MIN_AGE_MS,
  MAX_CONCURRENCY,
  MIN_POLL_MS,
  seedvisIdempotencyKey,
  type SeedvisAdapterDeps,
  type SeedvisAdapterWords,
  type SeedvisPrepareInput,
  type SeedvisPrepared,
  type SeedvisProvider,
} from './adapter'
export { createSeedvisApi, isJsonJobNotFound, parseAccountInfo, parseApiError, parseGeneration, SEEDVIS_ID_RE, type SeedvisApi, type SeedvisApiErrorInfo, type SeedvisGeneration } from './api'
export { classifyCreate, isSeedvisError, SeedvisError, type CreateClass, type SeedvisErrorCode } from './errors'
export { createSeedvisLedger, memoryStorage, parseLedger, SEEDVIS_DEV_LEDGER_KEY, SEEDVIS_LEDGER_KEY, type KeyValueStorage, type LedgerData, type SeedvisLedger } from './ledger'
export { failureNotSent, hasSeedvisBridge, seedvisBridge } from './transport'
export { DEFER_BIG_BODY_BYTES, deferDelayMs, estUploadMs, KEY_MEMORY_FROM, resendSchedule, sameKeyDeadline, sameKeyGate, type GateVerdict, type KeyMemoryFrom } from './window'
export {
  isResultExpired,
  isResultHeld,
  type CancelOutcome,
  type RemoteStatusExt,
  type SameKeyRetry,
  type SeedvisJobRequest,
  type SeedvisProviderId,
  type SeedvisSubmitOptions,
} from './contractExt'
