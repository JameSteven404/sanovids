// seedvis request lanes (electron/seedvis-rules.cjs createSeedvisLanes) and their use by electron/seedvis.cjs:
// api 3 / submit 2 / download 2 in flight, ≤ 64 MiB of request bodies in flight, Retry-After blocks per lane, the
// submit breaker (≤ min(rate_limit_per_minute, 30) per minute) and same-key coalescing (same key + same bytes share one
// request; same key + other bytes → a local idempotency conflict, nothing sent). Separate from canvasapp's lanes.
import { afterEach, describe, expect, it } from 'vitest'
import { type Any, type Ctl, type Harness, FAKE_KEY, OTHER_KEY, UUID, accountInfo, completed, createReq, harness, incoming, jsonAnswer, keyRules, mp4, queued202, rules, saveKeyUnverified, seedanceBody, settle } from './fakeElectron'

const MIB = 1024 * 1024

/** A task that stays running until `finish(value)`. */
function pending<T = string>() {
  let finish: (v: T) => void = () => undefined
  const done = new Promise<T>((resolve) => (finish = resolve))
  return { done, finish }
}

function lanes(o: Any = {}) {
  let t = 0
  const l = rules.createSeedvisLanes({ now: () => t, ...o })
  return { l, advance: (ms: number) => (t += ms), at: () => t }
}

