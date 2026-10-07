// electron/seedvis-rules.cjs (pure) and its wiring in electron/seedvis.cjs, run with a fake Electron
// (fakeElectron.ts): routes, the submit allowlist and body, URL / header rules (the API key only to exactly
// https://seedvis.com — never cdn.seedvis.com, never a redirect hop), redaction, account sanitizing, Retry-After,
// the upload clock (`sent`, `lastByteAt`, stall / answer / mustFinishBy aborts), downloads, the partition's
// permission handlers and the close guard (never vetoes an update's quit). No network, no real profile, no real key.
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SEEDVIS_ACCOUNT_INFO_FIELDS, SEEDVIS_ANSWER_WAIT_MS, SEEDVIS_API_BASE, SEEDVIS_IMAGE_LIMITS, SEEDVIS_IPC_LIMITS,
  SEEDVIS_IPC_ROUTES, SEEDVIS_ORIGIN, SEEDVIS_RESPONSE_HEADERS,
} from '../contract'
import {
  type Any, type Ctl, type Harness, FAKE_KEY, UUID, accountInfo, completed, createReq, flush, harness, incoming, jpeg,
  jsonAnswer, mainPump, mp4, png, queued202, rules, saveKeyUnverified, seedanceBody, seedvisModule, settle, veoBody, webp,
} from './fakeElectron'

const MIB = 1024 * 1024
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')

describe('seedvis-rules: constants follow the A0 contract', () => {
  it('origin, base, limits, response headers, account fields, answer wait', () => {
    expect(rules.SEEDVIS_ORIGIN).toBe(SEEDVIS_ORIGIN)
    expect(rules.SEEDVIS_API_BASE).toBe(SEEDVIS_API_BASE)
    expect({ ...rules.SEEDVIS_IPC_LIMITS }).toEqual(SEEDVIS_IPC_LIMITS)
    expect({ ...rules.SEEDVIS_IMAGE_LIMITS, formats: [...rules.SEEDVIS_IMAGE_LIMITS.formats] }).toEqual({ ...SEEDVIS_IMAGE_LIMITS, formats: [...SEEDVIS_IMAGE_LIMITS.formats] })
    expect([...rules.SEEDVIS_RESPONSE_HEADERS]).toEqual([...SEEDVIS_RESPONSE_HEADERS])
    expect([...rules.SEEDVIS_ACCOUNT_INFO_FIELDS]).toEqual([...SEEDVIS_ACCOUNT_INFO_FIELDS])
    expect(rules.SEEDVIS_ANSWER_WAIT_MS).toBe(SEEDVIS_ANSWER_WAIT_MS)
    for (const [name, r] of Object.entries(SEEDVIS_IPC_ROUTES)) {
      expect({ method: rules.SEEDVIS_ROUTES[name].method, path: rules.SEEDVIS_ROUTES[name].path }, name).toEqual(r)
    }
    expect(Object.keys(rules.SEEDVIS_ROUTES)).toEqual(Object.keys(SEEDVIS_IPC_ROUTES))
  })

  it('the partition lives in memory; lanes are api 3 / submit 2 / download 2; breaker ≤ 30 / min', () => {
    expect(rules.SEEDVIS_PARTITION).toBe('sanovids-seedvis')
    expect(rules.SEEDVIS_PARTITION.startsWith('persist:')).toBe(false)
    expect({ ...rules.SEEDVIS_LANE_SIZE }).toEqual({ api: 3, submit: 2, download: 2 })
    expect(rules.SEEDVIS_SUBMIT_BREAKER_MAX).toBe(30)
    expect(rules.SEEDVIS_TIMEOUTS.answerWaitMs).toBe(45_000)
    expect(rules.SEEDVIS_TIMEOUTS.uploadStallMs).toBe(60_000)
    expect(rules.SEEDVIS_TIMEOUTS.noProgressBps).toBe(32 * 1024)
    expect(rules.SEEDVIS_BILLING_URL.startsWith('https://seedvis.com/')).toBe(true)
  })
})

describe('routes (main builds every URL)', () => {
  it('maps the six symbolic routes; ids only on the two job routes', () => {
    expect(rules.matchSeedvisRoute({ route: 'models' })).toMatchObject({ method: 'GET', lane: 'api', url: 'https://seedvis.com/api/v1/models' })
    expect(rules.matchSeedvisRoute({ route: 'account.info' }).url).toBe('https://seedvis.com/api/v1/account/info')
    expect(rules.matchSeedvisRoute({ route: 'account.usage' }).url).toBe('https://seedvis.com/api/v1/account/usage')
    expect(rules.matchSeedvisRoute({ route: 'generations.create' })).toMatchObject({ method: 'POST', lane: 'submit', url: 'https://seedvis.com/api/v1/developer/generations' })
    expect(rules.matchSeedvisRoute({ route: 'generations.get', id: 'gen_1-A' })).toMatchObject({ method: 'GET', url: 'https://seedvis.com/api/v1/developer/generations/gen_1-A?wait=0', hasId: true })
    expect(rules.matchSeedvisRoute({ route: 'generations.cancel', id: 'x' })).toMatchObject({ method: 'POST', url: 'https://seedvis.com/api/v1/developer/generations/x/cancel' })
  })

  it.each([
    [{ route: 'generations.get' }],
    [{ route: 'generations.get', id: '' }],
    [{ route: 'generations.get', id: '../account/info' }],
    [{ route: 'generations.get', id: 'a%2Fb' }],
    [{ route: 'generations.get', id: 'a?wait=60' }],
    [{ route: 'generations.get', id: 'x'.repeat(101) }],
    [{ route: 'models', id: 'x' }],
    [{ route: 'images.generations' }],
    [{ route: '__proto__' }],
    [{ route: 'constructor' }],
    [{ route: 'toString' }],
    [{ path: '/models' }],
    [null],
    ['models'],
    [['models']],
  ])('refuses %j', (req) => {
    expect(rules.matchSeedvisRoute(req)).toBeNull()
  })

  it('webRequest layer: exact origin, /api/v1, the route method, ?wait=0 exactly on a poll and no other query', () => {
    const ok: [string, string, string][] = [
      ['GET', 'https://seedvis.com/api/v1/models', 'models'],
      ['GET', 'https://seedvis.com/api/v1/account/info', 'account.info'],
      ['GET', 'https://seedvis.com/api/v1/account/usage', 'account.usage'],
      ['POST', 'https://seedvis.com/api/v1/developer/generations', 'generations.create'],
      ['GET', 'https://seedvis.com/api/v1/developer/generations/abc?wait=0', 'generations.get'],
      ['POST', 'https://seedvis.com/api/v1/developer/generations/abc/cancel', 'generations.cancel'],
      ['GET', 'https://SEEDVIS.com:443/api/v1/models', 'models'],
    ]
    for (const [m, u, name] of ok) expect(rules.matchSeedvisUrl(m, u), u).toBe(name)
    for (const [m, u] of [
      ['GET', 'http://seedvis.com/api/v1/models'],
      ['GET', 'https://cdn.seedvis.com/api/v1/models'],
      ['GET', 'https://seedvis.com.evil.example/api/v1/models'],
      ['GET', 'https://seedvis.com:8443/api/v1/models'],
      ['GET', 'https://user:pw@seedvis.com/api/v1/models'],
      ['GET', 'https://seedvis.com/api/v1/models?x=1'],
      ['GET', 'https://seedvis.com/api/v1/models#x'],
      ['POST', 'https://seedvis.com/api/v1/models'],
      ['GET', 'https://seedvis.com/api/v1/developer/generations/abc'],
      ['GET', 'https://seedvis.com/api/v1/developer/generations/abc?wait=60'],
      ['GET', 'https://seedvis.com/api/v1/developer/generations/abc?wait=0&x=1'],
      ['POST', 'https://seedvis.com/api/v1/developer/generations/abc/cancel?x=1'],
      ['GET', 'https://seedvis.com/api/v1/../v1/models/x'],
      ['POST', 'https://seedvis.com/api/v1/images/generations'],
      ['POST', 'https://seedvis.com/api/v1/google/v1beta/interactions'],
      ['GET', 'https://seedvis.com/api/v1/mcp/KEY'],
      ['GET', 'https://seedvis.com/'],
      ['GET', 'not a url'],
    ]) {
      expect(rules.matchSeedvisUrl(m, u), `${m} ${u}`).toBeNull()
    }
  })
})

