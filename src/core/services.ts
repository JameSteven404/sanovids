// Local catalogue types for seedvis A0; the app's existing unions are wired in track B1.
export type ServiceId = 'canvasapp' | 'seedvis'
export const CANVASAPP_MODEL_IDS = ['seedance_2_5', 'minimax_h3'] as const
export const SEEDVIS_MODEL_IDS = ['seedvis/seedance_2.5', 'seedvis/seedance_2.0_fast', 'seedvis/veo_3.1'] as const
export type CanvasappModelId = typeof CANVASAPP_MODEL_IDS[number]
export type SeedvisModelId = typeof SEEDVIS_MODEL_IDS[number]
export type ModelId = CanvasappModelId | SeedvisModelId
export type Mode = 't2v' | 'i2v' | 'transform' | 'first'
export type TakeProvider = 'mock' | 'dev' | 'canvasapp' | 'seedvis-dev' | 'seedvis'

export const SERVICES = {
  canvasapp: {
    label: 'canvasapp', short: 'CA', site: 'canvasapp.io.vn',
    token: '--provider-canvasapp', softToken: '--provider-canvasapp-soft', icon: 'Cloud',
    executors: ['dev', 'canvasapp'], hasTopUp: true,
  },
  seedvis: {
    label: 'seedvis', short: 'SV', site: 'seedvis.com',
    token: '--provider-seedvis', softToken: '--provider-seedvis-soft', icon: 'Sprout',
    // No in-app top-up API; billing is opened externally by the desktop bridge.
    executors: ['seedvis-dev', 'seedvis'], hasTopUp: false,
  },
} as const satisfies Record<ServiceId, {
  label: string; short: string; site: string
  token: `--provider-${ServiceId}`; softToken: `--provider-${ServiceId}-soft`
  icon: 'Cloud' | 'Sprout'; executors: readonly TakeProvider[]; hasTopUp: boolean
}>

export const SERVICE_OF_PROVIDER = {
  mock: 'canvasapp', dev: 'canvasapp', canvasapp: 'canvasapp',
  'seedvis-dev': 'seedvis', seedvis: 'seedvis',
} as const satisfies Record<TakeProvider, ServiceId>

export const isSimulatedProvider = (provider: TakeProvider): boolean =>
  provider === 'mock' || provider === 'dev' || provider === 'seedvis-dev'