describe('createSeedvisLanes', () => {
  it('slots per lane: api 3, submit 2, download 2 — long downloads never hold a poll or a submit back', async () => {
    const { l } = lanes()
    const started: string[] = []
    const dl = [0, 1, 2].map((i) => {
      const p = pending()
      void l.run('download', async () => (started.push(`dl${i}`), p.done))
      return p
    })
    await settle(2)
    expect(started).toEqual(['dl0', 'dl1'])
    expect(l.waiting('download')).toBe(1)
    const polls = [0, 1, 2, 3].map((i) => {
      const p = pending()
      void l.run('api', async () => (started.push(`api${i}`), p.done))
      return p
    })
    const subs = [0, 1, 2].map((i) => {
      const p = pending()
      void l.run('submit', async () => (started.push(`sub${i}`), p.done), { bytes: 1000 })
      return p
    })
    await settle(2)
    expect(started).toEqual(['dl0', 'dl1', 'api0', 'api1', 'api2', 'sub0', 'sub1'])
    expect([l.active('api'), l.active('submit'), l.active('download')]).toEqual([3, 2, 2])
    polls[0].finish('x')
    subs[0].finish('x')
    dl[0].finish('x')
    await settle(3)
    expect(started.slice(7).sort()).toEqual(['api3', 'dl2', 'sub2'])
    for (const p of [...polls, ...subs, ...dl]) p.finish('x')
    await settle(3)
    expect([l.active('api'), l.active('submit'), l.active('download')]).toEqual([0, 0, 0])
    expect(() => l.run('images', async () => 1)).toThrow()
  })

  it('≤ 64 MiB of bodies in flight: a second 39 MiB body waits; a body over the budget alone still runs', async () => {
    const { l } = lanes()
    const started: string[] = []
    const a = pending()
    const b = pending()
    void l.run('submit', async () => (started.push('a'), a.done), { bytes: 39 * MIB })
    void l.run('submit', async () => (started.push('b'), b.done), { bytes: 39 * MIB })
    await settle(2)
    expect(started).toEqual(['a'])
    expect(l.bytesInFlight()).toBe(39 * MIB)
    a.finish('x')
    await settle(3)
    expect(started).toEqual(['a', 'b'])
    b.finish('x')
    await settle(3)
    expect(l.bytesInFlight()).toBe(0)
    const big = pending()
    void l.run('submit', async () => (started.push('big'), big.done), { bytes: 80 * MIB })
    await settle(2)
    expect(started).toContain('big')
    // FIFO: a small body never jumps a big one waiting for room
    const small = pending()
    const c = pending()
    void l.run('submit', async () => (started.push('c'), c.done), { bytes: 50 * MIB })
    void l.run('submit', async () => (started.push('small'), small.done), { bytes: 1 })
    await settle(2)
    expect(started).not.toContain('small')
    big.finish('x')
    await settle(3)
    expect(started.slice(-2)).toEqual(['c', 'small'])
    c.finish('x')
    small.finish('x')
  })

  it('Retry-After blocks one lane, clamped to 1–300 s; a shorter block never shortens a longer one', () => {
    const { l, advance } = lanes()
    l.block('submit', 30_000)
    expect(l.blockedFor('submit')).toBe(30_000)
    expect(l.blockedFor('api')).toBe(0)
    l.block('submit', 5_000)
    expect(l.blockedFor('submit')).toBe(30_000)
    advance(29_000)
    expect(l.blockedFor('submit')).toBe(1000)
    advance(1000)
    expect(l.blockedFor('submit')).toBe(0)
    l.block('api', 10)
    expect(l.blockedFor('api')).toBe(1000)
    l.block('download', 10 * 60_000)
    expect(l.blockedFor('download')).toBe(300_000)
  })

  it('the submit breaker: ≤ min(limit, 30) per rolling minute', () => {
    const { l, advance } = lanes()
    expect(l.submitLimit()).toBe(30)
    l.setSubmitLimit(120)
    expect(l.submitLimit()).toBe(30)
    l.setSubmitLimit(3)
    expect(l.submitLimit()).toBe(3)
    for (const bad of [0, -1, Number.NaN, '5']) l.setSubmitLimit(bad)
    expect(l.submitLimit()).toBe(3)
    for (let i = 0; i < 3; i++) {
      expect(l.submitWaitMs()).toBe(0)
      l.noteSubmit()
      advance(10_000)
    }
    expect(l.submitWaitMs()).toBe(30_000) // the first one leaves the window at 60 s
    advance(30_000)
    expect(l.submitWaitMs()).toBe(0)
  })

  it('coalescing: same key + same hash → one call, one answer; other hash → conflict; then free again', async () => {
    const { l } = lanes()
    let calls = 0
    const p = pending<Any>()
    const a = l.coalesce('k', 'h1', () => (calls++, p.done))
    const b = l.coalesce('k', 'h1', () => (calls++, p.done))
    expect(a.shared).toBe(false)
    expect(b.shared).toBe(true)
    expect(l.coalesce('k', 'h2', () => (calls++, p.done))).toEqual({ conflict: true })
    p.finish({ ok: true })
    expect(await a.promise).toEqual({ ok: true })
    expect(await b.promise).toBe(await a.promise)
    await settle(2)
    expect(calls).toBe(1)
    const c = l.coalesce('k', 'h2', async () => (calls++, { ok: 2 }))
    expect(await c.promise).toEqual({ ok: 2 })
    const failing = l.coalesce('z', 'h', async () => {
      throw new Error('x')
    })
    await expect(failing.promise).rejects.toThrow('x')
    await settle(2)
    expect(l.coalesce('z', 'h', async () => 'again').shared).toBe(false)
  })

  it('cancelWaiting resolves the waiting requests with the given answer; their work never runs', async () => {
    const { l } = lanes()
    const hold = [pending(), pending()]
    let ran = 0
    hold.forEach((p) => void l.run('submit', async () => (ran++, p.done)))
    const waiting = [0, 1].map(() => l.run('submit', async () => (ran++, 'sent')))
    await settle(2)
    expect(l.cancelWaiting('submit', { ok: false, code: 'busy' })).toBe(2)
    expect(await Promise.all(waiting)).toEqual([
      { ok: false, code: 'busy' },
      { ok: false, code: 'busy' },
    ])
    hold.forEach((p) => p.finish('x'))
    await settle(3)
    expect(ran).toBe(2)
  })
})

