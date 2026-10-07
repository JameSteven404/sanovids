// seedvis.com desktop gateway (seedvis plan v3.1 §10): every seedvis request, the encrypted API key and the close
// guard live in the main process. The decisions are pure and tested: ./seedvis-rules.cjs (routes, submit allowlist,
// body, URL / header rules, redaction, upload clock, lanes, downloads, close guard) and ./seedvis-key-rules.cjs (the
// key store). This file wires them to IPC, net.request on a dedicated in-memory partition, safeStorage, the clipboard,
// userData and the native dialog.
//
// The page (window.bdpDesktop.seedvis, electron/preload.cjs) can only: read the key status; ask main to read the key
// from the clipboard ("Dán key" — the key never enters the renderer) or send it once (the fallback field); clear it;
// send a symbolic request (main builds the URL, adds the key, checks every field); pull a finished video in pieces by
// job id + output index (main only fetches URLs it read from a seedvis answer); ask whether the computer is online;
// open the fixed billing page. No IPC ever returns the key. Main never re-sends a submit: a lost answer is reported
// with `sent` and `lastByteAt`, and the page decides.
//
// Never: a URL / header / host from the page, the key in a log / IPC answer / error, cookies or a persistent session
// for seedvis, setCertificateVerifyProc, a renderer beforeunload (the close guard is here), a veto of an update's quit.
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const rules = require('./seedvis-rules.cjs')
const keyRules = require('./seedvis-key-rules.cjs')

const CHANNELS = Object.freeze(
  ['keyStatus', 'pasteKey', 'setKey', 'clearKey', 'request', 'downloadOpen', 'downloadRead', 'downloadClose', 'isOnline', 'openBilling'].map((c) => `seedvis:${c}`),
)
/** After "Chờ gửi xong", the page gets this long to store the last answers (job ids) before the app closes. */
const QUIT_GRACE_MS = 2000

const T = rules.SEEDVIS_TEXTS
const KT = keyRules.SEEDVIS_KEY_TEXTS
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** A response header (lowercase name) of an Electron IncomingMessage, or null. */
function headerOf(res, name) {
  const v = res && res.headers ? res.headers[String(name).toLowerCase()] : undefined
  return v === undefined || v === null ? null : Array.isArray(v) ? v.join(', ') : String(v)
}

/** JSON when the body is a JSON object / array, else undefined (an HTML maintenance page stays undefined). */
function parseJson(text) {
  const s = typeof text === 'string' ? text.trim() : ''
  if (!s || (s[0] !== '{' && s[0] !== '[')) return undefined
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/** The text of an error, ONLY to recognise a Chromium net error name (never returned, never logged). */
const errorText = (e) => String((e && e.message) || e || '')

/** fs.promises.rename with a short retry (Windows: an antivirus may hold the target a moment). */
async function renameRetry(from, to) {
  let last
  for (const wait of [0, 100, 400]) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
    try {
      await fs.promises.rename(from, to)
      return
    } catch (e) {
      last = e
    }
  }
  throw last
}

/**
 * Sets the gateway up (on ready, after the canvasapp gateway). deps: {
 *   isAppSender(event)   main's fromApp: only app://bdp pages may call;
 *   getMainWindow()      the window the close guard's question belongs to;
 *   userDataDir          app.getPath('userData') (the key files);
 *   placement()          appPlacement().kind (texts only);
 *   packaged             main's PACKAGED (packaged builds log errors only);
 *   createPump           main.cjs createDownloadPump (the <canvasapp-downloads> piece pump, shared);
 *   electron?, platform?, now?, setTimer?, clearTimer?, log?   (tests inject fakes)
 * }
 * → { inFlightSubmits(), closeGuard(event, { phase: 'window-close' | 'quit', win?, quittingForUpdate }), dispose() }
 */
