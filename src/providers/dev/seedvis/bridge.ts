import { devAllowed } from '../../devAccess'
import {
  SEEDVIS_IPC_LIMITS, type SeedvisBridge, type SeedvisDownloadArgs, type SeedvisDownloadOpen,
  type SeedvisDownloadRead, type SeedvisRequest,
} from '../../seedvis/contract'
import { createDevSeedvis, SEEDVIS_DEV_LOCKED, type DevSeedvis } from './server'
import { seedvisDevAccountOf, SEEDVIS_DEV_KEYS, SEEDVIS_DEV_SAMPLE_KEYS_ONLY, type SeedvisDevAccount } from './state'
import { SEEDVIS_ID_RE } from './routes'
import { failure, isObj } from './validate'

export interface SeedvisDevBridge extends SeedvisBridge { reset(): void }

/** "Lưu mà chưa kiểm tra" stays possible this long after that key's check failed with a network error (main: 2 min). */
export const SEEDVIS_DEV_UNVERIFIED_OFFER_MS = 2 * 60 * 1000
export const SEEDVIS_DEV_KEY_TEXTS = {
  verifyNetwork: 'Không kiểm tra được khoá giả lập vì seedvis giả lập đang mất mạng — chưa lưu. Nếu chắc khoá đúng, bấm “Lưu mà chưa kiểm tra”.',
  unverifiedRefused: '“Lưu mà chưa kiểm tra” chỉ dùng được cho đúng khoá vừa bị lỗi mạng khi kiểm tra, trong vòng 2 phút — chưa lưu. Dán hoặc nhập lại khoá để kiểm tra.',
} as const

