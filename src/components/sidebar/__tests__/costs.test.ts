// Cost labels of the workspace (scene card, inspector, presets, table): docs/SPEC-v2.md §9.
import { describe, expect, it } from 'vitest'
import { costOf, normalizeSettings } from '../../../core/models'
import { DEMO_CREDIT_HINT } from '../../../lib/credits'
import { costTitle, creditTone, REAL_COST_HINT, totalCost } from '../shared'

describe('creditTone', () => {
  it('demo play money and real canvasapp credits get different classes', () => {
    expect(creditTone('demo')).toBe('is-demo')
    expect(creditTone('canvasapp')).toBe('is-real')
  })
})

describe('costTitle', () => {
  it('demo: the amount says "credit demo" and the second line says it is not real money', () => {
    expect(costTitle(20, 'demo')).toBe(`20 credit demo\n${DEMO_CREDIT_HINT}`)
    expect(costTitle(1234, 'demo', 'Chạy S01 · ')).toBe(`Chạy S01 · 1.234 credit demo\n${DEMO_CREDIT_HINT}`)
  })

  it('canvasapp: an estimate in canvasapp credits with its value in đồng', () => {
    expect(costTitle(20, 'canvasapp')).toBe(`≈ 20 credit canvasapp (≈ 20.000đ)\n${REAL_COST_HINT}`)
    expect(costTitle(1234, 'canvasapp', 'Chạy S01 · ')).toBe(`Chạy S01 · ≈ 1.234 credit canvasapp (≈ 1.234.000đ)\n${REAL_COST_HINT}`)
  })

  it('never shows "demo" for real credits, nor đồng for demo credits', () => {
    expect(costTitle(50, 'canvasapp')).not.toMatch(/demo/)
    expect(costTitle(50, 'demo')).not.toMatch(/đ\)/)
  })

  it('an unknown amount is "—", never a made-up number', () => {
    expect(costTitle(Number.NaN, 'demo')).toBe('—')
    expect(costTitle(null, 'canvasapp', 'Chạy · ')).toBe('Chạy · —')
    expect(costTitle(undefined, 'canvasapp')).toBe('—')
  })
})

describe('totalCost', () => {
  it('adds up the per-run cost of every scene', () => {
    const a = normalizeSettings({ model: 'seedance_2_5' })
    const b = normalizeSettings({ model: 'minimax_h3' })
    expect(totalCost([])).toBe(0)
    expect(totalCost([{ settings: a }, { settings: b }, { settings: a }])).toBe(costOf(a) * 2 + costOf(b))
  })
})
