// Edge-case text for the stress tester: Vietnamese in NFC and NFD, emoji ZWJ sequences, RTL, zero-width and control
// characters, Windows reserved names, token look-alikes, very long text. Everything is written with escapes so the
// file itself stays plain ASCII-safe for every editor.
import type { Rng } from './rng'

/** "Bé An đi dưới mưa" in NFC (precomposed). */
export const VI_NFC = 'B\u00e9 An \u0111i d\u01b0\u1edbi m\u01b0a, \u00e1nh \u0111\u00e8n v\u00e0ng h\u1eaft l\u00ean khu\u00f4n m\u1eb7t'
/** The same text in NFD (combining marks): must count and compare like a user would expect. */
export const VI_NFD = VI_NFC.normalize('NFD')

export const EMOJI = [
  '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}', // family (ZWJ)
  '\u{1F3F3}\uFE0F\u200D\u{1F308}', // rainbow flag
  '\u{1F44D}\u{1F3FD}', // thumbs up + skin tone
  '\u{1F1FB}\u{1F1F3}', // flag VN (regional indicators)
  '\u2764\uFE0F',
  '\u{1F3AC}',
]

export const RTL = ['\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645', '\u05e9\u05dc\u05d5\u05dd', '\u202Eevil\u202C']
export const ZERO_WIDTH = ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF']
export const CONTROL = ['\u0000', '\u0007', '\u001B[31m', '\r\n', '\t', '\u2028', '\u2029', '\uFFFD', '\uD800']
export const WINDOWS_RESERVED = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'con.txt', 'a:b', 'x/y\\z', '..', '.', ' trailing ', 'dot.', '*?<>|"']

/** Token look-alikes: some are real media tokens, some must stay text. */
export const TOKEN_LIKE = [
  '@image_1',
  '@Image 2',
  '@IMAGE3',
  '@image_0',
  '@image_999',
  '@image_?2',
  '@image_120',
  '@video_1',
  '@video_?1',
  '@Video 2',
  '@imagex',
  '@image_',
  'email@image_1.com',
  '@Elara',
  '@@image_1',
]

const WORDS = [
  'c\u1ea3nh',
  'm\u01b0a',
  '\u0111\u00eam',
  'nh\u00e2n v\u1eadt',
  'b\u00ecnh minh',
  'camera quay ch\u1eadm',
  'close-up',
  'wide shot',
  '\u00e1nh s\u00e1ng',
  'ti\u1ebfng b\u01b0\u1edbc ch\u00e2n',
  'th\u00e0nh ph\u1ed1',
  'gi\u00f3',
  'neon',
  'kh\u00f3i',
]

/** A plain sentence of `n` words. */
export function sentence(rng: Rng, n = rng.int(3, 12)): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(rng.pick(WORDS))
  return out.join(' ')
}

/** One edge-case fragment (never empty). */
export function edgeFragment(rng: Rng): string {
  switch (rng.int(0, 9)) {
    case 0:
      return VI_NFC
    case 1:
      return VI_NFD
    case 2:
      return rng.pick(EMOJI)
    case 3:
      return rng.pick(RTL)
    case 4:
      return 'a' + rng.pick(ZERO_WIDTH) + 'b'
    case 5:
      return 'x' + rng.pick(CONTROL) + 'y'
    case 6:
      return rng.pick(WINDOWS_RESERVED)
    case 7:
      return rng.pick(TOKEN_LIKE)
    case 8:
      return 'x'.repeat(rng.int(200, 2000))
    default:
      return sentence(rng)
  }
}

/** A name / title / file name: mostly short, sometimes hostile. */
export function edgeName(rng: Rng): string {
  if (rng.chance(0.5)) return sentence(rng, rng.int(1, 4))
  if (rng.chance(0.15)) return 'T\u00ean '.repeat(rng.int(500, 2500)) // ~10k characters
  if (rng.chance(0.1)) return ''
  if (rng.chance(0.1)) return '   '
  return edgeFragment(rng)
}

/** Text of exactly `n` code points (Vietnamese + emoji mix, counted like compileScene: [...text].length). */
export function textOfLength(rng: Rng, n: number): string {
  if (n <= 0) return ''
  const unit = rng.chance(0.5) ? VI_NFC + ' ' : '\u{1F3AC}a\u0111 '
  const cps = [...unit]
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(cps[i % cps.length])
  // never end with a space: the prompt is trimmed before counting
  if (out[out.length - 1] === ' ') out[out.length - 1] = 'x'
  if (out[0] === ' ') out[0] = 'x'
  return out.join('')
}

/** Code-point length as compileScene / canvasapp count it (trimmed). */
export const cpLength = (s: string) => [...s.trim()].length