/** No URL or auth header from the caller ever reaches a download. No network/clipboard/shell APIs. */
export function createDevSeedvisBridge(server: DevSeedvis = createDevSeedvis()): SeedvisDevBridge {
  const outputs = new Map<string, { url: string; stamp: string }>()
  const sessions = new Map<string, { bytes: Uint8Array; offset: number; at: number; stamp: string }>()
  const locked = () => failure('not-allowed', SEEDVIS_DEV_LOCKED)
  const clear = () => { outputs.clear(); sessions.clear() }
  async function stamp() { return server.sessionStamp() }
  const validId = (v: unknown): v is { id: string } => isObj(v) && Object.keys(v).length === 1 && typeof v.id === 'string' && SEEDVIS_ID_RE.test(v.id)
  // Like main (seedvis.cjs adoptKey + seedvis-key-rules createUnverifiedOffer): only the key whose check just failed with
  // a network error may be saved unchecked, within 2 min; any new check, a save or Xoá key withdraws the offer.
  let offer: { account: SeedvisDevAccount; at: number } | null = null

  async function adopt(key: unknown, unverified: boolean) {
    if (!devAllowed()) return locked()
    const account = seedvisDevAccountOf(key)
    if (!account) return failure('bad-key', SEEDVIS_DEV_SAMPLE_KEYS_ONLY)
    if (unverified) {
      const age = offer ? server.now() - offer.at : -1
      if (!offer || offer.account !== account || !(age >= 0 && age <= SEEDVIS_DEV_UNVERIFIED_OFFER_MS)) {
        offer = null
        return failure('bad-key', SEEDVIS_DEV_KEY_TEXTS.unverifiedRefused)
      }
    } else {
      offer = null
      // the key check (GET /account/info on the real gateway) cannot reach a simulation that is offline
      if (!(await server.isOnline())) {
        offer = { account, at: server.now() }
        return failure('network', SEEDVIS_DEV_KEY_TEXTS.verifyNetwork)
      }
    }
    const result = await server.setKey({ key }, { unchecked: unverified })
    if (result.ok) { offer = null; clear() }
    return result
  }

  return {
    keyStatus: () => server.keyStatus(),
    // The simulation has no clipboard: "Dán key" pastes the sample key of account A001.
    pasteKey: (args) => adopt(SEEDVIS_DEV_KEYS.A001, isObj(args) && args.unverified === true),
    setKey: (args) => adopt(isObj(args) ? args.key : undefined, isObj(args) && args.unverified === true),
    async clearKey() { offer = null; clear(); return server.clearKey() },
    async request(args: SeedvisRequest) {
      if (!devAllowed()) return locked()
      // Like IPC, own a copy of the arguments before the first await: later renderer edits cannot change what is billed or hashed.
      let req: SeedvisRequest
      try { req = structuredClone(args) } catch { return failure('bad-request') }
      const before = await stamp()
      const answer = await server.request(req)
      if (answer.ok && before && before === await stamp() && isObj(answer.json) && isObj(answer.json.data)) {
        const job = answer.json.data
        if (typeof job.id === 'string' && SEEDVIS_ID_RE.test(job.id) && Array.isArray(job.outputs)) {
          // Replace stale URLs, including an explicit empty outputs answer.
          for (const key of outputs.keys()) if (key.startsWith(`${job.id}:`)) outputs.delete(key)
          job.outputs.forEach((output, index) => {
            if (isObj(output) && typeof output.url === 'string') outputs.set(`${job.id}:${index}`, { url: output.url, stamp: before })
          })
        }
      }
      return answer
    },
    async downloadOpen(args: SeedvisDownloadArgs): Promise<SeedvisDownloadOpen> {
      if (!devAllowed()) { clear(); return locked() }
      if (!isObj(args) || Object.keys(args).some(k => k !== 'generationId' && k !== 'index') || typeof args.generationId !== 'string'
        || !SEEDVIS_ID_RE.test(args.generationId) || !Number.isSafeInteger(args.index) || args.index < 0) return failure('bad-request')
      const current = await stamp()
      for (const [id, s] of sessions) if (server.now() - s.at >= 60_000 || s.stamp !== current) sessions.delete(id)
      const output = outputs.get(`${args.generationId}:${args.index}`)
      if (!output || !current || output.stamp !== current) return failure('unknown-output')
      if (sessions.size >= 2) return failure('busy')
      // Reserve the slot before awaiting the server; simultaneous opens cannot exceed the limit.
      const id = crypto.randomUUID()
      sessions.set(id, { bytes: new Uint8Array(), offset: 0, at: server.now(), stamp: current })
      const response = await server.download(output.url, {})
      if (!devAllowed() || current !== await stamp() || !sessions.has(id)) { sessions.delete(id); return failure('gone') }
      if (!response.ok) { sessions.delete(id); return response }
      if (response.redirect) { sessions.delete(id); return failure('not-allowed', 'Chặn chuyển hướng tải video không an toàn.') }
      if (response.total > SEEDVIS_IPC_LIMITS.videoBytes) { sessions.delete(id); return failure('too-large') }
      if (response.bytes.length < 12 || new TextDecoder().decode(response.bytes.subarray(4, 8)) !== 'ftyp') { sessions.delete(id); return failure('bad-response') }
      sessions.set(id, { bytes: response.bytes, offset: 0, at: server.now(), stamp: current })
      return { ok: true, id, total: response.total, mime: 'video/mp4' }
    },
    async downloadRead(args): Promise<SeedvisDownloadRead> {
      if (!devAllowed()) { clear(); return locked() }
      if (!validId(args)) return failure('bad-request')
      const current = await stamp()
      const s = sessions.get(args.id)
      if (!s || !current || s.stamp !== current || server.now() - s.at >= 60_000) { sessions.delete(args.id); return failure('gone') }
      if (!await server.isOnline()) return failure('offline')
      if (!devAllowed() || current !== await stamp()) { sessions.delete(args.id); return failure('gone') }
      s.at = server.now()
      if (s.offset >= s.bytes.length) { sessions.delete(args.id); return { ok: true, done: true } }
      const bytes = s.bytes.slice(s.offset, s.offset + SEEDVIS_IPC_LIMITS.chunkBytes)
      s.offset += bytes.length
      return { ok: true, done: false, bytes }
    },
    async downloadClose(args) {
      if (!devAllowed()) { clear(); return locked() }
      if (!validId(args)) return failure('bad-request')
      sessions.delete(args.id)
      return { ok: true }
    },
    isOnline: () => server.isOnline(),
    async openBilling() { return devAllowed() ? { ok: true } : locked() },
    reset: clear,
  }
}