describe('the API key header goes to exactly https://seedvis.com', () => {
  it('authHeadersAllowed: exact origin only (no cdn.seedvis.com, no suffix match, no port, no http, no credentials)', () => {
    expect(rules.authHeadersAllowed('https://seedvis.com/api/v1/models')).toBe(true)
    for (const u of [
      'https://cdn.seedvis.com/result.mp4',
      'https://api.seedvis.com/x',
      'https://seedvis.com.cdn.example/x',
      'https://evilseedvis.com/x',
      'http://seedvis.com/api/v1/models',
      'https://seedvis.com:8443/api/v1/models',
      'https://u:p@seedvis.com/api/v1/models',
      'https://storage.googleapis.com/x',
      '',
      'garbage',
    ]) {
      expect(rules.authHeadersAllowed(u), u).toBe(false)
    }
  })

  it('headersToStrip: Cookie / X-API-Key / x-goog-api-key always; Authorization off-origin (case-insensitive)', () => {
    const names = ['Authorization', 'X-API-Key', 'x-goog-api-key', 'Cookie', 'Accept', 'Range']
    expect(rules.headersToStrip('https://cdn.seedvis.com/r.mp4', names).sort()).toEqual(['Authorization', 'Cookie', 'X-API-Key', 'x-goog-api-key'].sort())
    expect(rules.headersToStrip('https://seedvis.com/api/v1/models', names).sort()).toEqual(['Cookie', 'X-API-Key', 'x-goog-api-key'].sort())
    expect(rules.headersToStrip('https://other.example/r.mp4', ['AUTHORIZATION', 'cookie'])).toEqual(['AUTHORIZATION', 'cookie'])
  })

  it('webRequestVerdict: allowlisted API routes, and GETs of recorded download URLs only', () => {
    const recorded = new Set(['https://cdn.seedvis.com/r.mp4?sig=1'])
    const isDl = (u: string) => recorded.has(u)
    expect(rules.webRequestVerdict({ method: 'GET', url: 'https://seedvis.com/api/v1/models' }, isDl)).toBe('allow')
    expect(rules.webRequestVerdict({ method: 'GET', url: 'https://cdn.seedvis.com/r.mp4?sig=1' }, isDl)).toBe('allow')
    expect(rules.webRequestVerdict({ method: 'POST', url: 'https://cdn.seedvis.com/r.mp4?sig=1' }, isDl)).toBe('cancel')
    expect(rules.webRequestVerdict({ method: 'GET', url: 'https://cdn.seedvis.com/other.mp4' }, isDl)).toBe('cancel')
    expect(rules.webRequestVerdict({ method: 'GET', url: 'https://example.com/' }, isDl)).toBe('cancel')
    // even a "recorded" URL must be a public https one
    for (const u of ['http://cdn.seedvis.com/r.mp4', 'https://127.0.0.1/r.mp4', 'https://cdn.seedvis.com:8080/r.mp4']) {
      expect(rules.webRequestVerdict({ method: 'GET', url: u }, () => true), u).toBe('cancel')
    }
  })
})

