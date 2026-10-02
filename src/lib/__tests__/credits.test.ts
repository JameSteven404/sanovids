import { describe, expect, it } from 'vitest'
import {
  chargedDemo,
  CREDIT_SOURCE_LABEL,
  creditKindOf,
  creditUnitLabel,
  DEMO_CREDITS_DEFAULT,
  formatCreditNumber,
  formatCredits,
  formatVnd,
} from '../credits'

describe('formatCredits', () => {
  it('names the kind: demo credits are never shown as a bare amount', () => {
    expect(formatCredits(20, 'demo')).toBe('20 credit demo')
    expect(formatCredits(20, 'canvasapp')).toBe('20 credit')
  })

  it('short form', () => {
    expect(formatCredits(20, 'demo', { short: true })).toBe('20 cr')
    expect(formatCredits(20, 'canvasapp', { short: true })).toBe('20 cr')
    expect(formatCredits(1234, 'demo', { short: true })).toBe('1.234 cr')
  })

  it('uses vi-VN thousands separators', () => {
    expect(formatCredits(1234, 'canvasapp')).toBe('1.234 credit')
    expect(formatCredits(1234567, 'demo')).toBe('1.234.567 credit demo')
    expect(formatCredits(999, 'demo')).toBe('999 credit demo')
    expect(formatCredits(1000, 'demo')).toBe('1.000 credit demo')
    expect(formatCredits(0, 'canvasapp')).toBe('0 credit')
  })

  it('never invents a number', () => {
    expect(formatCredits(null, 'canvasapp')).toBe('—')
    expect(formatCredits(undefined, 'demo')).toBe('—')
    expect(formatCredits(Number.NaN, 'canvasapp', { short: true })).toBe('—')
  })
})

describe('formatCreditNumber', () => {
  it('groups with "." and writes decimals with ","', () => {
    expect(formatCreditNumber(377)).toBe('377')
    expect(formatCreditNumber(12345.5)).toBe('12.345,5')
    expect(formatCreditNumber(1.256)).toBe('1,26')
    expect(formatCreditNumber(2.0)).toBe('2')
    expect(formatCreditNumber(-1500)).toBe('-1.500')
    expect(formatCreditNumber(-0.001)).toBe('0')
    expect(formatCreditNumber(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('units and labels', () => {
  it('creditUnitLabel', () => {
    expect(creditUnitLabel('demo')).toBe('credit demo')
    expect(creditUnitLabel('dev')).toBe('credit dev')
    expect(creditUnitLabel('canvasapp')).toBe('credit')
    expect(creditUnitLabel('demo', { short: true })).toBe('cr')
    expect(creditUnitLabel('dev', { short: true })).toBe('cr')
  })

  it('kind of a provider, source labels, đồng', () => {
    expect(creditKindOf('mock')).toBe('demo')
    expect(creditKindOf('dev')).toBe('dev')
    expect(creditKindOf('canvasapp')).toBe('canvasapp')
    expect(CREDIT_SOURCE_LABEL).toEqual({ demo: 'credit demo', dev: 'credit dev', canvasapp: 'credit canvasapp' })
    expect(formatVnd(1234)).toBe('1.234.000đ')
    expect(formatVnd(0.5)).toBe('500đ')
    expect(formatVnd(null)).toBe('—')
    expect(DEMO_CREDITS_DEFAULT).toBe(1000)
  })

  it('chargedDemo: only demo takes are paid with demo credits', () => {
    expect(chargedDemo({ provider: 'mock', charged: true })).toBe(true)
    expect(chargedDemo({ provider: undefined, charged: undefined })).toBe(true) // old takes
    expect(chargedDemo({ provider: 'mock', charged: false })).toBe(false)
    expect(chargedDemo({ provider: 'canvasapp', charged: false })).toBe(false)
    expect(chargedDemo({ provider: 'canvasapp', charged: true })).toBe(false)
    expect(chargedDemo({ provider: 'dev', charged: true })).toBe(false) // development mode bills the simulated account
  })
})
