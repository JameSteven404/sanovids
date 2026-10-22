// useLive under React's StrictMode (what `npm run dev` runs): the simulated unmount + mount must leave it true, so an
// async answer (the "Nhập job" scan) is shown — and false after a real unmount, so a late answer is dropped.
import { describe, expect, it } from 'vitest'
import { act, createElement, StrictMode, useEffect, useState } from 'react'
import { useLive } from '../useLive'
import { mountWithoutDom, settle } from './nullRoot'

/** The dialog's pattern: an async read started by an effect, its answer kept only while the component is live. */
function Scanner({ read, seen }: { read: () => Promise<string>; seen: (phase: string) => void }) {
  const live = useLive()
  const [phase, setPhase] = useState('loading')
  useEffect(() => {
    void read().then((v) => {
      if (live.current) setPhase(v)
    })
  }, [read, live])
  seen(phase)
  return null
}

describe('useLive', () => {
  it('StrictMode (dev): the answer of an effect’s async read is shown, not dropped', async () => {
    const phases: string[] = []
    const root = mountWithoutDom(createElement(StrictMode, null, createElement(Scanner, { read: async () => 'ready', seen: (p) => void phases.push(p) })))
    await settle()
    expect(phases.at(-1)).toBe('ready')
    act(() => root.unmount())
  })

  it('false once unmounted: a late answer is dropped (also under StrictMode)', async () => {
    const releases: ((v: string) => void)[] = []
    const read = () => new Promise<string>((resolve) => void releases.push(resolve))
    const phases: string[] = []
    const root = mountWithoutDom(createElement(StrictMode, null, createElement(Scanner, { read, seen: (p) => void phases.push(p) })))
    act(() => root.unmount())
    releases.forEach((r) => r('ready'))
    await settle()
    expect(releases.length).toBeGreaterThan(0)
    expect(phases).not.toContain('ready')
  })
})
