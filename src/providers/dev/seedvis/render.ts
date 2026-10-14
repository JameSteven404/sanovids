/** Transport fixture only: ftyp + mdat, deliberately not a playable movie. No DOM, codecs or network. */
export function renderSeedvisVideo(id: string): Uint8Array {
  const label = new TextEncoder().encode(`seedvis · DEV · ${id}`)
  const bytes = new Uint8Array(32 + label.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 24)
  bytes.set(new TextEncoder().encode('ftypisom'), 4)
  bytes.set(new TextEncoder().encode('isommp42'), 16)
  view.setUint32(24, 8 + label.length)
  bytes.set(new TextEncoder().encode('mdat'), 28)
  bytes.set(label, 32)
  return bytes
}
