import { describe, expect, it } from 'vitest'
import { playWithSound } from '../playback'

/** Minimal stand-in for an HTMLVideoElement: play() answers from a script of outcomes. */
function fakeVideo(outcomes: (null | string)[]) {
  const calls: boolean[] = []
  const v = {
    muted: true,
    play() {
      calls.push(v.muted)
      const err = outcomes.shift() ?? null
      return err ? Promise.reject(Object.assign(new Error(err), { name: err })) : Promise.resolve()
    },
  }
  return { v: v as unknown as HTMLVideoElement, calls }
}

describe('playWithSound', () => {
  it('plays with sound when allowed', async () => {
    const { v, calls } = fakeVideo([null])
    expect(await playWithSound(v, true)).toBe(true)
    expect(v.muted).toBe(false)
    expect(calls).toEqual([false])
  })
  it('falls back to muted playback when the browser refuses sound (no click yet)', async () => {
    const { v, calls } = fakeVideo(['NotAllowedError', null])
    expect(await playWithSound(v, true)).toBe(false)
    expect(v.muted).toBe(true)
    expect(calls).toEqual([false, true])
  })
  it('plays muted when the speaker switch is off', async () => {
    const { v, calls } = fakeVideo([null])
    expect(await playWithSound(v, false)).toBe(false)
    expect(calls).toEqual([true])
  })
  it('an interrupted play (paused, new source, hidden page) keeps the sound setting and is not retried', async () => {
    const { v, calls } = fakeVideo(['AbortError'])
    expect(await playWithSound(v, true)).toBe(true)
    expect(v.muted).toBe(false)
    expect(calls).toEqual([false])
  })
})
