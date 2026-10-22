// One source of truth for retired @video text (core/compile retiredVideoTokens): every layer that blocks or marks it
// must agree on every string — the compile (retiredTokens / unsentTokens), the run rules (store/runs check(), every Run
// button), the gateway's validateRequest (canvasapp and development mode share it) and the prompt editor's red marks.
// A layer that let one through while another refused it would either send "@video_1" to canvasapp as plain words
// (billed for a wrong video) or block a scene nobody can fix.
import { describe, expect, it } from 'vitest'
import { segmentPrompt } from '../../components/inspector/tokens'
import { retiredVideoRequestText, validateRequest } from '../../providers/canvasapp/mapping'
import type { JobRequest } from '../../providers/types'
import { compileScene, hasRetiredVideoToken, promptParts, retiredVideoTokens, TOKEN_RE, UNBOUND_RE } from '../compile'
import { retiredVideoReason, runBlockReason } from '../runRules'
import type { Project, Scene } from '../types'

const CASES = [
  '@video_1',
  '@Video 2',
  '@video3',
  '@VIDEO_4',
  '@video_1ạ',
  '@video_?2',
  '@video_?2(S01·T1)',
  '@video_?2go',
  'Continue from @video_1: Elara',
  '@video2go',
  '@video1abc',
  'email@video_1.com',
  '@video',
  '@videos 2',
  '@image_1 only',
  '@image_?1',
  'video_1 without at',
  '@@video_3',
  '(@video_5)',
  '@video_12345678',
  'a @Video  2',
]

const scene = (prompt: string): Scene => ({
  id: 's',
  order: 1,
  title: '',
  prompt,
  refs: ['a'],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: 0 },
  note: '',
})
const project = (s: Scene): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [{ id: 'a', kind: 'character', name: 'Elara', tag: 'Elara', description: '', imageIds: ['i1'], color: '#fff', position: null }],
  scenes: [s],
})
const request = (prompt: string): JobRequest => ({
  key: 'k',
  takeId: 'k',
  sceneId: 's',
  sanovidsProjectId: 'p',
  sceneCode: 'S01',
  takeNumber: 1,
  title: '',
  color: '#fff',
  model: 'seedance_2_5',
  mode: 't2v',
  duration: 5,
  resolution: '480p',
  ratio: '16:9',
  prompt,
  rawPrompt: prompt,
  images: [{ n: 1, assetId: 'a', imageId: 'i1' }],
  firstFrame: null,
  lastFrame: null,
  startedAt: 0,
})

describe('retired @video text: every layer agrees (one helper)', () => {
  it.each(CASES)('%s', (text) => {
    const prompt = `${text} @image_1`
    const tokens = [...new Set(retiredVideoTokens(prompt).map((t) => t.text))]
    const retired = tokens.length > 0
    expect(hasRetiredVideoToken(prompt)).toBe(retired)
    // compile: named, and never sent
    const s = scene(prompt)
    const compiled = compileScene(project(s), s)
    expect(compiled.retiredTokens).toEqual(tokens)
    for (const t of tokens) expect(compiled.unsentTokens).toContain(t)
    // the run rules (check() and every Run button)
    const reason = runBlockReason({ scene: s, assets: project(s).assets, compiled })
    if (retired) expect(reason).toBe(retiredVideoReason(tokens))
    else expect(reason ?? '').not.toContain('video tham chiếu')
    // the gateway (canvasapp and development mode): refused before anything is sent — same tokens
    const problems = validateRequest(request(prompt))
    expect(problems.includes(retiredVideoRequestText(tokens))).toBe(retired)
    if (!retired) expect(problems.join(' ')).not.toContain('video tham chiếu')
    // what the prompt editor / final preview strike through, and the read-only highlighters
    expect(segmentPrompt(prompt, 1).filter((x) => x.reason === 'retired').map((x) => x.text)).toEqual(retiredVideoTokens(prompt).map((t) => t.text))
    expect(promptParts(prompt).filter((x) => x.kind === 'retired').map((x) => x.text)).toEqual(retiredVideoTokens(prompt).map((t) => t.text))
  })

  it('is a superset of what the token parsers read as video (TOKEN_RE / UNBOUND_RE)', () => {
    for (const text of CASES) {
      const found = retiredVideoTokens(text)
      const covered = (start: number, end: number) => found.some((t) => t.start === start && t.end >= end)
      for (const m of text.matchAll(TOKEN_RE)) if (m[1].toLowerCase() === 'video') expect(covered(m.index, m.index + m[0].length), text).toBe(true)
      for (const m of text.matchAll(UNBOUND_RE)) if (m[1].toLowerCase() === 'video') expect(covered(m.index, m.index + m[0].length), text).toBe(true)
    }
  })
})
