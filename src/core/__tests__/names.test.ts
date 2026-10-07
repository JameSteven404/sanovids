// core/names: the one rule for asset / folder node / preset names (store and migrate).
import { describe, expect, it } from 'vitest'
import { FOLDER_NAME_MAX, normalizeAssetName, normalizeFolderName, normalizePresetName, UNNAMED_ASSET, UNNAMED_FOLDER, UNNAMED_PRESET } from '../names'

const samples: unknown[] = ['', '   ', '\t\n', ' Elara ', 'Elara', 'a'.repeat(119) + ' b', '🎬'.repeat(200), ' 🎬 '.repeat(70), null, undefined, 5, true, {}, []]

describe('core/names', () => {
  it('asset names: as typed when visible, else "Không tên"', () => {
    expect(normalizeAssetName(' Elara ')).toBe(' Elara ')
    for (const v of ['', '  ', null, undefined]) expect(normalizeAssetName(v)).toBe(UNNAMED_ASSET)
    expect(normalizeAssetName(5)).toBe('5')
  })

  it('folder names: trimmed, ≤ 120 code points, blank → the folder path name, else "Thư mục"', () => {
    expect(normalizeFolderName('  Phim A ')).toBe('Phim A')
    expect(normalizeFolderName('  ', 'C:\\Users\\me\\Phim B\\')).toBe('Phim B')
    expect(normalizeFolderName('', '/home/me/out/')).toBe('out')
    expect(normalizeFolderName('', null)).toBe(UNNAMED_FOLDER)
    expect(normalizeFolderName('🎬'.repeat(200))).toBe('🎬'.repeat(FOLDER_NAME_MAX))
    expect(normalizeFolderName('a'.repeat(119) + ' b')).toBe('a'.repeat(119))
  })

  it('preset names: trimmed, blank → "Preset"', () => {
    expect(normalizePresetName('  Phim ')).toBe('Phim')
    expect(normalizePresetName('   ')).toBe(UNNAMED_PRESET)
  })

  it('every rule is idempotent (a name read back twice never changes)', () => {
    for (const v of samples) {
      const a = normalizeAssetName(v)
      expect(normalizeAssetName(a)).toBe(a)
      const f = normalizeFolderName(v, '/x/Phim C')
      expect(normalizeFolderName(f, '/x/Phim C')).toBe(f)
      const p = normalizePresetName(v)
      expect(normalizePresetName(p)).toBe(p)
    }
  })
})
