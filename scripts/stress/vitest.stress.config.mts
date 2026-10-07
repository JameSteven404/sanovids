// Vitest config of the long stress soak (`node scripts/stress/run-stress.mjs`). Same Vite config as the app tests,
// but only the *.stress.ts files, one process, no per-test timeout cap (each soak sets its own).
// vite.config.ts exports a function of the mode (perf builds): call it with the same env, then add the test options.
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../vite.config.ts'

export default defineConfig((env) =>
  mergeConfig(typeof base === 'function' ? base(env) : base, {
    test: {
      include: ['src/devtools/stress/__tests__/*.stress.ts'],
      pool: 'forks',
      fileParallelism: false,
      hookTimeout: 120_000,
      reporters: ['default'],
    },
  }),
)