describe('submit allowlist (checkSubmit) and the body (buildSubmitJson)', () => {
  const ok = (req: Any) => {
    const r = rules.checkSubmit(req)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    return r.value
  }
  const refuse = (req: Any, code = 'bad-request') => {
    const r = rules.checkSubmit(req)
    expect(r.ok).toBe(false)
    expect(r.code).toBe(code)
    expect(r.message).toMatch(/chưa gửi gì|không bị trừ|không dùng|không hợp lệ/)
    return r
  }

  it('accepts every model × mode with the right images', () => {
    ok(createReq())
    ok(createReq({ body: seedanceBody({ model: 'seedance_2.5', duration: 30, aspect_ratio: '21:9' }) }))
    ok(createReq({ body: seedanceBody({ mode: 'image-to-video' }), images: Array.from({ length: 10 }, (_, i) => ({ field: 'reference_images', index: i, mime: 'image/png', bytes: png() })) }))
    ok(createReq({ body: veoBody() }))
    ok(createReq({ body: veoBody({ mode: 'image-to-video', upscale_video: '1080p', duration: '8s', aspect_ratio: '16:9' }), images: [{ field: 'image', index: 0, mime: 'image/jpeg', bytes: jpeg() }] }))
    ok(createReq({ body: veoBody({ mode: 'multi-image-to-video' }), images: [0, 1, 2].map((i) => ({ field: 'referenceImages', index: i, mime: 'image/webp', bytes: webp() })) }))
    ok(createReq({ body: veoBody({ mode: 'batch-frame' }), images: [{ field: 'lastFrame', index: 0, mime: 'image/png', bytes: png() }, { field: 'image', index: 0, mime: 'image/png', bytes: png() }] }))
    ok(createReq({ mustFinishBy: 1_800_000_000_000 }))
  })

  it('refuses Omni Flash, other models, count ≠ 1, video / mask / webhook / callback / aliases / unknown keys', () => {
    expect(refuse(createReq({ body: seedanceBody({ model: 'Omni-Flash' }) })).message).toContain('Omni Flash')
    refuse(createReq({ body: seedanceBody({ model: 'gpt-image-2' }) }))
    refuse(createReq({ body: seedanceBody({ model: 'seedvis/seedance_2.5' }) }))
    refuse(createReq({ body: seedanceBody({ count: 2 }) }))
    refuse(createReq({ body: seedanceBody({ count: '1' }) }))
    for (const k of ['video', 'mask', 'webhook', 'webhook_url', 'callback', 'callback_url', 'reference_images', 'images', 'image', 'image_url', 'lastFrame', 'start_image', 'end_image', 'referenceImages', 'content', 'input', 'resolution', 'generate_audio', 'n', '__proto__x']) {
      const body: Any = seedanceBody()
      body[k] = 'x'
      expect(refuse(createReq({ body })).message, k).toMatch(/không gửi trường|không hợp lệ/)
    }
    const proto = JSON.parse('{"model":"seedance_2.0_fast","mode":"text-to-video","prompt":"p","aspect_ratio":"16:9","duration":5,"count":1,"__proto__":{"x":1}}')
    refuse(createReq({ body: proto }))
    refuse({ ...createReq(), path: '/x' })
    refuse({ ...createReq(), headers: { Authorization: 'x' } })
  })

  it('refuses a missing / wrong mode, duration, ratio, upscale, prompt', () => {
    refuse(createReq({ body: seedanceBody({ mode: undefined }) }))
    refuse(createReq({ body: seedanceBody({ mode: 'multi-image-to-video' }) }))
    refuse(createReq({ body: seedanceBody({ duration: '5' }) }))
    refuse(createReq({ body: seedanceBody({ duration: 20 }) })) // 2.0 fast: 5 / 10 / 15
    refuse(createReq({ body: seedanceBody({ aspect_ratio: '2:1' }) }))
    refuse(createReq({ body: seedanceBody({ upscale_video: 'none' }) }))
    refuse(createReq({ body: veoBody({ duration: 8 }) }))
    refuse(createReq({ body: veoBody({ aspect_ratio: '1:1' }) }))
    refuse(createReq({ body: veoBody({ upscale_video: undefined }) }))
    refuse(createReq({ body: veoBody({ upscale_video: '4k' }) }))
    refuse(createReq({ body: seedanceBody({ prompt: '   ' }) }))
    refuse(createReq({ body: seedanceBody({ prompt: 'x'.repeat(20_001) }) }))
    refuse(createReq({ body: seedanceBody({ prompt: 5 }) }))
    refuse(createReq({ body: null }))
    refuse(createReq({ body: [] }))
  })

  it('refuses images of the wrong field / count / index, or not what they claim to be', () => {
    const i2v = seedanceBody({ mode: 'image-to-video' })
    refuse(createReq({ body: i2v })) // image-to-video needs ≥ 1
    refuse(createReq({ images: [{ field: 'reference_images', index: 0, mime: 'image/png', bytes: png() }] })) // text-to-video takes none
    refuse(createReq({ body: i2v, images: [{ field: 'referenceImages', index: 0, mime: 'image/png', bytes: png() }] }))
    refuse(createReq({ body: i2v, images: [{ field: 'reference_images', index: 1, mime: 'image/png', bytes: png() }] })) // gap
    refuse(createReq({ body: i2v, images: [0, 0].map((i) => ({ field: 'reference_images', index: i, mime: 'image/png', bytes: png() })) }))
    refuse(createReq({ body: i2v, images: Array.from({ length: 11 }, (_, i) => ({ field: 'reference_images', index: i, mime: 'image/png', bytes: png() })) }))
    refuse(createReq({ body: veoBody({ mode: 'multi-image-to-video' }), images: [0, 1, 2, 3].map((i) => ({ field: 'referenceImages', index: i, mime: 'image/png', bytes: png() })) }))
    refuse(createReq({ body: veoBody({ mode: 'batch-frame' }), images: [{ field: 'image', index: 0, mime: 'image/png', bytes: png() }] }))
    refuse(createReq({ body: veoBody({ mode: 'image-to-video' }), images: [{ field: 'image', index: 0, mime: 'image/png', bytes: png(), extra: 1 }] }))
    refuse(createReq({ body: i2v, images: [{ field: 'reference_images', index: 0, mime: 'image/png', bytes: [1, 2, 3] }] }))
    // the bytes decide: a JPEG labelled PNG, a GIF, a too-big image
    expect(refuse(createReq({ body: i2v, images: [{ field: 'reference_images', index: 0, mime: 'image/png', bytes: jpeg() }] }), 'bad-image').message).toContain('@image_1')
    const gif = new Uint8Array(32)
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    refuse(createReq({ body: i2v, images: [{ field: 'reference_images', index: 0, mime: 'image/gif', bytes: gif }] }), 'bad-image')
    const big = png(20 * MIB + 1)
    expect(refuse(createReq({ body: i2v, images: [{ field: 'reference_images', index: 0, mime: 'image/png', bytes: big }] }), 'bad-image').message).toContain('20 MB')
    expect(refuse(createReq({ body: veoBody({ mode: 'image-to-video' }), images: [{ field: 'image', index: 0, mime: 'image/webp', bytes: png() }] }), 'bad-image').message).toContain('khung đầu')
  })

  it('counts the base64 text against 39 MiB (prepared budget below seedvis’ 40 MiB)', () => {
    const i2v = seedanceBody({ mode: 'image-to-video' })
    const each = Math.floor(((39 * MIB) / 2) * 0.75) // two images whose base64 fits exactly
    const fit = [0, 1].map((i) => ({ field: 'reference_images', index: i, mime: 'image/png', bytes: png(each - (each % 3)) }))
    expect(rules.checkSubmit(createReq({ body: i2v, images: fit })).ok).toBe(true)
    const over = [0, 1].map((i) => ({ field: 'reference_images', index: i, mime: 'image/png', bytes: png(each + 3) }))
    expect(rules.checkSubmit(createReq({ body: i2v, images: over })).code).toBe('too-large')
    expect(rules.base64Length(0)).toBe(0)
    expect(rules.base64Length(1)).toBe(4)
    expect(rules.base64Length(3)).toBe(4)
    expect(rules.base64Length(4)).toBe(8)
  })

  it('refuses a key that is not a canonical lowercase UUID, and an odd mustFinishBy', () => {
    for (const k of [undefined, '', 'abc', UUID.toUpperCase(), `${UUID}x`, '407822d1ff7444a5b9399e563102e770']) refuse(createReq({ idempotencyKey: k }))
    for (const m of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1700000000000']) refuse(createReq({ mustFinishBy: m }))
  })

  it('builds the body in a fixed key order with scene-neutral file names; same input → same bytes', () => {
    const v = ok(
      createReq({
        body: { count: 1, upscale_video: 'none', duration: '4s', aspect_ratio: '16:9', prompt: 'P @image_1', mode: 'batch-frame', model: 'Veo-3.1' },
        images: [
          { field: 'lastFrame', index: 0, mime: 'image/webp', bytes: webp() },
          { field: 'image', index: 0, mime: 'image/jpeg', bytes: jpeg() },
        ],
      }),
    )
    const text = rules.buildSubmitJson(v, b64)
    expect(text).toBe(
      JSON.stringify({
        model: 'Veo-3.1',
        mode: 'batch-frame',
        prompt: 'P @image_1',
        aspect_ratio: '16:9',
        duration: '4s',
        upscale_video: 'none',
        count: 1,
        image: { data: b64(jpeg()), file_name: 'frame_first.jpg' },
        lastFrame: { data: b64(webp()), file_name: 'frame_last.webp' },
      }),
    )
    expect(rules.buildSubmitJson(v, b64)).toBe(text)
    const s = ok(createReq({ body: seedanceBody({ mode: 'image-to-video' }), images: [1, 0].map((i) => ({ field: 'reference_images', index: i, mime: 'image/png', bytes: png(20 + i) })) }))
    const parsed = JSON.parse(rules.buildSubmitJson(s, b64))
    expect(Object.keys(parsed)).toEqual(['model', 'mode', 'prompt', 'aspect_ratio', 'duration', 'count', 'reference_images'])
    expect(parsed.reference_images.map((i: Any) => i.file_name)).toEqual(['image_1.png', 'image_2.png'])
    expect(parsed.reference_images[0].data).toBe(b64(png(20)))
    expect(parsed).not.toHaveProperty('upscale_video')
  })

  it('sniffs images and videos by their bytes', () => {
    expect(rules.sniffImage(png())).toBe('image/png')
    expect(rules.sniffImage(jpeg())).toBe('image/jpeg')
    expect(rules.sniffImage(webp())).toBe('image/webp')
    expect(rules.sniffImage(new Uint8Array(5))).toBeNull()
    expect(rules.sniffImage('PNG')).toBeNull()
    expect(rules.sniffMedia(mp4(64, 'isom'))).toBe('video/mp4')
    expect(rules.sniffMedia(mp4(64, 'mp42'))).toBe('video/mp4')
    expect(rules.sniffMedia(mp4(64, 'qt'))).toBe('video/quicktime')
    const ebml = new Uint8Array(32)
    ebml.set([0x1a, 0x45, 0xdf, 0xa3])
    expect(rules.sniffMedia(ebml)).toBe('video/webm')
    expect(rules.sniffMedia(Buffer.from('<!doctype html><html>maintenance</html>'))).toBeNull()
    expect(rules.sniffMedia(new Uint8Array(8))).toBeNull()
  })
})

describe('answers: outputs, redaction, sanitizing, headers, Retry-After', () => {
  it('outputUrlAllowed: https, default port, no credentials, a public DNS name (never an IP / local name)', () => {
    for (const u of ['https://cdn.seedvis.com/result.mp4?Expires=1&Signature=x', 'https://cdn.seedvis.com:443/r.mp4', 'https://d1234.cloudfront.net/a/b.mp4', 'https://xn--bcher-kva.example/v.mp4']) {
      expect(rules.outputUrlAllowed(u), u).toBe(true)
    }
    for (const u of [
      'http://cdn.seedvis.com/r.mp4',
      'https://cdn.seedvis.com:8443/r.mp4',
      'https://user:pw@cdn.seedvis.com/r.mp4',
      'https://localhost/r.mp4',
      'https://foo.localhost/r.mp4',
      'https://nas.local/r.mp4',
      'https://intranet/r.mp4',
      'https://127.0.0.1/r.mp4',
      'https://10.0.0.5/r.mp4',
      'https://192.168.1.2/r.mp4',
      'https://169.254.169.254/latest/meta-data',
      'https://8.8.8.8/r.mp4',
      'https://2130706433/r.mp4',
      'https://0x7f000001/r.mp4',
      'https://[::1]/r.mp4',
      'https://[fe80::1]/r.mp4',
      'https://metadata.google.internal/x',
      'file:///C:/x.mp4',
      'data:video/mp4;base64,AAAA',
      'https://cdn.seedvis.com/r .mp4',
      'https://cdn.seedvis.com/\\x',
      `https://cdn.seedvis.com/${'a'.repeat(5000)}`,
      42,
    ]) {
      expect(rules.outputUrlAllowed(u), String(u)).toBe(false)
    }
  })

  it('outputsOf: the job id and the allowed result URLs of a generation answer', () => {
    expect(rules.outputsOf(completed('gen_9'))).toEqual({ id: 'gen_9', urls: ['https://cdn.seedvis.com/result.mp4?Expires=1&Signature=abc'] })
    expect(rules.outputsOf(queued202('gen_9'))).toEqual({ id: 'gen_9', urls: [] })
    expect(rules.outputsOf({ data: { id: 'x/y', outputs: [{ url: 'https://cdn.seedvis.com/a.mp4' }] } })).toEqual({ id: null, urls: ['https://cdn.seedvis.com/a.mp4'] })
    expect(rules.outputsOf({ data: { id: 'g', outputs: [{ url: 'http://cdn.seedvis.com/a.mp4' }, { url: 5 }, null, 'https://x.example/b.mp4', { url: 'https://x.example/c.mp4' }] } }).urls).toEqual(['https://x.example/c.mp4'])
    expect(rules.outputsOf({ data: { id: 'g', outputs: Array.from({ length: 20 }, (_, i) => ({ url: `https://x.example/${i}.mp4` })) } }).urls).toHaveLength(8)
    expect(rules.outputsOf(null)).toEqual({ id: null, urls: [] })
    expect(rules.outputsOf({ data: [] })).toEqual({ id: null, urls: [] })
  })

  it('redactSecrets: the exact stored key (any shape), Bearer, sv_live_ / sv_test_, header values, signed URL queries', () => {
    const odd = 'Zq9-unusualKEYwithoutPrefix_123456'
    const s = rules.redactSecrets(
      `key ${odd} | Bearer abc.def-ghi | sv_live_${'A'.repeat(30)} | sv_test_xyz | "Authorization": "Bearer q" | X-API-Key: k1\nCookie: a=1; b=2\nhttps://cdn.seedvis.com/r.mp4?Expires=1&Signature=SIG#frag | ok`,
      odd,
    )
    expect(s).not.toContain(odd)
    expect(s).not.toMatch(/abc\.def|AAAA|xyz|k1|a=1|b=2|SIG|Expires|frag/)
    expect(s).toContain('https://cdn.seedvis.com/r.mp4')
    expect(s).toContain('Bearer ***')
    expect(s).toContain('sv_live_***')
    expect(s.endsWith('| ok')).toBe(true)
    expect(rules.redactSecrets('x'.repeat(5000))).toHaveLength(2000)
    expect(rules.redactSecrets(undefined)).toBe('')
  })

  it('sanitizeApiJson: deep copy, every string redacted, the original untouched', () => {
    const src = completed('gen_1')
    const before = JSON.stringify(src)
    const out = rules.sanitizeApiJson({ ...src, echo: `prompt with ${FAKE_KEY}` }, FAKE_KEY)
    expect(JSON.stringify(src)).toBe(before)
    expect(out.data.outputs[0].url).toBe('https://cdn.seedvis.com/result.mp4')
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(out)).not.toContain('Signature')
    let deep: Any = 'leaf'
    for (let i = 0; i < 40; i++) deep = { d: deep }
    expect(JSON.stringify(rules.sanitizeApiJson(deep))).toContain('null')
  })

  it('sanitizeAccountInfo / Usage: only the allowlisted fields — never the e-mail or the account id', () => {
    const info = rules.sanitizeAccountInfo(accountInfo())
    expect(info).toEqual({
      success: true,
      data: { plan: 'Pro', api_enabled: true, credit_balance: 1200, concurrency_limit: 16, queue_limit: 32, rate_limit_per_minute: 120, poll_rate_limit_per_minute: 384, poll_rate_limit_per_job_per_minute: 20 },
    })
    expect(JSON.stringify(info)).not.toMatch(/example\.com|"id"|42/)
    expect(rules.sanitizeAccountInfo(accountInfo({ credit_balance: '1200.50', plan: 'basic', concurrency_limit: -1, queue_limit: 'many', extra: 'x' })).data).toEqual({
      plan: 'basic',
      api_enabled: true,
      credit_balance: 1200.5,
      rate_limit_per_minute: 120,
      poll_rate_limit_per_minute: 384,
      poll_rate_limit_per_job_per_minute: 20,
    })
    expect(rules.sanitizeAccountInfo({ data: { plan: { code: 'free' }, credit_balance: Number.NaN } }).data).toEqual({ plan: 'free' })
    expect(rules.sanitizeAccountInfo('x')).toEqual({ success: false, data: {} })
    const usage = rules.sanitizeAccountUsage({ success: true, data: { requests_today: 12, requests_this_month: 248, requests_total: 1024, by_status: { completed: 1000, failed: 24, 'bad key': 1 }, credit_balance: 1200, email: 'x@y.z' } })
    expect(usage).toEqual({ success: true, data: { requests_today: 12, requests_this_month: 248, requests_total: 1024, credit_balance: 1200, by_status: { completed: 1000, failed: 24 } } })
  })

  it('pickResponseHeaders: only Retry-After, Idempotency-Replayed, X-Request-Id, strictly shaped', () => {
    const h: Record<string, string> = { 'retry-after': '30', 'idempotency-replayed': 'TRUE', 'x-request-id': 'req_01HX:9', 'set-cookie': 'a=1', authorization: 'x' }
    expect(rules.pickResponseHeaders((n: string) => h[n] ?? null)).toEqual({ 'Retry-After': '30', 'Idempotency-Replayed': 'true', 'X-Request-Id': 'req_01HX:9' })
    expect(rules.pickResponseHeaders((n: string) => ({ 'retry-after': '<script>', 'x-request-id': 'a b' })[n] ?? null)).toEqual({})
    expect(rules.pickResponseHeaders(() => {
      throw new Error('x')
    })).toEqual({})
  })

  it('parseRetryAfter: seconds or an HTTP date, clamped to 1–300 s', () => {
    expect(rules.parseRetryAfter('2', 0)).toBe(2000)
    expect(rules.parseRetryAfter('0', 0)).toBe(1000)
    expect(rules.parseRetryAfter('100000', 0)).toBe(300_000)
    const now = Date.UTC(2026, 9, 7, 10, 0, 0)
    expect(rules.parseRetryAfter('Wed, 07 Oct 2026 10:00:30 GMT', now)).toBe(30_000)
    expect(rules.parseRetryAfter('Wed, 07 Oct 2026 09:00:00 GMT', now)).toBe(1000)
    for (const v of ['', 'soon', '1.5', '-3', null, undefined, 'x'.repeat(80)]) expect(rules.parseRetryAfter(v, now), String(v)).toBeNull()
  })

  it('logLine: fixed words and numbers only', () => {
    expect(rules.logLine('generations.create', 202, 1234.4)).toBe('[SanoVids] seedvis generations.create 202 1234ms')
    expect(rules.logLine('generations.get', 'rate-limited', 5)).toBe('[SanoVids] seedvis generations.get rate-limited 5ms')
    expect(rules.logLine('https://seedvis.com/x?k=1', `Bearer ${FAKE_KEY}`, -1)).toBe('[SanoVids] seedvis request error 0ms')
  })
})

