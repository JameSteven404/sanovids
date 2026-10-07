// The provider registry knows both seedvis executors by name (labels, limits words, wallets, revision keys) before the
// engine runs them (track B2): nothing is ever sent to them yet, and a scene's provider follows its route.
import { afterEach, describe, expect, it } from 'vitest'
import {
  activeProviderId,
  NO_LIMITS,
  PROVIDER_LABEL,
  providerBlockedReason,
  providerForModel,
  providerLimits,
  SEEDVIS_UNAVAILABLE_REASON,
  useProviderLimits,
  useProviderPrefs,
  type ProviderId,
} from '..'
import { applyDevAccessState, bareState } from '../devAccess'
import { limitsSite, settingsRunWarning } from '../limits'
import type { SettingsLimits } from '../types'

const ALL: readonly ProviderId[] = ['mock', 'dev', 'canvasapp', 'seedvis-dev', 'seedvis']

afterEach(() => {
  applyDevAccessState(bareState('build'))
  useProviderPrefs.getState().setProvider('dev')
})

describe('seedvis in the provider registry', () => {
  it('every provider has its label, its limits words and a revision counter', () => {
    expect(PROVIDER_LABEL).toEqual({ dev: 'Phát triển (giả lập)', canvasapp: 'canvasapp.io.vn', mock: 'Demo cũ', 'seedvis-dev': 'seedvis giả lập', seedvis: 'seedvis.com' })
    for (const id of ALL) expect(typeof useProviderLimits.getState().rev[id], id).toBe('number')
    expect(limitsSite('seedvis')).toEqual({ short: 'seedvis', full: 'seedvis.com', credit: 'credit seedvis' })
    expect(limitsSite('seedvis-dev')).toEqual({ short: 'seedvis giả lập', full: 'seedvis giả lập (chế độ Phát triển)', credit: 'credit dev seedvis' })
    // canvasapp's words unchanged
    expect(limitsSite('dev')).toEqual({ short: 'canvasapp giả lập', full: 'canvasapp giả lập (chế độ Phát triển)', credit: 'credit dev' })
    expect(limitsSite('canvasapp')).toEqual({ short: 'canvasapp', full: 'canvasapp.io.vn', credit: 'credit' })
  })

  it('a guessed refusal names the right site and credits', () => {
    const guess: SettingsLimits = { source: 'fallback', firm: false, issues: () => [{ field: 'model', reason: 'Không có.' }] }
    const s = { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' } as const
    expect(settingsRunWarning(guess, s, 'seedvis')).toBe(
      'Có thể bị từ chối khi gửi (không tốn credit seedvis): Không có — chưa đọc được danh sách model của seedvis nên đang theo cấu hình có sẵn của SanoVids',
    )
    expect(settingsRunWarning(guess, s, 'canvasapp')).toBe(
      'Có thể bị từ chối khi gửi (không tốn credit): Không có — chưa đọc được cấu hình model nên đang theo cấu hình mặc định như trang canvasapp',
    )
  })

  it('nothing is sent to a seedvis executor before B2 wires it: blocked, no limits, never a throw', () => {
    for (const id of ['seedvis', 'seedvis-dev'] as const) {
      expect(providerBlockedReason(id)).toBe(SEEDVIS_UNAVAILABLE_REASON)
      expect(providerLimits(id)).toBe(NO_LIMITS)
    }
    expect(SEEDVIS_UNAVAILABLE_REASON).toMatch(/chưa gửi gì, không bị trừ credit/)
  })

  it('a scene’s provider follows its route: canvasapp → the active canvasapp provider; seedvis → its simulation while open', () => {
    expect(providerForModel('seedance_2_5')).toBe(activeProviderId())
    expect(providerForModel('minimax_h3')).toBe('dev')
    expect(providerForModel('seedvis/veo_3.1')).toBe('seedvis-dev')
    applyDevAccessState(bareState('locked'))
    expect(providerForModel('seedance_2_5')).toBe('canvasapp')
    // locked builds: the real seedvis only — never a silent fallback to the simulation
    expect(providerForModel('seedvis/seedance_2.0_fast')).toBe('seedvis')
    // an id this build has no route for is canvasapp's (as specOf / normalizeSettings)
    expect(providerForModel('future/model_x')).toBe('canvasapp')
  })
})
