// Part 4 of 4 of the seeded fault-injection simulation of the canvasapp gateway (./canvasappFuzz.ts: what it does,
// its invariants, how to run more seeds). Split so vitest runs the parts in parallel.
import { vi } from 'vitest'

vi.mock('../../lib/imageStore', async () => (await import('./canvasappFuzzMocks')).imageStoreMock())
vi.mock('../../core/ids', async (importOriginal) => (await import('./canvasappFuzzMocks')).idsMock(await importOriginal<object>()))

import { defineFuzz } from './canvasappFuzz'

defineFuzz(4, 4)