describe('the upload clock (when a submit may have reached seedvis)', () => {
  const base = { stallMs: 60_000, answerWaitMs: 45_000, noProgressBps: 32 * 1024 }
  const p = (current: number, total: number, started = true) => ({ active: true, started, current, total })

  it('complete upload: answer wait 45 s after the last byte; lastByteAt is a lower bound, uploadMs an upper bound', () => {
    const total = 4 * MIB
    const c = rules.createUploadClock({ ...base, total, startedAt: 0 })
    c.sample(p(0, total, false), 250)
    c.sample(p(MIB, total), 500)
    c.sample(p(3 * MIB, total), 750)
    c.sample(p(total, total), 1000) // the last byte left between 750 and 1000
    expect(c.lastByteAt()).toBeLessThanOrEqual(750)
    expect(c.uploadMs(1000)).toBeGreaterThanOrEqual(1000)
    expect(c.check(1000 + 44_999)).toBeNull()
    expect(c.check(1000 + 45_000)).toBe('answer-timeout')
    expect(c.abortSent(p(total, total), 46_000)).toBe(true)
    expect(rules.abortFailure('answer-timeout', true, c.lastByteAt())).toMatchObject({ ok: false, code: 'timeout', sent: true })
  })

  it('a stall (60 s without progress) with most of a big body left: aborted as not sent', () => {
    const total = 30 * MIB
    const c = rules.createUploadClock({ ...base, total, startedAt: 0 })
    c.sample(p(0, total, false), 250)
    c.sample(p(MIB, total), 1000)
    expect(c.check(60_999)).toBeNull()
    expect(c.check(61_000)).toBe('stall')
    const sent = c.abortSent(p(MIB, total), 61_000)
    expect(sent).toBe(false)
    expect(rules.abortFailure('stall', sent, c.lastByteAt())).toEqual({ ok: false, code: 'timeout', message: rules.SEEDVIS_TEXTS.uploadStalled, sent: false })
  })

  it('a small body is never "not sent" on an abort (the network could still push it before the abort lands)', () => {
    const total = 2048
    const c = rules.createUploadClock({ ...base, total, startedAt: 0 })
    c.sample(p(0, total, false), 250)
    expect(c.check(60_250)).toBe('stall')
    expect(c.abortSent(p(0, total, false), 60_250)).toBe(true)
    // nearly done: not "not sent" either
    const d = rules.createUploadClock({ ...base, total: 20 * MIB, startedAt: 0 })
    d.sample(p(20 * MIB - 100_000, 20 * MIB), 1000)
    expect(d.abortSent(p(20 * MIB - 100_000, 20 * MIB), 61_000)).toBe(true)
    // a fast upload stuck near the end: the margin grows with the measured rate
    const f = rules.createUploadClock({ ...base, total: 40 * MIB, startedAt: 0 })
    f.sample(p(30 * MIB, 40 * MIB), 1000) // 30 MiB/s
    expect(f.abortSent(p(30 * MIB, 40 * MIB), 61_000)).toBe(true)
  })

  it('mustFinishBy: the upload is aborted before it completes → deadline, not sent (big body left)', () => {
    const total = 30 * MIB
    const c = rules.createUploadClock({ ...base, total, startedAt: 0, mustFinishBy: 20_000 })
    for (let t = 250, cur = 0; t < 20_000; t += 250, cur += 64 * 1024) c.sample(p(cur, total), t) // 256 KiB/s
    expect(c.check(19_999)).toBeNull()
    expect(c.check(20_000)).toBe('deadline')
    const sent = c.abortSent(p(5 * MIB, total), 20_000)
    expect(sent).toBe(false)
    expect(rules.abortFailure('deadline', sent, c.lastByteAt())).toEqual({ ok: false, code: 'deadline', message: rules.SEEDVIS_TEXTS.deadline, sent: false })
    // once complete, the deadline no longer applies (the body is out): only the answer wait
    const done = rules.createUploadClock({ ...base, total: 1000, startedAt: 0, mustFinishBy: 5_000 })
    done.sample(p(1000, 1000), 1000)
    expect(done.check(6_000)).toBeNull()
    // a deadline abort that may have let the body through is reported as a lost answer, never as "deadline"
    expect(rules.abortFailure('deadline', true, 123)).toMatchObject({ code: 'timeout', sent: true, lastByteAt: 123 })
  })

  it('without progress information: 45 s + bytes ÷ 32 KiB/s, every abort "may have arrived"; lastByteAt null', () => {
    const total = 100 * 32 * 1024 // 100 s at 32 KiB/s
    const c = rules.createUploadClock({ ...base, total, startedAt: 0, mustFinishBy: 10_000 })
    c.sample({ active: false, started: false, current: 0, total: 0 }, 500)
    c.sample(null, 600)
    expect(c.trusted()).toBe(false)
    expect(c.check(10_000)).toBe('deadline')
    expect(c.abortSent({ active: false, started: false, current: 0, total: 0 }, 10_000)).toBe(true)
    const d = rules.createUploadClock({ ...base, total, startedAt: 0 })
    expect(d.check(45_000 + 100_000 - 1)).toBeNull()
    expect(d.check(45_000 + 100_000)).toBe('no-progress-timeout')
    expect(d.lastByteAt()).toBeNull()
    expect(rules.abortFailure('no-progress-timeout', true, null)).toMatchObject({ code: 'timeout', sent: true, lastByteAt: null })
  })

  /** Errors Chromium also reports on an established socket (MapSystemError on a read / write, BoringSSL's catch-all). */
  const MID_STREAM_ERRORS = ['net::ERR_INTERNET_DISCONNECTED', 'net::ERR_ADDRESS_UNREACHABLE', 'net::ERR_SSL_PROTOCOL_ERROR', 'net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_NETWORK_ACCESS_DENIED']
  const SETUP_ERRORS = ['net::ERR_NAME_NOT_RESOLVED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_PROXY_CONNECTION_FAILED']

  it('errors: connection-setup errors before any byte are "not sent"; the clock decides everything else', () => {
    const total = 30 * MIB
    const c = rules.createUploadClock({ ...base, total, startedAt: 0 })
    for (const e of SETUP_ERRORS) expect(c.errorSent(e, 100), e).toBe(false)
    // errors that can also end an established connection prove nothing without a trusted sample
    for (const e of MID_STREAM_ERRORS) expect(c.errorSent(e, 100), e).toBe(true)
    expect(c.errorSent('net::ERR_CONNECTION_RESET', 100)).toBe(true) // nothing trusted yet
    c.sample(p(MIB, total), 1000)
    expect(c.errorSent('net::ERR_CONNECTION_RESET', 1100)).toBe(false) // 29 MiB left
    for (const e of MID_STREAM_ERRORS) expect(c.errorSent(e, 1100), e).toBe(false) // far from complete: not sent
    // a byte was reported: even a "setup" name goes through the clock (here: still far from complete)
    expect(c.errorSent('net::ERR_NAME_NOT_RESOLVED', 1100)).toBe(false)
    c.sample(p(total, total), 2000)
    expect(c.errorSent('net::ERR_CONNECTION_RESET', 2100)).toBe(true)
    expect(rules.netErrorName('Error: net::ERR_TIMED_OUT x')).toBe('ERR_TIMED_OUT')
    expect(rules.offlineNetError('net::ERR_INTERNET_DISCONNECTED')).toBe(true)
    expect(rules.offlineNetError('net::ERR_CONNECTION_RESET')).toBe(false)
  })

  it('anything after a complete upload "may have arrived" — whatever the net error name (small and big bodies)', () => {
    for (const total of [2048, 30 * MIB]) {
      const c = rules.createUploadClock({ ...base, total, startedAt: 0 })
      c.sample(p(0, total, false), 250)
      c.sample(p(total, total), 1000) // body fully uploaded, waiting for the 202
      for (const e of [...MID_STREAM_ERRORS, ...SETUP_ERRORS, 'net::ERR_CONNECTION_RESET', 'net::ERR_NETWORK_CHANGED', 'net::ERR_FAILED', 'odd']) {
        expect(c.errorSent(e, 1100), `${total} ${e}`).toBe(true)
        expect(c.errorSent(e, 60_000), `${total} ${e} later`).toBe(true)
      }
    }
    // the list holds connection-setup errors only
    for (const e of MID_STREAM_ERRORS) expect(rules.PRE_SEND_NET_ERRORS, e).not.toContain(rules.netErrorName(e))
    for (const e of SETUP_ERRORS) expect(rules.preSendNetError(e), e).toBe(true)
  })

  it('a partly sent body near its end is "may have arrived" even with a setup error name', () => {
    const total = 20 * MIB
    const c = rules.createUploadClock({ ...base, total, startedAt: 0 })
    c.sample(p(total - 100_000, total), 1000)
    for (const e of [...SETUP_ERRORS, ...MID_STREAM_ERRORS]) expect(c.errorSent(e, 1100), e).toBe(true)
  })

  it('stale progress reports never move lastByteAt past the real last byte (property, 500 uploads)', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    for (let trial = 0; trial < 500; trial++) {
      const total = 1 + Math.floor(rnd() * 40 * MIB)
      const realEnd = 100 + Math.floor(rnd() * 30_000) // the last byte leaves here
      const c = rules.createUploadClock({ ...base, total, startedAt: 0 })
      let answeredAt = realEnd + Math.floor(rnd() * 2000)
      for (let t = 250; t < answeredAt; t += 250) {
        const reportedAt = Math.max(0, t - Math.floor(rnd() * 900)) // a report up to 900 ms old
        const cur = reportedAt >= realEnd ? total : Math.floor((total * reportedAt) / realEnd)
        c.sample(p(Math.min(cur, total), total), t)
      }
      c.sample({ active: false, started: false, current: 0, total: 0 }, answeredAt) // after the answer: says nothing
      c.answered(answeredAt)
      expect(c.lastByteAt(), `trial ${trial}`).toBeLessThanOrEqual(realEnd)
      expect(c.uploadMs(answeredAt), `trial ${trial}`).toBeGreaterThanOrEqual(realEnd)
      answeredAt = 0
    }
  })
})

