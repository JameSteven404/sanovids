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
//   - keyStatus: store/seedvisKey; storage: browserStorage (the ledger key follows the id);
//   - releasePrep: lib/imageStore delete; onSubmitNote: runs.ts patch of Take.remoteNote.
// and register it in providers/index.ts getProvider().
export {
  ACCOUNT_TTL_MS,
  bodySignature,
  createSeedvisProvider,
  DEFAULT_CONCURRENCY,
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
export { DEFER_BIG_BODY_BYTES, deferDelayMs, estUploadMs, resendSchedule, sameKeyDeadline, sameKeyGate, type GateVerdict } from './window'
export { isResultExpired, type CancelOutcome, type RemoteStatusExt, type SameKeyRetry, type SeedvisJobRequest, type SeedvisProviderId } from './contractExt'