function setupSeedvis(deps) {
  const E = deps.electron || require('electron')
  const { ipcMain, net, session, safeStorage, clipboard, dialog, shell, app } = E
  const isAppSender = deps.isAppSender
  const getMainWindow = typeof deps.getMainWindow === 'function' ? deps.getMainWindow : () => null
  const platform = deps.platform || process.platform
  const packaged = deps.packaged === true
  const now = deps.now || Date.now
  const setTimer = deps.setTimer || setTimeout
  const clearTimer = deps.clearTimer || clearTimeout
  const log = deps.log || ((line) => console.warn(line))
  const TIMEOUTS = rules.SEEDVIS_TIMEOUTS
  const LIMITS = rules.SEEDVIS_IPC_LIMITS

  // ---- the partition: in memory, every permission denied, two allowlist layers, no secret header off-origin ----
  const ses = session.fromPartition(rules.SEEDVIS_PARTITION)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  /** Download URLs (and checked redirect hops) a GET is allowed to — main read them from a seedvis answer. */
  const downloadUrls = new Map()
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: rules.webRequestVerdict(details, (u) => downloadUrls.has(u)) !== 'allow' })
  })
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = Object.assign({}, details.requestHeaders)
    for (const name of rules.headersToStrip(details.url, Object.keys(requestHeaders))) delete requestHeaders[name]
    callback({ requestHeaders })
  })

  // ---- the key store (safeStorage, async only; Linux plain-text backend = unavailable) ----
  const keyStore = keyRules.createSeedvisKeyStore({
    crypto: {
      isEncryptionAvailable: async () => (await safeStorage.isAsyncEncryptionAvailable()) && !(platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'),
      encryptStringAsync: (text) => safeStorage.encryptStringAsync(text),
      decryptStringAsync: (bytes) => safeStorage.decryptStringAsync(bytes),
    },
    fsp: fs.promises,
    rename: renameRetry,
    dir: deps.userDataDir,
    join: path.join,
    now,
    sleep: (ms) => new Promise((resolve) => setTimer(resolve, ms)),
    randomBytes: (n) => crypto.randomBytes(n),
    hmacHex: (salt, text) => crypto.createHmac('sha256', salt).update(text, 'utf8').digest('hex'),
    platform,
    placement: deps.placement,
  })
  void keyStore.start()

  const lanes = rules.createSeedvisLanes({ now })
  /** generationId → { urls, at }: the result URLs of the last answers (downloads only ever use these). */
  const outputs = new Map()

  // ---- close guard state ----
  let inFlight = 0 // submits from IPC receipt to answer (waiting for a slot included)
  let quitPending = false // "Chờ gửi xong": no new submit, close once the last answer is in
  let quitConfirmed = false
  let asking = false
  let pendingClose = null

  const online = () => {
    try {
      return net.isOnline() === true
    } catch {
      return true // unknown: let the request say
    }
  }

  function note(route, res, t0) {
    const failed = !res || !res.ok || res.status >= 400
    if (packaged && !failed) return
    log(rules.logLine(route, res && res.ok ? res.status : (res && res.code) || 'error', now() - t0))
  }

  function recordOutputs(json, requestedId) {
    const o = rules.outputsOf(json)
    const id = requestedId || o.id
    if (!id || (requestedId && o.id && o.id !== requestedId) || !o.urls.length) return
    outputs.delete(id)
    outputs.set(id, { urls: o.urls, at: now() })
    while (outputs.size > rules.SEEDVIS_OUTPUTS_MAX) outputs.delete(outputs.keys().next().value)
    if (!packaged) for (const u of o.urls) if (!rules.isKnownCdnHost(u)) log(`[SanoVids] seedvis result host ${rules.hostOf(u)} (not in the documented CDN list)`)
  }

  /** Reads a JSON answer body (≤ 2 MiB, ≤ 30 s) → { text } | { error: 'too-large' | 'network' | 'timeout' }. */
  function readBody(res, stop) {
    return new Promise((resolve) => {
      const parts = []
      let size = 0
      let done = false
      const finish = (r) => {
        if (done) return
        done = true
        clearTimer(timer)
        resolve(r)
      }
      const timer = setTimer(() => {
        finish({ error: 'timeout' })
        stop()
      }, TIMEOUTS.bodyReadMs)
      res.on('data', (chunk) => {
        if (done) return
        size += chunk.length
        if (size > LIMITS.jsonBytes) {
          finish({ error: 'too-large' })
          stop()
        } else parts.push(Buffer.from(chunk))
      })
      res.on('end', () => finish({ text: Buffer.concat(parts).toString('utf8') }))
      res.on('aborted', () => finish({ error: 'network' }))
      res.on('error', () => finish({ error: 'network' }))
    })
  }

  const netOptions = (method, url, redirect) => ({ method, url, session: ses, credentials: 'omit', cache: 'no-store', redirect, bypassCustomProtocolHandlers: true, useSessionCookies: false })

  /** A GET / cancel POST (or the key check) with `key`. Never throws. → { ok: true, status, json?, headers } | failure */
  function apiRequest(o) {
    return new Promise((resolve) => {
      let settled = false
      let req = null
      const abort = () => {
        try {
          if (req) req.abort()
        } catch {
          /* already over */
        }
      }
      const done = (r) => {
        if (settled) return
        settled = true
        clearTimer(timer)
        resolve(r)
      }
      const timer = setTimer(() => {
        abort()
        done(rules.failure('timeout', T.apiTimeout))
      }, o.timeoutMs)
      try {
        req = net.request(netOptions(o.method, o.url, 'error'))
        req.setHeader('Accept', 'application/json')
        if (rules.authHeadersAllowed(o.url)) req.setHeader('Authorization', `Bearer ${o.key}`)
      } catch {
        done(rules.failure('network', T.apiNetwork))
        return
      }
      req.on('redirect', () => {
        abort()
        done(rules.failure('bad-response', T.redirect))
      })
      req.on('response', (res) => {
        void readBody(res, abort).then((b) => {
          if (b.error) return done(rules.failure(b.error === 'too-large' ? 'bad-response' : 'network', b.error === 'too-large' ? T.badResponse : T.apiNetwork))
          done({ ok: true, status: res.statusCode, json: parseJson(b.text), headers: rules.pickResponseHeaders((n) => headerOf(res, n)) })
        })
      })
      req.on('error', (e) => {
        const off = rules.offlineNetError(errorText(e))
        done(rules.failure(off ? 'offline' : 'network', off ? T.offline : T.apiNetwork))
      })
      req.on('abort', () => done(rules.failure('network', T.apiNetwork)))
      req.end()
    })
  }

  /**
   * The submit itself (generations.create): the body in one net.request, upload progress sampled every 250 ms by the
   * pure upload clock (stall 60 s, answer wait 45 s after the last byte, the same-key deadline mustFinishBy). Every
   * outcome says whether seedvis may have the job (`sent`) and the earliest moment the last byte can have left.
   * Main never re-sends. Never throws.
   */
  function postSubmit(o) {
    return new Promise((resolve) => {
      const startedAt = now()
      const clock = rules.createUploadClock({ total: o.body.byteLength, startedAt, mustFinishBy: o.mustFinishBy, stallMs: TIMEOUTS.uploadStallMs, answerWaitMs: TIMEOUTS.answerWaitMs, noProgressBps: TIMEOUTS.noProgressBps })
      let req = null
      let settled = false
      let responded = false // seedvis answered: whatever fails after that, it had the whole body
      let ticker = null
      const progress = () => {
        try {
          return req && typeof req.getUploadProgress === 'function' ? req.getUploadProgress() : null
        } catch {
          return null
        }
      }
      const abort = () => {
        try {
          if (req) req.abort()
        } catch {
          /* already over */
        }
      }
      const done = (r) => {
        if (settled) return
        settled = true
        if (ticker !== null) clearTimer(ticker)
        ticker = null
        resolve(r)
      }
      const tick = () => {
        ticker = null
        if (settled) return
        const t = now()
        clock.sample(progress(), t)
        const reason = clock.check(t)
        if (reason) {
          const sent = reason === 'answer-timeout' || reason === 'no-progress-timeout' ? true : clock.abortSent(progress(), now())
          const lastByteAt = clock.lastByteAt()
          abort()
          done(rules.abortFailure(reason, sent, lastByteAt))
          return
        }
        ticker = setTimer(tick, TIMEOUTS.progressPollMs)
      }
      try {
        req = net.request(netOptions('POST', o.url, 'error'))
        req.setHeader('Accept', 'application/json')
        req.setHeader('Content-Type', 'application/json')
        req.setHeader('Idempotency-Key', o.idempotencyKey)
        if (rules.authHeadersAllowed(o.url)) req.setHeader('Authorization', `Bearer ${o.key}`)
      } catch {
        done(rules.failure('network', T.notSent, { sent: false })) // nothing was written
        return
      }
      req.on('redirect', () => {
        const lastByteAt = clock.lastByteAt()
        abort()
        done(rules.failure('bad-response', T.redirect, { sent: true, lastByteAt }))
      })
      req.on('response', (res) => {
        responded = true
        const t = now()
        clock.sample(progress(), t)
        clock.answered(t)
        if (ticker !== null) clearTimer(ticker)
        ticker = null
        const lastByteAt = clock.lastByteAt()
        const uploadMs = clock.uploadMs(t)
        void readBody(res, abort).then((b) => {
          if (b.error) return done(rules.failure(b.error === 'too-large' ? 'bad-response' : 'network', b.error === 'too-large' ? T.badResponse : T.lostAnswer, { sent: true, lastByteAt }))
          done({ ok: true, status: res.statusCode, json: parseJson(b.text), headers: rules.pickResponseHeaders((n) => headerOf(res, n)), lastByteAt, uploadMs })
        })
      })
      req.on('error', (e) => {
        if (settled) return
        const text = errorText(e)
        const sent = responded || clock.errorSent(text, now())
        if (!sent) {
          const off = rules.offlineNetError(text)
          done(rules.failure(off ? 'offline' : 'network', off ? T.offline : T.notSent, { sent: false }))
          return
        }
        done(rules.failure('network', T.lostAnswer, { sent: true, lastByteAt: clock.lastByteAt() }))
      })
      req.on('abort', () => done(rules.failure('network', T.lostAnswer, { sent: true, lastByteAt: clock.lastByteAt() })))
      ticker = setTimer(tick, TIMEOUTS.progressPollMs)
      try {
        req.end(o.body)
      } catch {
        abort()
        done(rules.failure('network', T.lostAnswer, { sent: true, lastByteAt: clock.lastByteAt() }))
      }
    })
  }

  /** An answer for the page: Retry-After blocks, recorded outputs, sanitized JSON (no key, no signed URL, no e-mail). */
  function finishAnswer(route, lane, res, secret, requestedId) {
    if (!res || !res.ok) return res
    const retry = rules.parseRetryAfter(res.headers['Retry-After'], now())
    if ((res.status === 429 || res.status === 503) && retry !== null) lanes.block(lane, retry)
    const ok2xx = res.status >= 200 && res.status < 300
    let json
    if (res.json === undefined) json = undefined
    else if (ok2xx && route === 'account.info') json = rules.sanitizeAccountInfo(res.json)
    else if (ok2xx && route === 'account.usage') json = rules.sanitizeAccountUsage(res.json)
    else {
      if (ok2xx && (route === 'generations.create' || route === 'generations.get')) recordOutputs(res.json, requestedId)
      json = rules.sanitizeApiJson(res.json, secret)
    }
    const out = { ok: true, status: res.status, headers: res.headers }
    if (json !== undefined) out.json = json
    if (res.lastByteAt === null || Number.isFinite(res.lastByteAt)) out.lastByteAt = res.lastByteAt
    if (Number.isFinite(res.uploadMs)) out.uploadMs = res.uploadMs
    return out
  }

  // ---- submits ----

  async function submitOnce(v, body) {
    inFlight++
    const t0 = now()
    let res
    let key = null
    try {
      const url = rules.matchSeedvisRoute({ route: 'generations.create' }).url
      const blocked = lanes.blockedFor('submit')
      if (blocked > 0) res = rules.failure('rate-limited', T.rateLimited, { sent: false, retryAfterMs: blocked })
      else {
        const k = await keyStore.getKey()
        if (!k.ok) res = rules.failure(k.code, k.message, { sent: false })
        else {
          key = k
          res = await lanes.run(
            'submit',
            async () => {
              if (quitPending) return rules.failure('busy', T.quitting, { sent: false })
              const b = lanes.blockedFor('submit')
              if (b > 0) return rules.failure('rate-limited', T.rateLimited, { sent: false, retryAfterMs: b })
              const wait = lanes.submitWaitMs()
              if (wait > 0) return rules.failure('rate-limited', T.breaker, { sent: false, retryAfterMs: wait })
              if (v.mustFinishBy !== undefined && now() >= v.mustFinishBy) return rules.failure('deadline', T.deadline, { sent: false })
              if (!online()) return rules.failure('offline', T.offline, { sent: false })
              lanes.noteSubmit()
              return postSubmit({ url, key: k.key, idempotencyKey: v.idempotencyKey, body, mustFinishBy: v.mustFinishBy })
            },
            { bytes: body.byteLength },
          )
        }
      }
      const out = finishAnswer('generations.create', 'submit', res, key && key.key, null)
      note('generations.create', out, t0)
      return out
    } catch {
      // unknown state after an internal error: never "not sent"
      return rules.failure('network', T.lostAnswer, { sent: true })
    } finally {
      inFlight--
      maybeFinishQuit()
    }
  }

  async function create(raw) {
    const checked = rules.checkSubmit(raw)
    if (!checked.ok) return rules.failure(checked.code, checked.message, { sent: false })
    if (quitPending) return rules.failure('busy', T.quitting, { sent: false })
    const v = checked.value
    if (v.mustFinishBy !== undefined && now() >= v.mustFinishBy) return rules.failure('deadline', T.deadline, { sent: false })
    const body = Buffer.from(rules.buildSubmitJson(v, (b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64')), 'utf8')
    const hash = crypto.createHash('sha256').update(body).digest('hex')
    // the same key + the same bytes already in flight (a page that asked twice): one request, one answer for both
    const c = lanes.coalesce(v.idempotencyKey, hash, () => submitOnce(v, body))
    if (c.conflict) return rules.failure('idempotency-conflict', T.conflict, { sent: false })
    return c.promise
  }

  async function request(raw) {
    if (isPlainObject(raw) && raw.route === 'generations.create') return create(raw)
    const m = rules.matchSeedvisRoute(raw)
    if (!m) return rules.failure('bad-request', T.badRequest)
    const t0 = now()
    const blocked = lanes.blockedFor(m.lane)
    if (blocked > 0) return rules.failure('rate-limited', T.rateLimited, { retryAfterMs: blocked })
    const k = await keyStore.getKey()
    if (!k.ok) return rules.failure(k.code, k.message)
    const res = await lanes.run(m.lane, async () => {
      const b = lanes.blockedFor(m.lane)
      if (b > 0) return rules.failure('rate-limited', T.rateLimited, { retryAfterMs: b })
      return apiRequest({ method: m.method, url: m.url, key: k.key, timeoutMs: TIMEOUTS.apiMs })
    })
    const out = finishAnswer(m.name, m.lane, res, k.key, m.hasId ? raw.id : null)
    if (out.ok && m.name === 'account.info' && out.status >= 200 && out.status < 300 && out.json) {
      const d = out.json.data
      if (Number.isFinite(d.rate_limit_per_minute)) lanes.setSubmitLimit(d.rate_limit_per_minute)
      if (d.api_enabled !== false) void keyStore.markVerified(k.tag, now())
    }
    note(m.name, out, t0)
    return out
  }

  // ---- the key ----

  /** GET /account/info with a candidate key (not saved yet). → { ok: true } | failure with a fixed text. */
  async function verifyKey(candidate) {
    const url = rules.matchSeedvisRoute({ route: 'account.info' }).url
    const t0 = now()
    const res = await lanes.run('api', () => apiRequest({ method: 'GET', url, key: candidate, timeoutMs: TIMEOUTS.verifyMs }))
    note('account.info', res, t0)
    if (!res.ok) return rules.failure('network', KT.verifyNetwork)
    if (res.status === 401) return rules.failure('bad-key', KT.wrongKey)
    if (res.status === 403) return rules.failure('bad-key', KT.noApi)
    if (res.status === 429 || res.status >= 500) return rules.failure('network', KT.verifyBusy)
    if (res.status < 200 || res.status >= 300) return rules.failure('bad-response', KT.verifyOdd)
    const info = rules.sanitizeAccountInfo(res.json)
    if (info.data.api_enabled === false) return rules.failure('bad-key', KT.noApi)
    if (Number.isFinite(info.data.rate_limit_per_minute)) lanes.setSubmitLimit(info.data.rate_limit_per_minute)
    return { ok: true }
  }

  async function adoptKey(candidate, unverified) {
    let verifiedAt = null
    if (!unverified) {
      const v = await verifyKey(candidate)
      if (!v.ok) return v
      verifiedAt = now()
    }
    const saved = await keyStore.save(candidate, { verifiedAt })
    if (!saved.ok) return rules.failure(saved.code, saved.message)
    return { ok: true, status: keyStore.status() }
  }

  /** "Dán key": main reads the clipboard itself (the key never enters the renderer), then clears it if unchanged. */
  async function pasteKey(arg) {
    let raw = ''
    try {
      raw = clipboard.readText()
    } catch {
      raw = ''
    }
    const candidate = keyRules.normalizeKeyInput(raw)
    if (!candidate) return rules.failure('bad-key', KT.badClipboard)
    const r = await adoptKey(candidate, isPlainObject(arg) && arg.unverified === true)
    if (r.ok) {
      try {
        if (clipboard.readText() === raw) clipboard.clear()
      } catch {
        /* the UI still tells the user to clear Windows clipboard history (Win+V) */
      }
    }
    return r
  }

  /** The fallback field: the key crosses once (then the page clears its field and state). */
  async function setKey(arg) {
    const raw = isPlainObject(arg) && typeof arg.key === 'string' ? arg.key : ''
    const candidate = keyRules.normalizeKeyInput(raw)
    if (!candidate) return rules.failure('bad-key', KT.badFormat)
    return adoptKey(candidate, isPlainObject(arg) && arg.unverified === true)
  }

  async function clearKey() {
    const r = await keyStore.clear()
    return r.ok ? { ok: true, status: keyStore.status() } : rules.failure(r.code, r.message)
  }

  // ---- downloads ----

  /** The GET of a result: no key, no cookie, redirects followed only to outputUrlAllowed hosts (≤ 3), each hop allowed. */
  function netGet(url, init) {
    return new Promise((resolve, reject) => {
      const signal = init && init.signal
      const allowed = []
      const allow = (u) => {
        const n = rules.normalizeUrl(u)
        downloadUrls.set(n, (downloadUrls.get(n) || 0) + 1)
        allowed.push(n)
      }
      const release = () => {
        for (const n of allowed.splice(0)) {
          const c = (downloadUrls.get(n) || 1) - 1
          if (c <= 0) downloadUrls.delete(n)
          else downloadUrls.set(n, c)
        }
      }
      let settled = false
      let req = null
      let hops = 0
      const fail = (e) => {
        if (settled) return
        settled = true
        release()
        reject(e)
      }
      const stop = () => {
        try {
          if (req) req.abort()
        } catch {
          /* already over */
        }
      }
      const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' })
      if (signal && signal.aborted) return fail(aborted())
      try {
        allow(url)
        req = net.request(netOptions('GET', url, 'manual'))
        req.setHeader('Accept', 'video/*,*/*')
      } catch (e) {
        return fail(e)
      }
      req.on('redirect', (_status, _method, redirectUrl) => {
        hops++
        if (hops > rules.SEEDVIS_REDIRECT_MAX || !rules.outputUrlAllowed(redirectUrl)) {
          fail(Object.assign(new Error('redirect refused'), { code: 'redirect-refused' }))
          stop()
          return
        }
        allow(redirectUrl)
        req.followRedirect()
      })
      req.on('response', (res) => {
        if (settled) return
        settled = true
        release()
        const status = res.statusCode
        resolve({ status, headers: { get: (n) => headerOf(res, n) }, body: [204, 205, 304].includes(status) ? null : Readable.toWeb(res) })
      })
      req.on('error', (e) => fail(e))
      req.on('abort', () => fail(aborted()))
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            fail(aborted())
            stop()
          },
          { once: true },
        )
      }
      req.end()
    })
  }

  const downloads = rules.createSeedvisDownloads({
    fetch: netGet,
    createPump: deps.createPump,
    withSlot: (fn) => lanes.run('download', fn),
    lookup: (generationId, index) => {
      const o = outputs.get(generationId)
      return o && typeof o.urls[index] === 'string' ? o.urls[index] : null
    },
    newId: () => crypto.randomUUID(),
    setTimer,
    clearTimer,
    onEnd: (s) => {
      if (!packaged) log(`[SanoVids] seedvis download ${rules.hostOf(s.url)} ended`)
    },
  })

  const watched = new WeakSet()
  /** A page that reloads, navigates, crashes or closes stops its downloads at once (their slots are freed). */
  function watchOwner(wc) {
    if (!wc || watched.has(wc)) return
    watched.add(wc)
    const owner = wc.id
    const closeAll = () => downloads.closeAll(owner)
    wc.once('destroyed', closeAll)
    wc.on('render-process-gone', closeAll)
    wc.on('did-navigate', closeAll)
  }

  // ---- close guard (§10.6) ----

  function runPendingClose(delayMs) {
    const action = pendingClose
    pendingClose = null
    if (action) setTimer(action, delayMs)
  }

  function maybeFinishQuit() {
    if (!quitPending || inFlight > 0 || quitConfirmed) return
    quitConfirmed = true
    runPendingClose(QUIT_GRACE_MS) // the page stores the last job ids first
  }

  async function ask(win) {
    asking = true
    let choice = 0
    try {
      const opts = rules.closeGuardDialog(inFlight)
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      choice = r && r.response === 1 ? 1 : 0
    } catch {
      choice = 0 // no answer: wait for the sends (the safe choice), then close
    } finally {
      asking = false
    }
    if (quitConfirmed) return
    if (choice === 1) {
      quitConfirmed = true
      runPendingClose(0)
      return
    }
    quitPending = true
    // submits still waiting for a slot never start (nothing sent, not billed)
    lanes.cancelWaiting('submit', rules.failure('busy', T.quitting, { sent: false }))
    maybeFinishQuit()
  }

  /**
   * win.on('close') (Windows / Linux, phase 'window-close') and app.on('before-quit') (macOS, phase 'quit'): true when
   * it vetoed the close to ask "Chờ gửi xong / Thoát" (rules.closeGuardVerdict; never during an update's quit).
   */
  function closeGuard(event, o) {
    const opt = o && typeof o === 'object' ? o : {}
    const verdict = rules.closeGuardVerdict({ inFlight, quittingForUpdate: opt.quittingForUpdate === true, platform, phase: opt.phase, confirmed: quitConfirmed })
    if (verdict === 'allow') return false
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    const win = opt.win && !opt.win.isDestroyed() ? opt.win : null
    pendingClose =
      opt.phase === 'quit'
        ? () => app.quit()
        : () => {
            const w = win || getMainWindow()
            if (w && !w.isDestroyed()) w.close()
          }
    // a quit (macOS) asks app-modal: the main window may be hidden there, and a sheet on it would never show
    if (!asking) void ask(opt.phase === 'quit' ? null : win)
    return true
  }

  // ---- IPC (every channel behind isAppSender; fixed texts only) ----

  const handle = (channel, fn, refused) =>
    ipcMain.handle(channel, async (event, arg) => {
      if (!isAppSender(event)) return refused !== undefined ? refused : rules.failure('not-allowed', T.notAllowed)
      try {
        return await fn(event, arg)
      } catch {
        if (channel === 'seedvis:request' && isPlainObject(arg) && arg.route === 'generations.create') return rules.failure('network', T.lostAnswer, { sent: true })
        return rules.failure('bad-response', T.error)
      }
    })
  handle('seedvis:keyStatus', () => keyStore.status())
  handle('seedvis:pasteKey', (_event, arg) => pasteKey(arg))
  handle('seedvis:setKey', (_event, arg) => setKey(arg))
  handle('seedvis:clearKey', () => clearKey())
  handle('seedvis:request', (_event, arg) => request(arg))
  handle('seedvis:downloadOpen', (event, arg) => {
    watchOwner(event.sender)
    return downloads.open(event.sender.id, arg)
  })
  handle('seedvis:downloadRead', (event, arg) => downloads.read(event.sender.id, arg))
  handle('seedvis:downloadClose', (event, arg) => downloads.close(event.sender.id, arg))
  handle('seedvis:isOnline', () => online(), false)
  handle('seedvis:openBilling', async () => {
    await shell.openExternal(rules.SEEDVIS_BILLING_URL)
    return { ok: true }
  })

  return {
    inFlightSubmits: () => inFlight,
    closeGuard,
    dispose() {
      downloads.closeAll()
      for (const c of CHANNELS) ipcMain.removeHandler(c)
    },
  }
}

module.exports = { setupSeedvis, CHANNELS, QUIT_GRACE_MS }