describe('close guard verdict (§10.6)', () => {
  it('asks only with sends in flight, on the right hook per platform; never during an update’s quit', () => {
    const v = (o: Any) => rules.closeGuardVerdict({ inFlight: 1, quittingForUpdate: false, confirmed: false, ...o })
    expect(v({ platform: 'win32', phase: 'window-close' })).toBe('ask')
    expect(v({ platform: 'linux', phase: 'window-close' })).toBe('ask')
    expect(v({ platform: 'darwin', phase: 'quit' })).toBe('ask')
    expect(v({ platform: 'darwin', phase: 'window-close' })).toBe('allow') // the close button only hides it there
    expect(v({ platform: 'win32', phase: 'quit' })).toBe('allow') // Windows asks on its window
    expect(v({ platform: 'win32', phase: 'window-close', inFlight: 0 })).toBe('allow')
    expect(v({ platform: 'win32', phase: 'window-close', inFlight: Number.NaN })).toBe('allow')
    expect(v({ platform: 'win32', phase: 'window-close', confirmed: true })).toBe('allow')
    expect(v({ platform: 'win32', phase: 'other' })).toBe('allow')
    for (const platform of ['win32', 'darwin', 'linux']) {
      for (const phase of ['window-close', 'quit']) {
        expect(v({ platform, phase, inFlight: 5, quittingForUpdate: true }), `${platform} ${phase}`).toBe('allow')
      }
    }
    expect(rules.closeGuardVerdict(null)).toBe('allow')
  })

  it('the question: two buttons, “Chờ gửi xong” first and default', () => {
    const d = rules.closeGuardDialog(3)
    expect(d.buttons).toEqual(['Chờ gửi xong', 'Thoát'])
    expect(d.defaultId).toBe(0)
    expect(d.cancelId).toBe(0)
    expect(d.message).toBe('Đang gửi 3 cảnh tới seedvis')
    expect(d.detail).toContain('có thể mất video đã trả tiền')
  })
})

