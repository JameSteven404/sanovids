import { expect, it } from 'vitest'
import { parseArgs } from '../run-perf.mjs'

it('accepts the 3000-scene tier without changing existing CLI defaults or launching the driver', () => {
  expect(parseArgs([])).toMatchObject({ size: 'L', runs: 3, target: 'web' })
  for (const size of ['M', 'L', 'XL', 'XXL']) expect(parseArgs(['--size', size]).size).toBe(size)
  expect(() => parseArgs(['--size', 'XXXL'])).toThrow()
})