describe('seedvis.cjs lanes', () => {
  let h: Harness
  afterEach(() => h.cleanup())
  const withKey = async () => expect((await saveKeyUnverified(h, FAKE_KEY)).ok).toBe(true)

  it('the same key + the same body asked twice while in flight → one POST, one answer; other body → conflict, not sent', async () => {
    h = harness()
    await withKey()
    const holds: (() => void)[] = []
    h.net.server = (ctl) => void holds.push(() => ctl.reply(jsonAnswer(202, queued202('gen_1'))))
    const a = h.call('seedvis:request', createReq())
    const b = h.call('seedvis:request', createReq())
    await settle()
    const c = await h.call('seedvis:request', createReq({ body: seedanceBody({ prompt: 'khác' }) }))
    expect(c).toEqual({ ok: false, code: 'idempotency-conflict', message: rules.SEEDVIS_TEXTS.conflict, sent: false })
    expect(holds).toHaveLength(1)
    holds[0]()
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toMatchObject({ ok: true, status: 202 })
    expect(rb).toEqual(ra)
    expect(h.net.seen.filter((s) => s.method === 'POST')).toHaveLength(1)
    // after the answer the same key may go again (an explicit same-key re-send is the page's decision)
    h.net.server = (ctl) => ctl.reply(jsonAnswer(202, queued202('gen_1'), { 'idempotency-replayed': 'true' }))
    expect(await h.call('seedvis:request', createReq())).toMatchObject({ ok: true, headers: { 'Idempotency-Replayed': 'true' } })
    expect(h.net.seen.filter((s) => s.method === 'POST')).toHaveLength(2)
  })

  it('two submits upload at once; the third waits for a slot (and counts as in flight for the close guard)', async () => {
    h = harness()
    await withKey()
    const holds: (() => void)[] = []
    h.net.server = (ctl) => void holds.push(() => ctl.reply(jsonAnswer(202, queued202(`gen_${holds.length}`))))
    const keys = ['407822d1-ff74-44a5-b939-9e563102e771', '407822d1-ff74-44a5-b939-9e563102e772', '407822d1-ff74-44a5-b939-9e563102e773']
    const all = keys.map((k) => h.call('seedvis:request', createReq({ idempotencyKey: k })))
    await settle()
    expect(holds).toHaveLength(2)
    expect(h.gw.inFlightSubmits()).toBe(3)
    holds[0]()
    await settle()
    expect(holds).toHaveLength(3)
    holds[1]()
    holds[2]()
    expect((await Promise.all(all)).every((r: Any) => r.ok)).toBe(true)
    expect(h.gw.inFlightSubmits()).toBe(0)
  })

  it('Xoá key while a submit waits for a slot: it never leaves with the old key (no-key, not sent)', async () => {
    h = harness()
    await withKey()
    const holds: (() => void)[] = []
    h.net.server = (ctl) => void holds.push(() => ctl.reply(jsonAnswer(202, queued202(`gen_${holds.length}`))))
    const keys = ['407822d1-ff74-44a5-b939-9e563102e771', '407822d1-ff74-44a5-b939-9e563102e772', '407822d1-ff74-44a5-b939-9e563102e773']
    const all = keys.map((k) => h.call('seedvis:request', createReq({ idempotencyKey: k })))
    await settle()
    expect(holds).toHaveLength(2)
    expect((await h.call('seedvis:clearKey')).ok).toBe(true)
    holds[0]()
    holds[1]()
    const [a, b, c] = await Promise.all(all)
    expect(a.ok && b.ok).toBe(true) // those had left before "Xoá key"
    expect(c).toEqual({ ok: false, code: 'no-key', message: keyRules.SEEDVIS_KEY_TEXTS.keyChanged, sent: false })
    expect(h.net.seen.filter((s) => s.method === 'POST')).toHaveLength(2)
    expect(h.gw.inFlightSubmits()).toBe(0)
  })

  it('a new key while a submit waits for a slot: refused (not sent with the old key, not silently with the new one)', async () => {
    h = harness()
    await withKey()
    const holds: (() => void)[] = []
    h.net.server = (ctl) => void holds.push(() => ctl.reply(jsonAnswer(202, queued202(`gen_${holds.length}`))))
    const keys = ['407822d1-ff74-44a5-b939-9e563102e771', '407822d1-ff74-44a5-b939-9e563102e772', '407822d1-ff74-44a5-b939-9e563102e773']
    const all = keys.map((k) => h.call('seedvis:request', createReq({ idempotencyKey: k })))
    await settle()
    expect(holds).toHaveLength(2)
    expect((await saveKeyUnverified(h, OTHER_KEY)).ok).toBe(true)
    holds[0]()
    holds[1]()
    const [, , c] = await Promise.all(all)
    expect(c).toEqual({ ok: false, code: 'no-key', message: keyRules.SEEDVIS_KEY_TEXTS.keyChanged, sent: false })
    const posts = h.net.seen.filter((s) => s.method === 'POST')
    expect(posts).toHaveLength(2)
    for (const p of posts) expect(p.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`)
  })

  it('Xoá key while a poll waits for an api slot: nothing leaves (no-key)', async () => {
    h = harness()
    await withKey()
    const stuck: Ctl[] = []
    h.net.server = (ctl) => void stuck.push(ctl)
    const polls = ['g1', 'g2', 'g3', 'g4'].map((id) => h.call('seedvis:request', { route: 'generations.get', id }))
    await settle()
    expect(stuck).toHaveLength(3)
    expect((await h.call('seedvis:clearKey')).ok).toBe(true)
    for (const s of stuck) s.reply(jsonAnswer(200, completed(s.req.url.split('/').pop()!.split('?')[0])))
    const last = await polls[3]
    expect(last).toEqual({ ok: false, code: 'no-key', message: keyRules.SEEDVIS_KEY_TEXTS.noKey })
    expect(h.net.seen).toHaveLength(3)
  })

  it('downloads have their own lane: a poll goes out while two videos are still downloading', async () => {
    h = harness()
    await withKey()
    const stuck: Ctl[] = []
    h.net.server = (ctl) => {
      if (ctl.req.url.includes('/developer/generations/')) return ctl.reply(jsonAnswer(200, completed(ctl.req.url.split('/').pop()!.split('?')[0], `https://cdn.seedvis.com/${ctl.req.url.length}.mp4`)))
      if (ctl.req.url.startsWith('https://cdn.seedvis.com/')) return void stuck.push(ctl) // headers never come
      return ctl.reply(jsonAnswer(200, { success: true, data: [] }))
    }
    for (const id of ['g1', 'g2', 'g3']) await h.call('seedvis:request', { route: 'generations.get', id })
    const opens = ['g1', 'g2', 'g3'].map((id) => h.call('seedvis:downloadOpen', { generationId: id, index: 0 }))
    await settle()
    expect(stuck).toHaveLength(2) // the third waits for a download slot
    expect(await h.call('seedvis:request', { route: 'models' })).toMatchObject({ ok: true, status: 200 })
    stuck[0].reply(incoming(200, { 'content-length': '64' }, [mp4(64)]))
    expect(await opens[0]).toMatchObject({ ok: true, mime: 'video/mp4' })
    await h.call('seedvis:downloadClose', { id: (await opens[0]).id })
    await settle()
    expect(stuck).toHaveLength(3)
    stuck[1].reply(incoming(404, {}, []))
    stuck[2].reply(incoming(410, {}, []))
    expect((await opens[1]).code).toBe('expired-link')
    expect((await opens[2]).code).toBe('expired-link')
  })

  it('the breaker follows the account’s rate_limit_per_minute: the extra submit is refused locally, not sent', async () => {
    h = harness()
    await withKey()
    h.net.server = (ctl) => {
      if (ctl.req.url.endsWith('/account/info')) return ctl.reply(jsonAnswer(200, accountInfo({ rate_limit_per_minute: 2 })))
      ctl.reply(jsonAnswer(202, queued202('gen_x')))
    }
    await h.call('seedvis:request', { route: 'account.info' })
    const keys = ['1', '2', '3'].map((d) => `${UUID.slice(0, -1)}${d}`)
    expect((await h.call('seedvis:request', createReq({ idempotencyKey: keys[0] }))).ok).toBe(true)
    expect((await h.call('seedvis:request', createReq({ idempotencyKey: keys[1] }))).ok).toBe(true)
    const third = await h.call('seedvis:request', createReq({ idempotencyKey: keys[2] }))
    expect(third).toMatchObject({ ok: false, code: 'rate-limited', sent: false, message: rules.SEEDVIS_TEXTS.breaker })
    expect(third.retryAfterMs).toBeGreaterThan(50_000)
    expect(h.net.seen.filter((s) => s.method === 'POST')).toHaveLength(2)
  })
})