describe('result downloads (createSeedvisDownloads, main’s pump)', () => {
  const stream = (chunks: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(ch)
        c.close()
      },
    })
  const make = (fetch: Any, over: Any = {}) => {
    let active = 0
    let n = 0
    const d = rules.createSeedvisDownloads({
      fetch,
      createPump: mainPump(),
      withSlot: async (fn: Any) => {
        active++
        try {
          return await fn()
        } finally {
          active--
        }
      },
      lookup: (id: string, index: number) => (id === 'gen_1' && index === 0 ? 'https://cdn.seedvis.com/r.mp4?sig=1' : null),
      newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
      setTimer: setTimeout,
      clearTimer: clearTimeout,
      ...over,
    })
    return { d, active: () => active }
  }
  const answer = (status: number, chunks: Uint8Array[], headers: Record<string, string> = {}) => async () => ({
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    body: stream(chunks),
  })

  it('an MP4 sent as application/octet-stream is a video/mp4; pieces in order, then done; the slot is held to the end', async () => {
    const video = mp4(5000)
    const { d, active } = make(answer(200, [video.subarray(0, 10), video.subarray(10)], { 'content-type': 'application/octet-stream', 'content-length': '5000' }))
    const o = await d.open(1, { generationId: 'gen_1', index: 0 })
    expect(o).toMatchObject({ ok: true, total: 5000, mime: 'video/mp4' })
    expect(active()).toBe(1)
    const got: number[] = []
    for (;;) {
      const r = await d.read(1, { id: o.id })
      expect(r.ok).toBe(true)
      if (r.done) break
      got.push(...r.bytes)
    }
    expect(Buffer.from(got)).toEqual(Buffer.from(video))
    expect(active()).toBe(0)
    expect(d.size()).toBe(0)
  })

  it('QuickTime / WebM by their bytes; HTML (a maintenance page) is refused', async () => {
    expect((await make(answer(200, [mp4(100, 'qt')])).d.open(1, { generationId: 'gen_1', index: 0 })).mime).toBe('video/quicktime')
    const ebml = new Uint8Array(100)
    ebml.set([0x1a, 0x45, 0xdf, 0xa3])
    expect((await make(answer(200, [ebml])).d.open(1, { generationId: 'gen_1', index: 0 })).mime).toBe('video/webm')
    const html = make(answer(200, [Buffer.from('<!doctype html><title>Bảo trì</title>')], { 'content-type': 'video/mp4' }))
    expect(await html.d.open(1, { generationId: 'gen_1', index: 0 })).toMatchObject({ ok: false, code: 'bad-response', message: rules.SEEDVIS_TEXTS.notVideo })
    expect(html.active()).toBe(0)
  })

  it('expired links, server errors, oversize, refused redirects, unknown outputs, bad arguments', async () => {
    for (const s of [401, 403, 404, 410]) expect((await make(answer(s, [])).d.open(1, { generationId: 'gen_1', index: 0 })).code, String(s)).toBe('expired-link')
    expect((await make(answer(502, [])).d.open(1, { generationId: 'gen_1', index: 0 })).code).toBe('network')
    expect((await make(answer(200, [mp4()], { 'content-length': String(2 * 1024 * MIB) })).d.open(1, { generationId: 'gen_1', index: 0 })).code).toBe('too-large')
    const refused = make(async () => {
      throw Object.assign(new Error('x'), { code: 'redirect-refused' })
    })
    expect(await refused.d.open(1, { generationId: 'gen_1', index: 0 })).toMatchObject({ ok: false, code: 'bad-response', message: rules.SEEDVIS_TEXTS.downloadRefused })
    expect((await make(answer(200, [mp4()])).d.open(1, { generationId: 'gen_2', index: 0 })).code).toBe('unknown-output')
    for (const a of [{}, { generationId: 'gen_1' }, { generationId: 'gen_1', index: -1 }, { generationId: 'gen_1', index: 8 }, { generationId: '../x', index: 0 }, { url: 'https://x.example/v.mp4' }, null]) {
      expect((await make(answer(200, [mp4()])).d.open(1, a)).code, JSON.stringify(a)).toBe('bad-request')
    }
    // a recorded URL that is not allowed (e.g. plain http) is never fetched
    const fetch = vi.fn(answer(200, [mp4()]))
    const bad = make(fetch, { lookup: () => 'http://cdn.seedvis.com/r.mp4' })
    expect((await bad.d.open(1, { generationId: 'gen_1', index: 0 })).code).toBe('bad-response')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('only the page that opened a download reads or closes it; close / closeAll free the slot', async () => {
    const { d, active } = make(answer(200, [mp4(100)]))
    const o = await d.open(1, { generationId: 'gen_1', index: 0 })
    expect((await d.read(2, { id: o.id })).code).toBe('gone')
    expect(d.close(2, { id: o.id })).toEqual({ ok: true })
    await flush()
    expect(active()).toBe(1)
    d.closeAll(2)
    await flush()
    expect(active()).toBe(1)
    d.closeAll(1)
    await flush()
    expect(active()).toBe(0)
    expect((await d.read(1, { id: o.id })).code).toBe('gone')
    expect((await d.read(1, { id: 'not-a-uuid' })).code).toBe('gone')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The wiring (electron/seedvis.cjs) with a fake Electron
// ---------------------------------------------------------------------------------------------------------------

/** Saves the fake key without a reachable seedvis (the field's check fails on the network, "Lưu mà chưa kiểm tra"). */
async function withKey(h: Harness, key = FAKE_KEY) {
  const r = await saveKeyUnverified(h, key)
  expect(r.ok, JSON.stringify(r)).toBe(true)
}

describe('seedvis.cjs: the partition, the two allowlist layers, the key header', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })
  afterEach(() => h.cleanup())

  it('an in-memory partition with every permission denied', () => {
    expect(h.ses.partition).toBe('sanovids-seedvis')
    let granted: boolean | null = null
    h.ses.permissionRequest(null, 'media', (v: boolean) => (granted = v))
    expect(granted).toBe(false)
    for (const perm of ['clipboard-sanitized-write', 'notifications', 'geolocation', 'fullscreen']) expect(h.ses.permissionCheck(null, perm)).toBe(false)
    expect(h.ses.devicePermission({ deviceType: 'usb' })).toBe(false)
  })

  it('registers exactly the ten channels, all refusing other senders', async () => {
    expect([...h.ipc.handlers.keys()].sort()).toEqual([...seedvisModule.CHANNELS].sort())
    expect(seedvisModule.CHANNELS).toHaveLength(10)
    for (const ch of seedvisModule.CHANNELS) {
      const r = await h.call(ch, {}, 'https://seedvis.com/evil')
      if (ch === 'seedvis:isOnline') expect(r).toBe(false)
      else expect(r, ch).toEqual({ ok: false, code: 'not-allowed', message: rules.SEEDVIS_TEXTS.notAllowed })
    }
    expect(h.net.seen).toHaveLength(0)
  })

  it('API requests carry Authorization only to seedvis.com; the webRequest layer strips it anywhere else', async () => {
    await withKey(h)
    h.net.server = (ctl) => ctl.reply(jsonAnswer(200, { success: true, data: [] }))
    const r = await h.call('seedvis:request', { route: 'models' })
    expect(r).toMatchObject({ ok: true, status: 200 })
    const seen = h.net.seen[0]
    expect(seen.url).toBe('https://seedvis.com/api/v1/models')
    expect(seen.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`)
    expect(seen.options).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error', useSessionCookies: false })
    expect(seen.options.session).toBe(h.ses)
    // the second layer, for any URL and any redirect hop
    const off = h.ses.beforeSendHeaders({ url: 'https://cdn.seedvis.com/r.mp4', method: 'GET', requestHeaders: { Authorization: 'Bearer x', 'X-API-Key': 'k', 'x-goog-api-key': 'g', Cookie: 'c', Accept: '*/*' } })
    expect(off).toEqual({ Accept: '*/*' })
    const on = h.ses.beforeSendHeaders({ url: 'https://seedvis.com/api/v1/models', method: 'GET', requestHeaders: { Authorization: 'Bearer x', Cookie: 'c' } })
    expect(on).toEqual({ Authorization: 'Bearer x' })
    expect(h.ses.beforeRequest({ url: 'https://example.com/', method: 'GET' })).toEqual({ cancel: true })
    expect(h.ses.beforeRequest({ url: 'https://seedvis.com/api/v1/models', method: 'GET' })).toEqual({ cancel: false })
  })

  it('an API redirect is never followed', async () => {
    await withKey(h)
    h.net.server = (ctl) => ctl.redirect('https://seedvis.com/api/v1/account/info')
    expect(await h.call('seedvis:request', { route: 'models' })).toMatchObject({ ok: false, code: 'bad-response', message: rules.SEEDVIS_TEXTS.redirect })
    expect(h.net.seen).toHaveLength(1)
  })

  it('downloads: no secret header on the CDN or any redirect hop; hops checked (https, public, ≤ 3)', async () => {
    await withKey(h)
    const cdn = 'https://cdn.seedvis.com/result.mp4?Expires=1&Signature=abc'
    const hop = 'https://media.example-cdn.net/v/result.mp4?token=t'
    h.net.server = (ctl: Ctl) => {
      if (ctl.req.url.startsWith('https://seedvis.com/')) return ctl.reply(jsonAnswer(200, completed('gen_1', cdn)))
      if (ctl.req.url === cdn) return ctl.redirect(hop)
      if (ctl.req.url === hop) return ctl.reply(incoming(200, { 'content-type': 'application/octet-stream', 'content-length': '300' }, [mp4(300)]))
      ctl.fail('net::ERR_FAILED')
    }
    const polled = await h.call('seedvis:request', { route: 'generations.get', id: 'gen_1' })
    expect(polled.json.data.outputs[0].url).toBe('https://cdn.seedvis.com/result.mp4') // the page never gets a signed URL
    const o = await h.call('seedvis:downloadOpen', { generationId: 'gen_1', index: 0 })
    expect(o).toMatchObject({ ok: true, mime: 'video/mp4', total: 300 })
    const gets = h.net.seen.filter((s) => !s.url.startsWith('https://seedvis.com/'))
    expect(gets.map((s) => s.url)).toEqual([cdn, hop])
    for (const s of gets) {
      expect(Object.keys(s.headers).map((k) => k.toLowerCase())).not.toEqual(expect.arrayContaining(['authorization']))
      for (const k of Object.keys(s.headers)) expect(['authorization', 'x-api-key', 'x-goog-api-key', 'cookie']).not.toContain(k.toLowerCase())
      expect(s.options).toMatchObject({ credentials: 'omit', redirect: 'manual' })
    }
    let bytes = 0
    for (;;) {
      const r = await h.call('seedvis:downloadRead', { id: o.id })
      if (r.done) break
      bytes += r.bytes.byteLength
    }
    expect(bytes).toBe(300)
    expect(h.net.blocked).toEqual([])
  })

  it.each([
    ['http://insecure.example/r.mp4'],
    ['https://127.0.0.1/r.mp4'],
    ['https://nas.local/r.mp4'],
  ])('a redirect to %s is refused before it is sent', async (to) => {
    await withKey(h)
    h.net.server = (ctl: Ctl) => {
      if (ctl.req.url.startsWith('https://seedvis.com/')) return ctl.reply(jsonAnswer(200, completed('gen_1')))
      if (ctl.req.url.startsWith('https://cdn.seedvis.com/')) return ctl.redirect(to)
      ctl.reply(incoming(200, {}, [mp4()]))
    }
    await h.call('seedvis:request', { route: 'generations.get', id: 'gen_1' })
    expect(await h.call('seedvis:downloadOpen', { generationId: 'gen_1', index: 0 })).toMatchObject({ ok: false, code: 'bad-response', message: rules.SEEDVIS_TEXTS.downloadRefused })
    expect(h.net.seen.some((s) => s.url === to)).toBe(false)
  })

  it('more than three redirects are refused', async () => {
    await withKey(h)
    let n = 0
    h.net.server = (ctl: Ctl) => {
      if (ctl.req.url.startsWith('https://seedvis.com/')) return ctl.reply(jsonAnswer(200, completed('gen_1')))
      ctl.redirect(`https://hop${++n}.example-cdn.net/r.mp4`)
    }
    await h.call('seedvis:request', { route: 'generations.get', id: 'gen_1' })
    expect((await h.call('seedvis:downloadOpen', { generationId: 'gen_1', index: 0 })).code).toBe('bad-response')
    expect(n).toBe(4)
    expect(h.net.seen.filter((s) => s.url.includes('example-cdn')).length).toBe(3)
  })

  it('downloads only what a seedvis answer named (unknown job / index → unknown-output, nothing fetched)', async () => {
    await withKey(h)
    expect((await h.call('seedvis:downloadOpen', { generationId: 'gen_x', index: 0 })).code).toBe('unknown-output')
    h.net.server = (ctl) => ctl.reply(jsonAnswer(200, completed('gen_OTHER')))
    await h.call('seedvis:request', { route: 'generations.get', id: 'gen_1' }) // answer about another job: not recorded
    expect((await h.call('seedvis:downloadOpen', { generationId: 'gen_1', index: 0 })).code).toBe('unknown-output')
    expect((await h.call('seedvis:downloadOpen', { generationId: 'gen_OTHER', index: 0 })).code).toBe('unknown-output')
    expect(h.net.seen.filter((s) => !s.url.startsWith('https://seedvis.com/'))).toHaveLength(0)
  })

  it('billing opens the fixed page; isOnline is main’s net.isOnline()', async () => {
    expect(await h.call('seedvis:openBilling')).toEqual({ ok: true })
    expect(h.opened).toEqual([rules.SEEDVIS_BILLING_URL])
    expect(await h.call('seedvis:isOnline')).toBe(true)
    h.net.online = false
    expect(await h.call('seedvis:isOnline')).toBe(false)
  })
})

describe('seedvis.cjs: submits (main never re-sends; every outcome says whether seedvis may have it)', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })
  afterEach(() => h.cleanup())

  it('a 202 queued answer: the exact body, the Idempotency-Key, sanitized JSON, request id, lastByteAt / uploadMs', async () => {
    await withKey(h)
    h.net.server = (ctl) => {
      ctl.progress({ active: true, started: true, current: ctl.req.body.length, total: ctl.req.body.length })
      ctl.reply(jsonAnswer(202, queued202('gen_7'), { 'x-request-id': 'req_1', 'idempotency-replayed': 'false', 'set-cookie': 'a=b' }))
    }
    const req = createReq({ body: seedanceBody({ mode: 'image-to-video' }), images: [{ field: 'reference_images', index: 0, mime: 'image/png', bytes: png(100) }] })
    const r = await h.call('seedvis:request', req)
    expect(r).toMatchObject({ ok: true, status: 202, headers: { 'X-Request-Id': 'req_1', 'Idempotency-Replayed': 'false' } })
    expect(r.json.data.id).toBe('gen_7')
    expect(r.json.data.next.url).toBe('https://seedvis.com/api/v1/developer/generations/gen_7')
    expect(Number.isFinite(r.lastByteAt)).toBe(true)
    expect(Number.isFinite(r.uploadMs)).toBe(true)
    const seen = h.net.seen[0]
    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('https://seedvis.com/api/v1/developer/generations')
    expect(seen.headers).toMatchObject({ 'Idempotency-Key': UUID, 'Content-Type': 'application/json', Authorization: `Bearer ${FAKE_KEY}` })
    const checked = rules.checkSubmit(req)
    expect(seen.body.toString('utf8')).toBe(rules.buildSubmitJson(checked.value, b64))
    expect(JSON.parse(seen.body.toString('utf8')).reference_images[0]).toEqual({ data: b64(png(100)), file_name: 'image_1.png' })
  })

  it('a lost answer after the whole body left → network, sent: true, lastByteAt; no second POST', async () => {
    await withKey(h)
    h.net.server = (ctl) => {
      ctl.progress({ active: true, started: true, current: ctl.req.body.length, total: ctl.req.body.length })
      ctl.fail('net::ERR_CONNECTION_RESET')
    }
    const r = await h.call('seedvis:request', createReq())
    expect(r).toMatchObject({ ok: false, code: 'network', sent: true, message: rules.SEEDVIS_TEXTS.lostAnswer })
    expect('lastByteAt' in r).toBe(true)
    await settle()
    expect(h.net.seen).toHaveLength(1)
  })

  it('an error after seedvis answered is always "may have arrived" (even when progress still said "nothing sent")', async () => {
    await withKey(h)
    h.net.server = (ctl) => {
      ctl.progress({ active: true, started: true, current: 0, total: ctl.req.body.length }) // a stale report
      const res: Any = new Readable({ read() {} })
      res.statusCode = 202
      res.headers = { 'content-type': 'application/json' }
      ctl.reply(res)
      setImmediate(() => h.net.requests[0].emit('error', new Error('net::ERR_CONNECTION_RESET')))
    }
    const imgs = [{ field: 'reference_images', index: 0, mime: 'image/png', bytes: png(10 * MIB) }]
    const r = await h.call('seedvis:request', createReq({ body: seedanceBody({ mode: 'image-to-video' }), images: imgs }))
    expect(r).toMatchObject({ ok: false, code: 'network', sent: true, message: rules.SEEDVIS_TEXTS.lostAnswer })
  })

  it('pre-send failures are "not sent": DNS error, offline, no key, a refused body, a refused route', async () => {
    h.net.server = (ctl) => ctl.fail('net::ERR_NAME_NOT_RESOLVED')
    expect(await h.call('seedvis:request', createReq())).toMatchObject({ ok: false, code: 'no-key', sent: false })
    await withKey(h)
    expect(await h.call('seedvis:request', createReq())).toMatchObject({ ok: false, code: 'network', sent: false, message: rules.SEEDVIS_TEXTS.notSent })
    h.net.online = false
    const before = h.net.seen.length
    expect(await h.call('seedvis:request', createReq())).toMatchObject({ ok: false, code: 'offline', sent: false })
    expect(h.net.seen).toHaveLength(before)
    h.net.online = true
    expect(await h.call('seedvis:request', createReq({ body: seedanceBody({ model: 'Omni-Flash' }) }))).toMatchObject({ ok: false, code: 'bad-request', sent: false })
    expect(await h.call('seedvis:request', { route: 'images.generations' })).toMatchObject({ ok: false, code: 'bad-request' })
    expect(await h.call('seedvis:request', createReq({ mustFinishBy: Date.now() - 1 }))).toMatchObject({ ok: false, code: 'deadline', sent: false })
    expect(h.net.seen).toHaveLength(before)
  })

  it('429 with Retry-After blocks that lane locally (nothing sent until then); other lanes keep going', async () => {
    await withKey(h)
    h.net.server = (ctl) => ctl.reply(jsonAnswer(429, { success: false, code: 'rate_limit_exceeded' }, { 'retry-after': '30' }))
    const first = await h.call('seedvis:request', createReq())
    expect(first).toMatchObject({ ok: true, status: 429, headers: { 'Retry-After': '30' } })
    const second = await h.call('seedvis:request', createReq({ idempotencyKey: '407822d1-ff74-44a5-b939-9e563102e771' }))
    expect(second).toMatchObject({ ok: false, code: 'rate-limited', sent: false })
    expect(second.retryAfterMs).toBeGreaterThan(29_000)
    expect(second.retryAfterMs).toBeLessThanOrEqual(30_000)
    h.net.server = (ctl) => ctl.reply(jsonAnswer(200, { success: true, data: [] }))
    expect((await h.call('seedvis:request', { route: 'models' })).ok).toBe(true)
    expect(h.net.seen.filter((s) => s.method === 'POST')).toHaveLength(1)
  })

  it('account info for the page is sanitized and logs carry no key, no URL, no id', async () => {
    const hp = harness({ packaged: false })
    try {
      await withKey(hp)
      hp.net.server = (ctl) => ctl.reply(jsonAnswer(200, accountInfo()))
      const r = await hp.call('seedvis:request', { route: 'account.info' })
      expect(r.json).toEqual(rules.sanitizeAccountInfo(accountInfo()))
      expect(JSON.stringify(r)).not.toMatch(/example\.com|"id"/)
      hp.net.server = (ctl) => ctl.reply(jsonAnswer(500, { success: false, code: 'server_error', message: `bad ${FAKE_KEY}` }))
      const bad = await hp.call('seedvis:request', { route: 'generations.get', id: 'gen_1' })
      expect(JSON.stringify(bad)).not.toContain(FAKE_KEY)
      expect(hp.logs.length).toBeGreaterThan(0)
      for (const l of hp.logs) {
        expect(l).not.toContain(FAKE_KEY)
        expect(l).not.toMatch(/gen_1|\?|Bearer/)
      }
    } finally {
      hp.cleanup()
    }
  })

  it('packaged builds log failures only, one fixed line each', async () => {
    await withKey(h)
    h.net.server = (ctl) => ctl.reply(jsonAnswer(200, { success: true, data: [] }))
    await h.call('seedvis:request', { route: 'models' })
    expect(h.logs).toEqual([])
    h.net.server = (ctl) => ctl.reply(jsonAnswer(503, { success: false, code: 'server_busy' }))
    await h.call('seedvis:request', { route: 'models' })
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toMatch(/^\[SanoVids\] seedvis models 503 \d+ms$/)
  })
})

