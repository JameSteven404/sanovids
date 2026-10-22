import { afterEach, expect, it, vi } from 'vitest'
import { escapeDecision, escapeForFullscreen, trackFullscreen } from '../fullscreenGuard'

afterEach(() => vi.unstubAllGlobals())

it('exits fullscreen, swallows the same Escape after fullscreenchange, and later permits closing', () => {
  let time = 1000
  vi.stubGlobal('performance', { now: () => time })
  const doc = { fullscreenElement: {}, exitFullscreen: vi.fn(async () => undefined), addEventListener: vi.fn(), removeEventListener: vi.fn() }
  vi.stubGlobal('document', doc)
  const stop = trackFullscreen()
  const key = { key: 'Escape', preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() } as unknown as KeyboardEvent
  expect(escapeForFullscreen(key)).toBe(true)
  expect(doc.exitFullscreen).toHaveBeenCalledOnce()
  Object.assign(doc, { fullscreenElement: null })
  doc.addEventListener.mock.calls[0][1]()
  expect(escapeForFullscreen(key)).toBe(true)
  time += 1000
  expect(escapeForFullscreen(key)).toBe(false)
  expect(escapeDecision({ fullscreen: false, exitedAt: -Infinity, now: time })).toBe('normal')
  stop()
  expect(doc.removeEventListener).toHaveBeenCalledWith('fullscreenchange', doc.addEventListener.mock.calls[0][1])
})
