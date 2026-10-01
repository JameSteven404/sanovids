// Small helpers shared by the dialogs (dg-).

/** Readable Vietnamese message for a failed data operation (a broken file throws a JSON SyntaxError). */
export function errorText(e: unknown): string {
  if (e instanceof SyntaxError) return 'File không đúng định dạng .bdp.json (không đọc được JSON).'
  if (e instanceof Error && e.message) return e.message
  return 'Có lỗi xảy ra, chưa làm được.'
}