describe('seedvis.cjs: timeouts and the same-key deadline (fake timers)', () => {
  let h: Harness
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    h = harness()
  })
  afterEach(() => {
    h.cleanup()
    vi.useRealTimers()
  })
  const tickUntil = async (done: () => boolean, ms: number) => {
    for (let t = 0; t < ms && !done(); t += 250) {
      await vi.advanceTimersByTimeAsync(250)
      await flush()
    }
  }

  it('no answer 45 s after the last byte → timeout, sent: true', async () => {
    await withKey(h)
    h.net.server = (ctl) => ctl.progress({ active: true, started: true, current: ctl.req.body.length, total: ctl.req.body.length }) // never answers
    let r: Any = null
    void h.call('seedvis:request', createReq()).then((x) => (r = x))
    await tickUntil(() => r !== null, 50_000)
    expect(r).toMatchObject({ ok: false, code: 'timeout', sent: true })
    expect(h.net.requests[0].aborted).toBe(true)
  })

  it('a re-send that cannot finish by mustFinishBy is aborted before seedvis has the body → deadline, not sent', async () => {
    await withKey(h)
    const imgs = [0, 1, 2].map((i) => ({ field: 'reference_images', index: i, mime: 'image/png', bytes: png(8 * MIB) }))
    let total = 0
    h.net.server = (ctl) => {
      total = ctl.req.body.length
      ctl.progress({ active: true, started: true, current: 1 * MIB, total }) // stuck far from the end
    }
    let r: Any = null
    void h.call('seedvis:request', createReq({ body: seedanceBody({ mode: 'image-to-video' }), images: imgs, mustFinishBy: Date.now() + 10_000 })).then((x) => (r = x))
    await tickUntil(() => r !== null, 15_000)
    expect(total).toBeGreaterThan(30 * MIB)
    expect(r).toEqual({ ok: false, code: 'deadline', message: rules.SEEDVIS_TEXTS.deadline, sent: false })
    expect(h.net.requests[0].aborted).toBe(true)
  })

  /** A submit whose server reports the body fully uploaded, then fails with `name` once the clock sampled it. */
  async function failAfterUpload(name: string, over: Record<string, unknown>, current?: (total: number) => number) {
    let ctl: Ctl | null = null
    h.net.server = (c) => {
      const total = c.req.body.length
      c.progress({ active: true, started: true, current: current ? current(total) : total, total })
      ctl = c
    }
    let r: Any = null
    void h.call('seedvis:request', createReq(over)).then((x) => (r = x))
    await tickUntil(() => ctl !== null || r !== null, 2000)
    expect(r).toBeNull() // the POST is out
    await vi.advanceTimersByTimeAsync(500) // two progress samples (every 250 ms) reached the clock
    await flush()
    ctl!.fail(name)
    await tickUntil(() => r !== null, 2000)
    return r
  }

  it('the connection drops while waiting for the 202 (body fully uploaded) → lost answer, sent: true — never "offline" / not sent', async () => {
    await withKey(h)
    const names = ['net::ERR_INTERNET_DISCONNECTED', 'net::ERR_ADDRESS_UNREACHABLE', 'net::ERR_SSL_PROTOCOL_ERROR', 'net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_NETWORK_ACCESS_DENIED', 'net::ERR_NAME_NOT_RESOLVED']
    for (const [i, name] of names.entries()) {
      const r = await failAfterUpload(name, { idempotencyKey: `407822d1-ff74-44a5-b939-9e563102e7${10 + i}` })
      expect(r, name).toMatchObject({ ok: false, code: 'network', sent: true, message: rules.SEEDVIS_TEXTS.lostAnswer })
      expect('lastByteAt' in r, name).toBe(true)
    }
    // a body over 30 MiB too
    const imgs = [0, 1, 2].map((i) => ({ field: 'reference_images', index: i, mime: 'image/png', bytes: png(8 * MIB) }))
    const big = await failAfterUpload('net::ERR_INTERNET_DISCONNECTED', { idempotencyKey: '407822d1-ff74-44a5-b939-9e563102e799', body: seedanceBody({ mode: 'image-to-video' }), images: imgs })
    expect(big).toMatchObject({ ok: false, code: 'network', sent: true, message: rules.SEEDVIS_TEXTS.lostAnswer })
    expect(h.net.seen.at(-1)!.body.length).toBeGreaterThan(30 * MIB)
    // main never re-sends: one POST per submit
    expect(h.net.seen.filter((s) => s.method === 'POST')).toHaveLength(names.length + 1)
  })

  it('the connection drops with most of a big body still to upload → offline, not sent (the clock proves it)', async () => {
    await withKey(h)
    const imgs = [0, 1, 2].map((i) => ({ field: 'reference_images', index: i, mime: 'image/png', bytes: png(8 * MIB) }))
    const r = await failAfterUpload('net::ERR_INTERNET_DISCONNECTED', { body: seedanceBody({ mode: 'image-to-video' }), images: imgs }, () => 256 * 1024)
    expect(r).toEqual({ ok: false, code: 'offline', message: rules.SEEDVIS_TEXTS.offline, sent: false })
  })

  it('an upload stalled for 60 s with most of a big body left → timeout, not sent', async () => {
    await withKey(h)
    const imgs = [0, 1].map((i) => ({ field: 'reference_images', index: i, mime: 'image/png', bytes: png(10 * MIB) }))
    h.net.server = (ctl) => ctl.progress({ active: true, started: true, current: 512 * 1024, total: ctl.req.body.length })
    let r: Any = null
    void h.call('seedvis:request', createReq({ body: seedanceBody({ mode: 'image-to-video' }), images: imgs })).then((x) => (r = x))
    await tickUntil(() => r !== null, 70_000)
    expect(r).toMatchObject({ ok: false, code: 'timeout', sent: false, message: rules.SEEDVIS_TEXTS.uploadStalled })
  })

  it('without progress information a timeout is always "may have arrived"', async () => {
    await withKey(h)
    h.net.server = () => undefined // no progress, no answer
    let r: Any = null
    void h.call('seedvis:request', createReq()).then((x) => (r = x))
    await tickUntil(() => r !== null, 50_000)
    expect(r).toMatchObject({ ok: false, code: 'timeout', sent: true, lastByteAt: null })
  })
})

