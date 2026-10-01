// HTML5 drag & drop payload types shared by the library, canvas, scene table and prompt editor.
/** JSON array of asset ids (library cards). */
export const ASSETS_MIME = 'application/x-bdp-assets'
/** JSON array of take ids (generated videos). */
export const TAKES_MIME = 'application/x-bdp-takes'

export function readIds(dt: DataTransfer, type: string): string[] {
  try {
    const raw = dt.getData(type)
    const ids = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
