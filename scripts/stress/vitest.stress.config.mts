// Vitest config of the long stress soak (`node scripts/stress/run-stress.mjs`). Same Vite config as the app tests,
// but only the *.stress.ts files, one process, no per-test timeout cap (each soak sets its own).
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../vite.config.ts'

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['src/devtools/stress/__tests__/*.stress.ts'],
      pool: 'forks',
      fileParallelism: false,
      hookTimeout: 120_000,
      reporters: ['default'],
    },
  }),
)