describe('seedvis.cjs: close guard (§10.6)', () => {
  let h: Harness
  let release: (() => void) | null = null
  const ev = () => {
    const e = { prevented: false, preventDefault: () => void (e.prevented = true) }
    return e
  }
  const stuckServer = (ctl: Ctl) => {
    ctl.progress({ active: true, started: true, current: ctl.req.body.length, total: ctl.req.body.length })
    release = () => ctl.reply(jsonAnswer(202, queued202('gen_q')))
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })
  afterEach(() => {
    h.cleanup()
    vi.useRealTimers()
    release = null
  })

  it('“Chờ gửi xong”: new submits refused (not sent), the window closes once the last answer is in (after a grace)', async () => {
    h = harness()
    await withKey(h)
    h.net.server = stuckServer
    let first: Any = null
    void h.call('seedvis:request', createReq()).then((x) => (first = x))
    await settle()
    expect(h.gw.inFlightSubmits()).toBe(1)
    let answer: (v: { response: number }) => void = () => undefined
    h.dialog.answer = () => new Promise((resolve) => (answer = resolve))
    const e = ev()
    expect(h.gw.closeGuard(e, { phase: 'window-close', win: h.win, quittingForUpdate: false })).toBe(true)
    expect(e.prevented).toBe(true)
    expect(h.dialog.asked).toHaveLength(1)
    expect(h.dialog.asked[0].win).toBe(h.win)
    expect(h.dialog.asked[0].opts.message).toBe('Đang gửi 1 cảnh tới seedvis')
    // a second close while the question is open: vetoed, no second question
    expect(h.gw.closeGuard(ev(), { phase: 'window-close', win: h.win, quittingForUpdate: false })).toBe(true)
    expect(h.dialog.asked).toHaveLength(1)
    answer({ response: 0 })
    await settle()
    const refused = await h.call('seedvis:request', createReq({ idempotencyKey: '407822d1-ff74-44a5-b939-9e563102e771' }))
    expect(refused).toEqual({ ok: false, code: 'busy', message: rules.SEEDVIS_TEXTS.quitting, sent: false })
    expect(h.net.seen).toHaveLength(1)
    expect(h.win.closes).toBe(0)
    release!()
    for (let i = 0; i < 20 && first === null; i++) {
      await vi.advanceTimersByTimeAsync(250)
      await flush()
    }
    expect(first).toMatchObject({ ok: true, status: 202 })
    expect(h.gw.inFlightSubmits()).toBe(0)
    // ≤ 500 ms passed since the answer while the loop above advanced: the close waits QUIT_GRACE_MS from the answer
    await vi.advanceTimersByTimeAsync(seedvisModule.QUIT_GRACE_MS - 600)
    expect(h.win.closes).toBe(0) // the page stores the job id first
    await vi.advanceTimersByTimeAsync(600)
    expect(h.win.closes).toBe(1)
    // the close it triggers is allowed
    expect(h.gw.closeGuard(ev(), { phase: 'window-close', win: h.win, quittingForUpdate: false })).toBe(false)
  })

  it('“Thoát” closes at once; an update’s quit is never vetoed; nothing in flight → no question', async () => {
    h = harness()
    expect(h.gw.closeGuard(ev(), { phase: 'window-close', win: h.win, quittingForUpdate: false })).toBe(false)
    await withKey(h)
    h.net.server = stuckServer
    void h.call('seedvis:request', createReq())
    await settle()
    expect(h.gw.closeGuard(ev(), { phase: 'window-close', win: h.win, quittingForUpdate: true })).toBe(false)
    expect(h.dialog.asked).toHaveLength(0)
    h.dialog.answer = async () => ({ response: 1 })
    expect(h.gw.closeGuard(ev(), { phase: 'window-close', win: h.win, quittingForUpdate: false })).toBe(true)
    await settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.win.closes).toBe(1)
    expect(h.gw.closeGuard(ev(), { phase: 'window-close', win: h.win, quittingForUpdate: false })).toBe(false)
  })

  it('macOS: the window close is left to main (it hides); the quit asks app-modal and quits on “Thoát”', async () => {
    h = harness({ platform: 'darwin' })
    await withKey(h)
    h.net.server = stuckServer
    void h.call('seedvis:request', createReq())
    await settle()
    expect(h.gw.closeGuard(ev(), { phase: 'window-close', win: h.win, quittingForUpdate: false })).toBe(false)
    h.dialog.answer = async () => ({ response: 1 })
    expect(h.gw.closeGuard(ev(), { phase: 'quit', win: null, quittingForUpdate: false })).toBe(true)
    await settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.dialog.asked[0].win).toBeNull()
    expect(h.quits).toBe(1)
  })
})
