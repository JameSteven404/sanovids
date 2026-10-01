export function newId(prefix = ''): string {
  const id = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        return (c === 'x' ? r : (r & 3) | 8).toString(16)
      })
  return prefix ? `${prefix}_${id}` : id
}

/** Palette used for assets, blocks and scenes. Readable on the dark canvas. */
export const PALETTE = ['#e8894a', '#4fb6a8', '#7c9cff', '#d66b9a', '#c9b14a', '#8bc34a', '#b48cff', '#5ac8fa', '#ff7a6b', '#a3a3a3']

export function pickColor(i: number): string {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length]
}
