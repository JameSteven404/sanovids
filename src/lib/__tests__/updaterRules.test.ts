// electron/updater-rules.cjs: the pure rules of the desktop auto-updater (versions, the test-only data folder override,
// build kind, error mapping, release notes as text, the state machine, schedule, persistence) — plus the packaging
// guarantees in package.json / preload / main.cjs that keep real users on the public feed and their real data folder,
// and the electron-updater internals our pinned signature verifier relies on (decision table: signature.test.ts).
import { createHash } from 'node:crypto'
import nodeFs from 'node:fs'
import { createRequire } from 'node:module'
import nodePath from 'node:path'
import { describe, expect, it } from 'vitest'
import mainSource from '../../../electron/main.cjs?raw'
import preloadSource from '../../../electron/preload.cjs?raw'
import rulesSource from '../../../electron/updater-rules.cjs?raw'
import updaterSource from '../../../electron/updater.cjs?raw'
import pkgSource from '../../../package.json?raw'

type PathMod = typeof nodePath.win32
type Kind = 'installer' | 'portable' | 'dev'
type ErrorCode = 'offline' | 'no-release' | 'rate-limited' | 'checksum' | 'signature' | 'signature-unverified' | 'disk' | 'install-failed' | 'failed'
interface UpdErr {
  code: ErrorCode
  message: string
}
interface Info {
  version: string
  releaseDate?: string
  notes: string
  size?: number
}
interface State {
  kind: Kind
  current: string
  status: string
  version?: string
  releaseDate?: string
  notes?: string
  size?: number
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
  error?: UpdErr
  lastCheck?: number
  autoDownload: boolean
  notice?: unknown
}
interface FsMod {
  existsSync(p: string): boolean
  realpathSync(p: string): string
}
type ProfileResult = { ok: true; dir: string; source: 'env' | 'baked' | 'default' } | { ok: false; error: string }
interface Rejected {
  version: string
  sha512: string
  reason: string
  at: number
}
interface UpdaterFile {
  autoDownload: boolean
  attempt?: { version: string; from: string; at: number }
  rejected?: Rejected[]
}
interface SigVerdict {
  ok: boolean
  status: string
  reason: string
  thumbprint?: string
  signer?: string
  timestamped: boolean
  productVersion?: string
  productName?: string
}
interface PathLike {
  dirname(p: string): string
  basename(p: string): string
  join(...p: string[]): string
}
interface Rules {
  RELEASES_URL: string
  FEED: { provider: string; owner: string; repo: string }
  ERROR_TEXT: Record<string, string>
  INSTALL_GRACE_MS: number
  isVersion(v: unknown): boolean
  compareVersions(a: string, b: string): -1 | 0 | 1
  resolveProfileDir(o: { env?: string; baked?: string; appData: string; appName: string; pathMod: PathMod; fsMod?: FsMod }): ProfileResult
  appUserModelId(appName: string): string
  detectKind(o: {
    platform: string
    isPackaged: boolean
    portableFile?: string
    execPath: string
    appName: string
    exists: (p: string) => boolean
    pathMod: PathMod
  }): Kind
  placement(o: {
    platform: string
    isPackaged: boolean
    portableFile?: unknown
    execPath: unknown
    tmpDir: unknown
    appName: string
    exists: (p: string) => boolean
    realpath?: unknown
    pathMod: PathMod
  }): Kind | 'temp-copy'
  portableRelaunch(o: {
    platform: string
    isPackaged: boolean
    portableFile?: unknown
    appName: unknown
    exists: (p: string) => boolean
    pathMod: PathMod
  }): { appId: string; appIconPath: string; appIconIndex: number; relaunchCommand: string; relaunchDisplayName: string } | null
  mapUpdaterError(err: unknown, phase: 'check' | 'download' | 'install'): UpdErr
  notesToText(notes: unknown): string
  normalizeInfo(info: unknown): Info | null
  initialState(o: { kind: Kind; current: string; autoDownload?: boolean; notice?: unknown }): State
  reduceUpdateState(state: State, event: unknown, now: number): State
  checkDue(o: { status: string; lastAttemptAt?: number; lastErrorCode?: string | null; now: number }): boolean
  parsePrefsArg(arg: unknown): { autoDownload: boolean } | null
  parseUpdaterFile(raw: unknown): UpdaterFile
  startupNotice(file: UpdaterFile, current: string, now: number): unknown
  startupAttempt(file: UpdaterFile, current: string, now: number): { notice: unknown; keep: boolean }
  logLine(level: string, message: unknown, date: Date | number): string
  updaterFileData(file: unknown): Record<string, unknown>
  SIGNATURE_REFUSED_REASONS: string[]
  SIGNATURE_UNVERIFIED_REASONS: string[]
  REJECTED_MAX: number
  UNVERIFIED_RETRY_MS: number
  isSha512(v: unknown): boolean
  signatureErrorCode(reason: unknown): 'signature' | 'signature-unverified'
  signatureReasonOf(text: unknown): string
  offerHashes(info: unknown): string[]
  rememberRejected(list: unknown, entry: unknown, now: number): Rejected[]
  forgetRejected(list: unknown, hashes: unknown): Rejected[]
  findRejected(list: unknown, hashes: unknown, now: number): Rejected | null
  SIGNATURE_SCRIPT: string
  powershellEnv(base: Record<string, string | undefined>, file: string): Record<string, string>
  parseSignatureOutput(stdout: unknown): Record<string, unknown> | null
  judgeSignature(parsed: unknown, pins: unknown): SigVerdict
  INSTALLER_MIN_BYTES: number
  installerIdentityProblem(verdict: unknown, expected: unknown): string
  sameVerifiedMeta(verified: unknown, stat: unknown, file: unknown): boolean
  sameVerifiedFile(verified: unknown, stat: unknown, file: unknown, sha512?: unknown): boolean
  cachedBlockmapFile(installerPath: unknown, pathMod: PathLike | null): string | null
}

const rules = createRequire(import.meta.url)('../../../electron/updater-rules.cjs') as Rules
const win = nodePath.win32
const posix = nodePath.posix
const pkg = JSON.parse(pkgSource) as {
  version: string
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  build: { files: string[]; publish: Record<string, unknown>[] }
}

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('updater rules: versions', () => {
  it('compares x.y.z numerically, pre-releases below their plain version', () => {
    expect(rules.compareVersions('0.4.2', '0.5.0')).toBe(-1)
    expect(rules.compareVersions('0.5.0', '0.4.2')).toBe(1)
    expect(rules.compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(rules.compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(rules.compareVersions('1.2.3+build.7', '1.2.3')).toBe(0)
    expect(rules.compareVersions('0.5.0-beta.1', '0.5.0')).toBe(-1)
    expect(rules.compareVersions('0.5.0', '0.5.0-beta.1')).toBe(1)
    expect(rules.compareVersions('0.5.0-beta.2', '0.5.0-beta.10')).toBe(-1)
    expect(rules.compareVersions('0.5.0-alpha', '0.5.0-beta')).toBe(-1)
    expect(rules.compareVersions('0.5.0-1', '0.5.0-alpha')).toBe(-1)
    expect(rules.compareVersions('0.5.0-beta', '0.5.0-beta.1')).toBe(-1)
    expect(rules.compareVersions('0.4.9-rc.1', '0.5.0')).toBe(-1)
    expect(rules.compareVersions('garbage', '0.0.1')).toBe(-1)
    expect(rules.compareVersions('0.0.1', 'garbage')).toBe(1)
    expect(rules.compareVersions('x', 'y')).toBe(0)
  })

  it('accepts only plain semver-ish versions of at most 64 characters', () => {
    for (const v of ['0.4.2', '10.20.30', '0.5.0-beta.1', '1.0.0+abc', '0.5.91']) expect(rules.isVersion(v)).toBe(true)
    for (const v of ['', '1.2', 'v1.2.3', '1.2.3 ', ' 1.2.3', '1.2.3\n', '1.2.3-<b>', '../1.2.3', `1.2.3-${'a'.repeat(60)}`, null, 1, {}]) {
      expect(rules.isVersion(v)).toBe(false)
    }
  })
})

describe('updater rules: data folder override (test isolation)', () => {
  const winAppData = 'C:\\Users\\me\\AppData\\Roaming'
  const realWin = 'C:\\Users\\me\\AppData\\Roaming\\SanoVids'
  const resolveWin = (o: { env?: string; baked?: string; appName?: string }) =>
    rules.resolveProfileDir({ appData: winAppData, appName: 'SanoVids', pathMod: win, ...o })
  const resolvePosix = (o: { env?: string; baked?: string; appName?: string }) =>
    rules.resolveProfileDir({ appData: '/home/me/.config', appName: 'SanoVids', pathMod: posix, ...o })

  it('real users get %APPDATA%\\SanoVids', () => {
    expect(resolveWin({})).toEqual({ ok: true, dir: realWin, source: 'default' })
    expect(resolveWin({ env: '' })).toEqual({ ok: true, dir: realWin, source: 'default' })
    expect(resolveWin({ env: '', baked: '' })).toEqual({ ok: true, dir: realWin, source: 'default' })
    expect(resolvePosix({})).toEqual({ ok: true, dir: '/home/me/.config/SanoVids', source: 'default' })
  })

  it('env wins over the baked folder, which wins over the default', () => {
    expect(resolveWin({ env: 'D:\\scratch\\p1', baked: 'D:\\scratch\\p2' })).toEqual({ ok: true, dir: 'D:\\scratch\\p1', source: 'env' })
    expect(resolveWin({ baked: 'D:\\scratch\\p2' })).toEqual({ ok: true, dir: 'D:\\scratch\\p2', source: 'baked' })
    expect(resolveWin({ env: '', baked: 'D:\\scratch\\p2\\' })).toEqual({ ok: true, dir: 'D:\\scratch\\p2', source: 'baked' })
    expect(resolvePosix({ env: '/tmp/x/../profile' })).toEqual({ ok: true, dir: '/tmp/profile', source: 'env' })
    // A sibling whose name only starts like the real folder is fine.
    expect(resolveWin({ env: `${realWin}Test` })).toEqual({ ok: true, dir: `${realWin}Test`, source: 'env' })
  })

  it('fails closed on anything doubtful', () => {
    const bad = [
      'relative\\path',
      '.\\profile',
      'C:',
      'C:\\',
      'D:\\',
      '\\\\server\\share\\',
      'D:\\scratch\\a\u0000b',
      `D:\\${'x'.repeat(240)}`,
      realWin,
      `${realWin}\\`,
      'c:\\users\\ME\\appdata\\roaming\\sanovids',
      `${realWin}\\sub`,
      'C:\\USERS\\me\\AppData\\Roaming\\SANOVIDS\\x\\..\\y',
      `${winAppData}\\Other\\..\\SanoVids`,
    ]
    for (const env of bad) {
      const r = resolveWin({ env })
      expect(r.ok, env).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/^SANOVIDS_PROFILE_DIR \/ sanovidsTestProfileDir is invalid: /)
    }
    expect(resolveWin({ baked: 'relative' }).ok).toBe(false)
    expect(resolveWin({ env: 'D:\\ok', baked: 'relative' }).ok).toBe(true) // env decides, baked is not consulted
    for (const env of ['relative/path', '/', '/home/me/.config/SanoVids', '/home/me/.config/SanoVids/sub']) {
      expect(resolvePosix({ env }).ok, env).toBe(false)
    }
    // POSIX is case-sensitive: another folder.
    expect(resolvePosix({ env: '/home/me/.config/sanovids' }).ok).toBe(true)
  })

  it('refuses Windows aliases of the real folder and its parents', () => {
    const aliases = [
      `${realWin}.`, // Win32 strips trailing dots and spaces: this IS the real folder
      `${realWin} `,
      `${realWin}...\\x`,
      `${winAppData}\\SANOVI~1`, // 8.3 short name
      'C:\\Users\\me\\AppData\\Roaming\\SANOVI~1\\profile',
      `\\\\?\\${realWin}`,
      `\\\\?\\${realWin}\\x`,
      `\\\\.\\${realWin}`,
      '\\\\localhost\\c$\\Users\\me\\AppData\\Roaming\\SanoVids',
      '//localhost/c$/Users/me/AppData/Roaming/SanoVids',
      `${realWin}::$INDEX_ALLOCATION`, // the folder's own stream
      `${realWin}:stream`,
      winAppData, // contains the real folder
      `${winAppData}\\`,
      'C:\\Users\\me',
      'c:\\users',
    ]
    for (const env of aliases) {
      const r = resolveWin({ env })
      expect(r.ok, env).toBe(false)
    }
    expect(resolvePosix({ env: '/home/me/.config' }).ok).toBe(false)
    expect(resolvePosix({ env: '/home/me' }).ok).toBe(false)
    // POSIX names may end with a dot / space or contain "~".
    expect(resolvePosix({ env: '/tmp/a~b/profile.' }).ok).toBe(true)
    // Ordinary scratch folders stay fine.
    expect(resolveWin({ env: 'C:\\Users\\me\\AppData\\Local\\Temp\\claude\\scratchpad\\e2e-update\\profile' }).ok).toBe(true)
    expect(resolveWin({ env: `${winAppData}\\SanoVidsUpdTest` }).ok).toBe(true)
  })

  it('with fsMod, sees through junctions / symlinks to the real folder', () => {
    // D:\link is a junction to C:\Users\me\AppData\Roaming; D:\scratch is a plain folder.
    const links: Record<string, string> = { 'd:\\link': winAppData }
    const existing = new Set(['c:\\', 'c:\\users', 'c:\\users\\me', 'c:\\users\\me\\appdata', winAppData.toLowerCase(), realWin.toLowerCase(), 'd:\\', 'd:\\link', 'd:\\scratch'])
    const fsMod: FsMod = {
      existsSync: (p) => existing.has(p.toLowerCase()),
      realpathSync: (p) => {
        const key = p.toLowerCase()
        for (const [from, to] of Object.entries(links)) {
          if (key === from || key.startsWith(`${from}\\`)) return to + p.slice(from.length)
        }
        return p
      },
    }
    const withFs = (env: string) => rules.resolveProfileDir({ env, appData: winAppData, appName: 'SanoVids', pathMod: win, fsMod })
    for (const env of ['D:\\link\\SanoVids', 'D:\\link\\SanoVids\\sub', 'D:\\link', 'D:\\LINK\\sanovids\\new\\deeper']) {
      const r = withFs(env)
      expect(r.ok, env).toBe(false)
      if (!r.ok) expect(r.error).toContain('after resolving links')
    }
    expect(withFs('D:\\scratch\\profile')).toEqual({ ok: true, dir: 'D:\\scratch\\profile', source: 'env' })
    expect(withFs('D:\\link\\SanoVidsUpdTest')).toEqual({ ok: true, dir: 'D:\\link\\SanoVidsUpdTest', source: 'env' })
    // A throwing file system falls back to the lexical checks.
    const broken: FsMod = { existsSync: () => true, realpathSync: () => { throw new Error('EPERM') } }
    expect(rules.resolveProfileDir({ env: 'D:\\scratch\\p', appData: winAppData, appName: 'SanoVids', pathMod: win, fsMod: broken }).ok).toBe(true)
  })

  it('another product name gets its own folder', () => {
    expect(resolveWin({ appName: 'SanoVidsUpdTest' })).toEqual({ ok: true, dir: `${winAppData}\\SanoVidsUpdTest`, source: 'default' })
    expect(resolveWin({ appName: 'Sano Vids/Test' })).toEqual({ ok: true, dir: `${winAppData}\\Sano_Vids_Test`, source: 'default' })
    expect(resolveWin({ appName: '' })).toEqual({ ok: true, dir: `${winAppData}\\SanoVids-other`, source: 'default' })
    expect(resolveWin({ appName: '..' })).toEqual({ ok: true, dir: `${winAppData}\\SanoVids-other`, source: 'default' })
  })

  it('AppUserModelId stays com.sanovids.app for the real app only', () => {
    expect(rules.appUserModelId('SanoVids')).toBe('com.sanovids.app')
    expect(rules.appUserModelId('SanoVidsUpdTest')).toBe('com.sanovids.test.sanovidsupdtest')
    expect(rules.appUserModelId('sanovids')).toBe('com.sanovids.test.sanovids')
  })
})

describe('updater rules: build kind', () => {
  const base = {
    platform: 'win32',
    isPackaged: true,
    execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\sanovids\\SanoVids.exe',
    appName: 'SanoVids',
    pathMod: win,
  }
  const uninstaller = 'C:\\Users\\me\\AppData\\Local\\Programs\\sanovids\\Uninstall SanoVids.exe'

  it('dev / portable / installer', () => {
    expect(rules.detectKind({ ...base, isPackaged: false, exists: () => true })).toBe('dev')
    expect(rules.detectKind({ ...base, portableFile: 'E:\\SanoVids-Portable.exe', exists: () => true })).toBe('portable')
    expect(rules.detectKind({ ...base, exists: (p) => p === uninstaller })).toBe('installer')
    expect(rules.detectKind({ ...base, portableFile: '', exists: (p) => p === uninstaller })).toBe('installer')
    expect(rules.detectKind({ ...base, exists: () => false })).toBe('portable') // win-unpacked / a copied exe
    expect(rules.detectKind({ ...base, exists: () => { throw new Error('EACCES') } })).toBe('portable')
    expect(rules.detectKind({ ...base, platform: 'linux', pathMod: win, exists: () => true })).toBe('portable')
    expect(
      rules.detectKind({
        ...base,
        appName: 'SanoVidsUpdTest',
        execPath: 'D:\\scratch\\install\\SanoVidsUpdTest.exe',
        exists: (p) => p === 'D:\\scratch\\install\\Uninstall SanoVidsUpdTest.exe',
      }),
    ).toBe('installer')
  })
})

describe('updater rules: where the app runs from (app:placement)', () => {
  const temp = 'C:\\Users\\minhm\\AppData\\Local\\Temp'
  const shortTemp = 'C:\\Users\\MINHM~1\\AppData\\Local\\Temp'
  const leftover = `${temp}\\nsyF6B5.tmp\\7z-out\\SanoVids.exe`
  const installed = 'C:\\Users\\me\\AppData\\Local\\Programs\\sanovids\\SanoVids.exe'
  /** fs.realpathSync.native stand-in: short names → long names (like Windows), unknown paths as they are. */
  const realpath = (p: string) => p.replace(/^C:\\Users\\MINHM~1\\/i, 'C:\\Users\\minhm\\')
  const base = { platform: 'win32', isPackaged: true, appName: 'SanoVids', pathMod: win, exists: () => false, realpath, tmpDir: shortTemp }

  it('installer / portable / dev are exactly detectKind (= the updater state kind)', () => {
    const cases = [
      { ...base, execPath: installed, exists: (p: string) => p === installed.replace('SanoVids.exe', 'Uninstall SanoVids.exe') },
      { ...base, execPath: installed },
      { ...base, execPath: installed, isPackaged: false },
      { ...base, execPath: `${temp}\\nsA1.tmp\\app\\SanoVids.exe`, portableFile: 'E:\\SanoVids-Portable-0.6.0.exe' },
      { ...base, execPath: 'D:\\x\\SanoVids.exe', platform: 'linux' },
    ]
    for (const c of cases) expect(rules.placement(c), c.execPath).toBe(rules.detectKind(c as Parameters<Rules['detectKind']>[0]))
    expect(rules.placement(cases[0])).toBe('installer')
    expect(rules.placement(cases[2])).toBe('dev')
  })

  it('a leftover copy inside the temp folder (no PORTABLE_EXECUTABLE_FILE) → temp-copy, also through an 8.3 TEMP path', () => {
    expect(rules.placement({ ...base, execPath: leftover })).toBe('temp-copy')
    expect(rules.placement({ ...base, execPath: leftover, tmpDir: temp })).toBe('temp-copy')
    expect(rules.placement({ ...base, execPath: leftover.toUpperCase(), tmpDir: temp })).toBe('temp-copy') // Windows paths ignore case
    expect(rules.placement({ ...base, execPath: `${shortTemp}\\nsyF6B5.tmp\\7z-out\\SanoVids.exe` })).toBe('temp-copy')
    expect(rules.placement({ ...base, execPath: `${temp}\\..foo\\SanoVids.exe` })).toBe('temp-copy') // a folder named "..foo" is inside
  })

  it('the real Portable (it sets PORTABLE_EXECUTABLE_FILE) is portable even though it runs from %TEMP%', () => {
    expect(rules.placement({ ...base, execPath: `${temp}\\nsA1.tmp\\app\\SanoVids.exe`, portableFile: 'E:\\USB\\SanoVids-Portable-0.6.0.exe' })).toBe('portable')
  })

  it('anything doubtful is plain portable, never temp-copy', () => {
    expect(rules.placement({ ...base, execPath: 'D:\\Apps\\SanoVids\\SanoVids.exe' })).toBe('portable') // win-unpacked / a copied exe
    expect(rules.placement({ ...base, execPath: `${temp}2\\SanoVids.exe` })).toBe('portable') // a sibling, not inside
    expect(rules.placement({ ...base, execPath: temp })).toBe('portable') // the folder itself
    expect(rules.placement({ ...base, execPath: leftover, realpath: () => { throw new Error('EACCES') } })).toBe('portable')
    expect(rules.placement({ ...base, execPath: leftover, realpath: undefined })).toBe('portable')
    expect(rules.placement({ ...base, execPath: leftover, realpath: () => 42 })).toBe('portable')
    expect(rules.placement({ ...base, execPath: leftover, tmpDir: '' })).toBe('portable')
    expect(rules.placement({ ...base, execPath: leftover, tmpDir: 'Temp' })).toBe('portable')
    expect(rules.placement({ ...base, execPath: leftover, tmpDir: undefined })).toBe('portable')
    expect(rules.placement({ ...base, execPath: '', tmpDir: temp })).toBe('portable')
    expect(rules.placement({ ...base, execPath: `${temp}\\x\u0000\\SanoVids.exe` })).toBe('portable')
    // exists() throwing is detectKind's business: portable
    expect(rules.placement({ ...base, execPath: installed, exists: () => { throw new Error('EACCES') } })).toBe('portable')
  })

  it('POSIX paths (case-sensitive)', () => {
    const px = { ...base, platform: 'linux', pathMod: posix, realpath: (p: string) => p }
    expect(rules.placement({ ...px, execPath: '/tmp/x/SanoVids', tmpDir: '/tmp' })).toBe('temp-copy')
    expect(rules.placement({ ...px, execPath: '/TMP/x/SanoVids', tmpDir: '/tmp' })).toBe('portable')
    expect(rules.placement({ ...px, execPath: '/opt/SanoVids/SanoVids', tmpDir: '/tmp' })).toBe('portable')
  })
})

describe('updater rules: the portable window pins the portable .exe (setAppDetails)', () => {
  const file = 'E:\\USB\\SanoVids-Portable-0.6.0.exe'
  const base = { platform: 'win32', isPackaged: true, portableFile: file, appName: 'SanoVids', pathMod: win, exists: (p: string) => p === file }

  it('a packaged win32 portable run → relaunch the portable file itself, with its icon and the app identity', () => {
    expect(rules.portableRelaunch(base)).toEqual({
      appId: 'com.sanovids.app',
      appIconPath: file,
      appIconIndex: 0,
      relaunchCommand: `"${file}"`,
      relaunchDisplayName: 'SanoVids',
    })
    const test = rules.portableRelaunch({ ...base, appName: 'SanoVidsIconTest' })
    expect(test!.appId).toBe(rules.appUserModelId('SanoVidsIconTest'))
    expect(test!.relaunchDisplayName).toBe('SanoVidsIconTest')
    expect(rules.portableRelaunch({ ...base, portableFile: 'E:\\USB\\SANOVIDS.EXE', exists: () => true })!.relaunchCommand).toBe('"E:\\USB\\SANOVIDS.EXE"')
  })

  it('anything else → null (nothing set)', () => {
    const bad = [
      { ...base, platform: 'linux' },
      { ...base, isPackaged: false },
      { ...base, portableFile: undefined },
      { ...base, portableFile: '' },
      { ...base, portableFile: 42 },
      { ...base, portableFile: 'SanoVids-Portable.exe', exists: () => true }, // relative
      { ...base, portableFile: 'E:\\USB\\SanoVids-Portable.bat', exists: () => true },
      { ...base, portableFile: 'E:\\USB\\SanoVids-Portable', exists: () => true },
      { ...base, portableFile: 'E:\\USB\\a" --inspect "b.exe', exists: () => true },
      { ...base, portableFile: 'E:\\USB\\a\r\nb.exe', exists: () => true },
      { ...base, portableFile: 'E:\\USB\\a\u0000.exe', exists: () => true },
      { ...base, portableFile: `E:\\${'x'.repeat(1100)}.exe`, exists: () => true },
      { ...base, exists: () => false }, // the portable file is gone
      { ...base, exists: () => { throw new Error('EACCES') } },
    ]
    for (const b of bad) expect(rules.portableRelaunch(b), JSON.stringify(b.portableFile)?.slice(0, 60)).toBeNull()
  })
})

describe('updater rules: errors become fixed Vietnamese texts', () => {
  const RAW = 'secret <xml> https://api.github.com token=abc C:\\Users\\me'
  const cases: [unknown, 'check' | 'download' | 'install', ErrorCode][] = [
    [{ code: 'HTTP_ERROR_404', message: RAW }, 'check', 'no-release'],
    [{ code: 'ERR_XML_MISSED_ELEMENT', message: RAW }, 'check', 'no-release'],
    [{ code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS', message: RAW }, 'check', 'no-release'],
    [{ code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', message: RAW }, 'check', 'no-release'],
    [{ code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', message: RAW }, 'check', 'no-release'],
    [new Error('No published versions on GitHub'), 'check', 'no-release'],
    [new Error('net::ERR_INTERNET_DISCONNECTED'), 'check', 'offline'],
    [{ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND github.com' }, 'check', 'offline'],
    [{ code: 'ECONNRESET', message: RAW }, 'download', 'offline'],
    [{ code: 'ECONNREFUSED', message: RAW }, 'check', 'offline'],
    [{ code: 'ETIMEDOUT', message: RAW }, 'check', 'offline'],
    [{ code: 'EAI_AGAIN', message: RAW }, 'check', 'offline'],
    [{ code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', message: 'Cannot find latest.yml: Error: net::ERR_NETWORK_CHANGED' }, 'check', 'offline'],
    [{ code: 'HTTP_ERROR_429', message: RAW }, 'check', 'rate-limited'],
    [{ code: 'HTTP_ERROR_403', message: RAW }, 'check', 'rate-limited'],
    // GitHubProvider wraps every failure of releases/latest in ERR_UPDATER_LATEST_VERSION_NOT_FOUND (HttpError stack inside).
    [{ code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', message: `Unable to find latest version on GitHub (${RAW}), please ensure a production release exists: HttpError: 429 Too Many Requests\nHeaders: {}\n    at x` }, 'check', 'rate-limited'],
    [{ code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', message: 'Unable to find latest version on GitHub: HttpError: 403 Forbidden\nHeaders: {}' }, 'check', 'rate-limited'],
    [{ code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', message: 'Unable to find latest version on GitHub: HttpError: 503 Service Unavailable\nHeaders: {}' }, 'check', 'failed'],
    [{ code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', message: 'Unable to find latest version on GitHub: HttpError: 404 Not Found\nHeaders: {}' }, 'check', 'no-release'],
    [{ code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', message: 'Unable to find latest version on GitHub: Error: net::ERR_CONNECTION_RESET' }, 'check', 'offline'],
    [{ code: 'ERR_CHECKSUM_MISMATCH', message: RAW }, 'download', 'checksum'],
    [new Error('sha512 checksum mismatch, expected abc, got def'), 'download', 'checksum'],
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: RAW }, 'download', 'signature'],
    // A refused signature decides before whatever its message contains (offline, HTTP status, checksum, disk).
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'New version 0.5.92 is not signed by the application owner: net::ERR_FAILED' }, 'download', 'signature'],
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'sanovids-signature:other-signer HttpError: 403 Forbidden' }, 'download', 'signature'],
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'sha512 checksum mismatch, expected a, got b' }, 'download', 'signature'],
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'ENOSPC: no space left on device' }, 'download', 'signature'],
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'sanovids-signature:other-signer' }, 'check', 'signature'],
    // Our verifier's reason picks refused ('signature') vs not decided ('signature-unverified'), still before the rest.
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'New version 0.5.92 is not signed by the application owner: sanovids-signature:not-signed' }, 'download', 'signature'],
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'x: sanovids-signature:hash-mismatch' }, 'download', 'signature'],
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'x: sanovids-signature:wrong-version' }, 'download', 'signature'],
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'x: sanovids-signature:not-newer' }, 'download', 'signature'],
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'sanovids-signature:verify-failed HttpError: 403 Forbidden' }, 'download', 'signature-unverified'],
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'sanovids-signature:policy net::ERR_FAILED' }, 'download', 'signature-unverified'],
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'sanovids-signature:bad-chain ENOSPC' }, 'download', 'signature-unverified'],
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'sanovids-signature:no-pins sha512 checksum mismatch' }, 'download', 'signature-unverified'],
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'sanovids-signature:made-up' }, 'download', 'signature'], // unknown reason: refused
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: RAW }, 'install', 'install-failed'],
    [{ code: 'ENOSPC', message: RAW }, 'download', 'disk'],
    [new Error('No update filepath provided, can\'t quit and install'), 'install', 'install-failed'],
    [{ code: 'ENOSPC', message: RAW }, 'install', 'install-failed'],
    [new Error(RAW), 'check', 'failed'],
    [new Error(RAW), 'download', 'failed'],
    [null, 'check', 'failed'],
    [undefined, 'download', 'failed'],
    ['net::ERR_FAILED', 'check', 'offline'],
    [{ code: 42, message: { evil: true } }, 'check', 'failed'],
  ]

  it('maps every known code', () => {
    for (const [err, phase, code] of cases) {
      const out = rules.mapUpdaterError(err, phase)
      expect(out.code, JSON.stringify(err)).toBe(code)
      expect(Object.keys(out).sort()).toEqual(['code', 'message'])
      expect(out.message).not.toContain('secret')
      expect(out.message).not.toContain('github')
      expect(out.message).not.toContain('<')
      expect(out.message.length).toBeLessThanOrEqual(300)
    }
  })

  it('uses the E.6 texts, with the phase for a generic failure', () => {
    expect(rules.mapUpdaterError({ code: 'ENOTFOUND' }, 'check').message).toBe('Không kết nối được máy chủ cập nhật.')
    expect(rules.mapUpdaterError({ code: 'HTTP_ERROR_404' }, 'check').message).toBe('Chưa tìm thấy bản cập nhật nào trên trang tải về.')
    expect(rules.mapUpdaterError({ code: 'HTTP_ERROR_429' }, 'check').message).toBe('Máy chủ cập nhật đang bận.')
    expect(rules.mapUpdaterError({ code: 'ERR_CHECKSUM_MISMATCH' }, 'download').message).toBe('File cập nhật tải về bị lỗi (sai mã kiểm tra) nên đã bị bỏ.')
    expect(rules.mapUpdaterError({ code: 'ERR_UPDATER_INVALID_SIGNATURE' }, 'download').message).toBe(
      'Bản cập nhật này không mang chữ ký số đúng của tác giả hoặc không đúng phiên bản được báo (có thể là file giả mạo) nên SanoVids đã xoá nó, không cài gì. Đừng tự tải bản này về cài. Chỉ cài bộ cài có dấu vân tay chứng chỉ trùng với Cài đặt → Giới thiệu, hoặc hỏi tác giả.',
    )
    expect(rules.mapUpdaterError({ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'sanovids-signature:policy' }, 'download').message).toBe(
      'Chưa kiểm tra được chữ ký số của bản cập nhật (máy đang chặn việc kiểm tra hoặc kiểm tra quá lâu) nên SanoVids chưa cài bản này. Bấm “Thử lại” để kiểm tra lại.',
    )
    for (const code of ['signature', 'signature-unverified']) {
      const text = rules.ERROR_TEXT[code]
      expect(text.length, code).toBeLessThanOrEqual(300)
      expect(text, code).toBe(text.normalize('NFC'))
      // Never sends the user to the download page: it may be the very place that served the refused file.
      expect(text, code).not.toMatch(/trang tải về|cài đè/)
    }
    expect(rules.mapUpdaterError({ code: 'ENOSPC' }, 'download').message).toBe('Ổ đĩa không đủ chỗ để tải bản cập nhật.')
    expect(rules.mapUpdaterError(new Error('x'), 'install').message).toBe('Không khởi động được trình cài bản cập nhật.')
    expect(rules.mapUpdaterError(new Error('x'), 'check').message).toBe('Không kiểm tra được bản cập nhật.')
    expect(rules.mapUpdaterError(new Error('x'), 'download').message).toBe('Tải bản cập nhật bị lỗi.')
  })
})

describe('updater rules: release notes are plain text', () => {
  it('turns GitHub HTML into markdown-ish text and decodes entities once', () => {
    const html =
      '<h2>Có gì mới</h2>\r\n<ul>\r\n<li><strong>Tự cập nhật</strong> trong nền</li>\r\n<li>Sửa &amp; dọn &lt;b&gt;lỗi&lt;/b&gt; &quot;nhỏ&quot; &#39;x&#39; &apos;y&apos; a&nbsp;b &#272;&#x110;</li>\r\n</ul>\r\n' +
      '<p>Dòng một<br>Dòng hai<br/>Dòng ba</p><script>alert(1)</script><style>p{}</style><div>Cuối &amp;lt; chữ</div>'
    expect(rules.notesToText(html)).toBe(
      '## Có gì mới\n- Tự cập nhật trong nền\n- Sửa & dọn <b>lỗi</b> "nhỏ" \'x\' \'y\' a b ĐĐ\n\nDòng một\nDòng hai\nDòng ba\nCuối &lt; chữ',
    )
  })

  it('keeps markdown as is (CRLF → LF, trailing spaces, blank lines collapsed, control chars dropped)', () => {
    expect(rules.notesToText('## Có gì mới  \r\n- ✨ **Tự cập nhật**\r\n\r\n\r\n\r\n- 🐞 Sửa lỗi\u0007 nhỏ\t\r\n')).toBe(
      '## Có gì mới\n- ✨ **Tự cập nhật**\n\n- 🐞 Sửa lỗi nhỏ',
    )
    expect(rules.notesToText('a < b and c > d')).toBe('a < b and c > d')
  })

  it('markdown with an inline tag keeps its lines (the tag is dropped, the text stays)', () => {
    expect(rules.notesToText('## Bản thử 0.5.91\n- Dòng **đậm**\n- <b>không phải HTML</b>')).toBe('## Bản thử 0.5.91\n- Dòng **đậm**\n- không phải HTML')
    expect(rules.notesToText('Thư mục `release/ban-cu/<phiên bản>/`\nDòng hai')).toBe('Thư mục `release/ban-cu/<phiên bản>/`\nDòng hai')
  })

  it('only real HTML tags count: comparisons and placeholders stay text', () => {
    expect(rules.notesToText('- Giá < 5 và > 3\n- dùng <phiên bản> mới')).toBe('- Giá < 5 và > 3\n- dùng <phiên bản> mới')
    expect(rules.notesToText('- Giá < 5 và > 3\n- <b>đậm</b> và <version>')).toBe('- Giá < 5 và > 3\n- đậm và <version>')
    expect(rules.notesToText('<p>a <x-y> b</p><img src=x onerror=alert(1)><iframe src="u"></iframe>')).toBe('a <x-y> b')
    expect(rules.notesToText('- dòng <phiên bản>\n<b>x</b>')).toBe('- dòng <phiên bản>\nx')
  })

  it('joins the full-changelog list', () => {
    expect(
      rules.notesToText([
        { version: '0.5.1', note: '<p>Hai</p>' },
        { version: '0.5.0', note: '- Một' },
        null,
        { version: 7, note: 8 },
      ]),
    ).toBe('0.5.1\nHai\n\n0.5.0\n- Một')
  })

  it('nothing → empty, never more than 8000 chars, cut at a line end', () => {
    expect(rules.notesToText(null)).toBe('')
    expect(rules.notesToText(undefined)).toBe('')
    expect(rules.notesToText(42)).toBe('')
    expect(rules.notesToText({ a: 1 })).toBe('')
    const long = Array.from({ length: 400 }, (_, i) => `- dòng số ${i} ${'x'.repeat(20)}`).join('\n')
    const out = rules.notesToText(long)
    expect(out.length).toBeLessThanOrEqual(8000)
    expect(out.endsWith('…')).toBe(true)
    expect(out.slice(0, -1).endsWith('x')).toBe(true) // a whole line
    const oneLine = rules.notesToText('y'.repeat(9000))
    expect(oneLine.length).toBe(8000)
    const emoji = rules.notesToText('😀'.repeat(5000))
    expect(emoji.length).toBeLessThanOrEqual(8000)
    expect(/[\ud800-\udbff]…$/.test(emoji)).toBe(false)
  })

  it('normalizes UpdateInfo', () => {
    expect(
      rules.normalizeInfo({
        version: '0.5.0',
        releaseDate: '2026-10-03T08:00:00.000Z',
        releaseNotes: '## Mới\n- A',
        files: [{ url: 'SanoVids-Setup-0.5.0.exe', sha512: 'x', size: 98_000_000 }],
        path: 'x',
      }),
    ).toEqual({ version: '0.5.0', releaseDate: '2026-10-03T08:00:00.000Z', notes: '## Mới\n- A', size: 98_000_000 })
    expect(rules.normalizeInfo({ version: '0.5.0', releaseDate: 'x'.repeat(100), files: [{ size: Number.NaN }] })).toEqual({
      version: '0.5.0',
      releaseDate: 'x'.repeat(40),
      notes: '',
    })
    expect(rules.normalizeInfo({ version: '0.5.0', files: [{ size: -1 }], releaseDate: 5 })).toEqual({ version: '0.5.0', notes: '' })
    expect(rules.normalizeInfo({ version: 'v0.5.0' })).toBeNull()
    expect(rules.normalizeInfo({ version: '<b>1.0.0</b>' })).toBeNull()
    expect(rules.normalizeInfo(null)).toBeNull()
    expect(rules.normalizeInfo('0.5.0')).toBeNull()
  })
})

describe('updater rules: state machine', () => {
  const info = (version: string, extra: Partial<Info> = {}): Info => ({ version, notes: `Ghi chú ${version}`, releaseDate: '2026-10-03', size: 1000, ...extra })
  const start = (kind: Kind = 'installer', autoDownload = true) => rules.initialState({ kind, current: '0.4.2', autoDownload })
  const run = (state: State, ...events: unknown[]) => events.reduce<State>((s, e) => rules.reduceUpdateState(s, e, NOW), state)
  const err = (code: ErrorCode): UpdErr => ({ code, message: rules.ERROR_TEXT[code] ?? 'x' })
  const ready = () => run(start(), { type: 'available', info: info('0.5.0') }, { type: 'downloaded', info: info('0.5.0') })
  const downloading = () =>
    run(start(), { type: 'available', info: info('0.5.0') }, { type: 'progress', p: { percent: 40, transferred: 40, total: 100, bytesPerSecond: 5 } })

  it('initial state', () => {
    expect(start()).toEqual({ kind: 'installer', current: '0.4.2', status: 'idle', autoDownload: true })
    expect(rules.initialState({ kind: 'dev', current: '0.4.2', autoDownload: false })).toEqual({
      kind: 'dev',
      current: '0.4.2',
      status: 'unsupported',
      autoDownload: false,
    })
    const notice = { kind: 'updated', from: '0.4.2', version: '0.5.0' }
    expect(rules.initialState({ kind: 'portable', current: '0.5.0', notice }).notice).toEqual(notice)
    expect(rules.initialState({ kind: 'portable', current: '0.5.0' }).autoDownload).toBe(true)
  })

  it('checking → none / available', () => {
    const checking = run(start(), { type: 'checking' })
    expect(checking.status).toBe('checking')
    const none = run(checking, { type: 'not-available' })
    expect(none).toEqual({ kind: 'installer', current: '0.4.2', status: 'none', autoDownload: true, lastCheck: NOW })
    const avail = run(checking, { type: 'available', info: info('0.5.0') })
    expect(avail).toEqual({
      kind: 'installer',
      current: '0.4.2',
      status: 'available',
      autoDownload: true,
      version: '0.5.0',
      notes: 'Ghi chú 0.5.0',
      releaseDate: '2026-10-03',
      size: 1000,
      lastCheck: NOW,
    })
    // An error is cleared by the next check; not-available clears the release data.
    const errored = run(start(), { type: 'checking' }, { type: 'check-error', error: err('offline') })
    expect(run(errored, { type: 'checking' }).error).toBeUndefined()
    expect(run(avail, { type: 'checking' }, { type: 'not-available' }).version).toBeUndefined()
  })

  it('available → downloading → ready', () => {
    const d = downloading()
    expect(d).toMatchObject({ status: 'downloading', version: '0.5.0', percent: 40, transferred: 40, total: 100, bytesPerSecond: 5 })
    const clamped = run(d, { type: 'progress', p: { percent: 140, transferred: -3, total: Number.NaN, bytesPerSecond: Infinity } })
    expect(clamped.percent).toBe(100)
    expect(clamped.transferred).toBeUndefined()
    expect(clamped.total).toBeUndefined()
    expect(clamped.bytesPerSecond).toBeUndefined()
    const r = run(d, { type: 'downloaded', info: info('0.5.0') })
    expect(r).toMatchObject({ status: 'ready', version: '0.5.0', percent: 100, notes: 'Ghi chú 0.5.0' })
    expect(r.transferred).toBeUndefined()
    expect(r.error).toBeUndefined()
  })

  it('checking / not-available never disturb a download or a ready update', () => {
    for (const s of [downloading(), ready()]) {
      expect(rules.reduceUpdateState(s, { type: 'checking' }, NOW)).toBe(s)
      const after = rules.reduceUpdateState(s, { type: 'not-available' }, NOW + 5)
      expect(after).toEqual({ ...s, lastCheck: NOW + 5 })
    }
  })

  it('the same version found again while downloading / ready keeps everything; a newer one replaces it', () => {
    const r = ready()
    expect(rules.reduceUpdateState(r, { type: 'available', info: info('0.5.0', { notes: 'khác' }) }, NOW + 9)).toEqual({ ...r, lastCheck: NOW + 9 })
    const d = downloading()
    expect(rules.reduceUpdateState(d, { type: 'available', info: info('0.5.0') }, NOW + 9)).toEqual({ ...d, lastCheck: NOW + 9 })
    const newer = run(r, { type: 'available', info: info('0.5.1') })
    expect(newer).toMatchObject({ status: 'available', version: '0.5.1', notes: 'Ghi chú 0.5.1' })
    expect(newer.percent).toBeUndefined()
    // An invalid version is ignored.
    expect(rules.reduceUpdateState(r, { type: 'available', info: { version: 'nope', notes: '' } }, NOW)).toBe(r)
    expect(rules.reduceUpdateState(r, { type: 'available', info: null }, NOW)).toBe(r)
  })

  it('check errors are silent while an update is known, shown otherwise', () => {
    const avail = run(start(), { type: 'available', info: info('0.5.0') })
    for (const s of [avail, downloading(), ready()]) {
      expect(rules.reduceUpdateState(s, { type: 'check-error', error: err('offline') }, NOW + 1)).toEqual({ ...s, lastCheck: NOW + 1 })
    }
    for (const s of [start(), run(start(), { type: 'checking' }), run(start(), { type: 'not-available' })]) {
      const e = rules.reduceUpdateState(s, { type: 'check-error', error: err('no-release') }, NOW + 1)
      expect(e).toMatchObject({ status: 'error', error: err('no-release'), lastCheck: NOW + 1 })
    }
    // Real event order: electron-updater emits checking-for-update before every result, error included.
    expect(rules.reduceUpdateState(avail, { type: 'checking' }, NOW)).toBe(avail)
    const kept = run(avail, { type: 'checking' }, { type: 'check-error', error: err('offline') })
    expect(kept).toEqual({ ...avail, lastCheck: NOW })
    expect(kept.error).toBeUndefined()
    const portable = run(start('portable'), { type: 'checking' }, { type: 'available', info: info('0.5.92') })
    expect(run(portable, { type: 'checking' }, { type: 'check-error', error: err('offline') })).toMatchObject({ status: 'available', version: '0.5.92' })
    // A re-check that finds a newer version replaces it; a withdrawn release (not-available) clears it.
    expect(run(avail, { type: 'checking' }, { type: 'available', info: info('0.5.3') })).toMatchObject({ status: 'available', version: '0.5.3' })
    expect(run(avail, { type: 'checking' }, { type: 'not-available' })).toMatchObject({ status: 'none' })
    // A malformed error never leaks: it becomes a generic one.
    const odd = rules.reduceUpdateState(start(), { type: 'check-error', error: { code: 'weird', message: 'raw' } }, NOW)
    expect(odd.error).toEqual({ code: 'failed', message: 'Không kiểm tra được bản cập nhật.' })
  })

  it('download error keeps the release (retry), cancel goes back to available', () => {
    const e = run(downloading(), { type: 'download-error', error: err('checksum') })
    expect(e).toMatchObject({ status: 'error', version: '0.5.0', notes: 'Ghi chú 0.5.0', releaseDate: '2026-10-03', size: 1000, error: err('checksum') })
    expect(e.percent).toBeUndefined()
    const retry = run(e, { type: 'progress', p: { percent: 1 } })
    expect(retry).toMatchObject({ status: 'downloading', version: '0.5.0', percent: 1 })
    expect(retry.error).toBeUndefined()
    const c = run(downloading(), { type: 'cancelled' })
    expect(c).toMatchObject({ status: 'available', version: '0.5.0' })
    expect(c.percent).toBeUndefined()
  })

  it('install error goes back to ready with install-failed; prefs', () => {
    const r = run(ready(), { type: 'install-error', error: err('install-failed') })
    expect(r).toMatchObject({ status: 'ready', version: '0.5.0', error: { code: 'install-failed', message: 'Không khởi động được trình cài bản cập nhật.' } })
    const s = start()
    expect(rules.reduceUpdateState(s, { type: 'prefs', autoDownload: true }, NOW)).toBe(s)
    expect(rules.reduceUpdateState(s, { type: 'prefs', autoDownload: false }, NOW).autoDownload).toBe(false)
    expect(rules.reduceUpdateState(s, { type: 'nope' }, NOW)).toBe(s)
    expect(rules.reduceUpdateState(s, null, NOW)).toBe(s)
  })
})

describe('updater rules: schedule, prefs, persistence, notices, log', () => {
  it('checkDue', () => {
    expect(rules.checkDue({ status: 'idle', now: NOW })).toBe(true)
    expect(rules.checkDue({ status: 'checking', now: NOW })).toBe(false)
    expect(rules.checkDue({ status: 'downloading', now: NOW })).toBe(false)
    expect(rules.checkDue({ status: 'none', lastAttemptAt: NOW - 3 * HOUR, lastErrorCode: null, now: NOW })).toBe(false)
    expect(rules.checkDue({ status: 'none', lastAttemptAt: NOW - 4 * HOUR, lastErrorCode: null, now: NOW })).toBe(true)
    expect(rules.checkDue({ status: 'ready', lastAttemptAt: NOW - 4 * HOUR, now: NOW })).toBe(true)
    expect(rules.checkDue({ status: 'error', lastAttemptAt: NOW - 29 * MIN, lastErrorCode: 'offline', now: NOW })).toBe(false)
    expect(rules.checkDue({ status: 'error', lastAttemptAt: NOW - 30 * MIN, lastErrorCode: 'offline', now: NOW })).toBe(true)
    expect(rules.checkDue({ status: 'error', lastAttemptAt: NOW - 30 * MIN, lastErrorCode: 'rate-limited', now: NOW })).toBe(true)
    expect(rules.checkDue({ status: 'error', lastAttemptAt: NOW - 30 * MIN, lastErrorCode: 'no-release', now: NOW })).toBe(false)
  })

  it('parsePrefsArg', () => {
    expect(rules.parsePrefsArg({ autoDownload: false })).toEqual({ autoDownload: false })
    expect(rules.parsePrefsArg({ autoDownload: true, feed: 'https://evil' })).toEqual({ autoDownload: true })
    for (const bad of [null, undefined, 'yes', true, [], [true], {}, { autoDownload: 'yes' }, { autoDownload: 1 }, { autoDownload: null }]) {
      expect(rules.parsePrefsArg(bad)).toBeNull()
    }
  })

  it('parseUpdaterFile survives garbage', () => {
    for (const bad of [null, undefined, '', '{', 'null', '[]', '42', { autoDownload: 'no' }, { attempt: 'x' }, []]) {
      expect(rules.parseUpdaterFile(bad)).toEqual({ autoDownload: true })
    }
    expect(rules.parseUpdaterFile('{"v":1,"autoDownload":false}')).toEqual({ autoDownload: false })
    const attempt = { version: '0.5.0', from: '0.4.2', at: NOW }
    expect(rules.parseUpdaterFile({ v: 1, autoDownload: true, attempt })).toEqual({ autoDownload: true, attempt })
    expect(rules.parseUpdaterFile({ attempt: { ...attempt, version: 'x' } })).toEqual({ autoDownload: true })
    expect(rules.parseUpdaterFile({ attempt: { ...attempt, at: -1 } })).toEqual({ autoDownload: true })
    expect(rules.parseUpdaterFile({ attempt: { ...attempt, at: '1' } })).toEqual({ autoDownload: true })
  })

  it('startupNotice: updated / install-failed / expired', () => {
    const attempt = { version: '0.5.0', from: '0.4.2', at: NOW - HOUR }
    expect(rules.startupNotice({ autoDownload: true }, '0.5.0', NOW)).toBeNull()
    expect(rules.startupNotice({ autoDownload: true, attempt }, '0.5.0', NOW)).toEqual({ kind: 'updated', from: '0.4.2', version: '0.5.0' })
    expect(rules.startupNotice({ autoDownload: true, attempt }, '0.5.2', NOW)).toEqual({ kind: 'updated', from: '0.4.2', version: '0.5.2' })
    expect(rules.startupNotice({ autoDownload: true, attempt }, '0.4.2', NOW)).toEqual({ kind: 'install-failed', version: '0.5.0' })
    expect(rules.startupNotice({ autoDownload: true, attempt: { ...attempt, at: NOW - 8 * DAY } }, '0.4.2', NOW)).toBeNull()
    expect(rules.startupNotice({ autoDownload: true, attempt }, '0.4.1', NOW)).toBeNull()
  })

  it('startupAttempt: a launch while the install on quit may still run says nothing and keeps the attempt', () => {
    expect(rules.INSTALL_GRACE_MS).toBe(2 * MIN)
    const at = (ms: number) => ({ autoDownload: true, attempt: { version: '0.5.0', from: '0.4.2', at: NOW - ms } })
    expect(rules.startupAttempt(at(10_000), '0.4.2', NOW)).toEqual({ notice: null, keep: true })
    expect(rules.startupNotice(at(10_000), '0.4.2', NOW)).toBeNull()
    expect(rules.startupAttempt(at(3 * MIN), '0.4.2', NOW)).toEqual({ notice: { kind: 'install-failed', version: '0.5.0' }, keep: false })
    // The install finished in time: updated, whatever the age.
    expect(rules.startupAttempt(at(10_000), '0.5.0', NOW)).toEqual({ notice: { kind: 'updated', from: '0.4.2', version: '0.5.0' }, keep: false })
    // Expired, from another version, or a clock that went back: nothing, cleared.
    expect(rules.startupAttempt(at(8 * DAY), '0.4.2', NOW)).toEqual({ notice: null, keep: false })
    expect(rules.startupAttempt(at(10_000), '0.4.1', NOW)).toEqual({ notice: null, keep: false })
    expect(rules.startupAttempt(at(-HOUR), '0.4.2', NOW)).toEqual({ notice: null, keep: false })
    expect(rules.startupAttempt({ autoDownload: true }, '0.4.2', NOW)).toEqual({ notice: null, keep: false })
  })

  it('logLine: one line, capped', () => {
    const d = new Date(Date.UTC(2026, 9, 3, 1, 2, 3))
    expect(rules.logLine('info', 'start 0.4.2 kind=portable', d)).toBe('2026-10-03T01:02:03.000Z [info] start 0.4.2 kind=portable')
    expect(rules.logLine('error', 'a\r\nb\nc\rd', d)).toBe('2026-10-03T01:02:03.000Z [error] a ⏎ b ⏎ c ⏎ d')
    const long = rules.logLine('debug', 'x'.repeat(10_000), d)
    expect(long.length).toBe(4000)
    expect(long.includes('\n')).toBe(false)
  })

  it('the feed constants point at the public releases repo', () => {
    expect(rules.RELEASES_URL).toBe('https://github.com/JameSteven404/sanovids-releases/releases/latest')
    expect(rules.FEED).toEqual({ provider: 'github', owner: 'JameSteven404', repo: 'sanovids-releases' })
  })
})

/** A latest.yml-style sha512 (base64 of 64 bytes). */
const sha = (seed: string) => createHash('sha512').update(seed).digest('base64')

describe('updater rules: the verified installer (install now / on quit)', () => {
  const FILE = 'C:\\Users\\me\\AppData\\Local\\sanovids-updater\\pending\\SanoVids-Setup-0.5.1.exe'
  const HASH = sha('genuine 0.5.1')
  const verified = { file: FILE, size: 98_000_000, mtimeMs: 1_759_000_000_123.5, sha512: HASH, version: '0.5.1' }
  const stat = { size: 98_000_000, mtimeMs: 1_759_000_000_123.5 }

  it('same path, size, mtime AND content → still the verified file', () => {
    expect(rules.sameVerifiedMeta(verified, stat, FILE)).toBe(true)
    expect(rules.sameVerifiedFile(verified, stat, FILE, HASH)).toBe(true)
  })

  it('same path, size and mtime but other bytes (LastWriteTime put back) → not verified', () => {
    expect(rules.sameVerifiedMeta(verified, stat, FILE)).toBe(true) // the cheap look cannot tell…
    expect(rules.sameVerifiedFile(verified, stat, FILE, sha('swapped, same size'))).toBe(false) // …the hash does
    expect(rules.sameVerifiedFile(verified, stat, FILE)).toBe(false) // no hash taken
    expect(rules.sameVerifiedFile(verified, stat, FILE, null)).toBe(false) // hashing failed
    expect(rules.sameVerifiedFile({ ...verified, sha512: undefined }, stat, FILE, undefined)).toBe(false) // never hashed
    expect(rules.sameVerifiedFile({ ...verified, sha512: 'x' }, stat, FILE, 'x')).toBe(false) // not a sha512
  })

  it('anything else → not verified (no install)', () => {
    for (const fn of [(v: unknown, s: unknown, f: unknown) => rules.sameVerifiedMeta(v, s, f), (v: unknown, s: unknown, f: unknown) => rules.sameVerifiedFile(v, s, f, HASH)]) {
      expect(fn(null, stat, FILE)).toBe(false) // never verified / refused
      expect(fn(verified, null, FILE)).toBe(false) // stat failed: the file is gone
      expect(fn(verified, stat, FILE.replace('0.5.1', '0.5.2'))).toBe(false) // another installer
      expect(fn(verified, stat, FILE.toLowerCase())).toBe(false)
      expect(fn(verified, stat, null)).toBe(false)
      expect(fn(verified, stat, '')).toBe(false)
      expect(fn(verified, { ...stat, size: stat.size + 1 }, FILE)).toBe(false) // replaced after the check
      expect(fn(verified, { ...stat, mtimeMs: stat.mtimeMs + 1 }, FILE)).toBe(false)
      expect(fn(verified, { size: stat.size }, FILE)).toBe(false)
      expect(fn({ ...verified, file: '' }, stat, '')).toBe(false)
      expect(fn('x', stat, FILE)).toBe(false)
    }
  })

  it('the cached blockmap next to a pending installer (dropped when that installer is refused / not installed)', () => {
    expect(rules.cachedBlockmapFile(FILE, win)).toBe('C:\\Users\\me\\AppData\\Local\\sanovids-updater\\current.blockmap')
    expect(rules.cachedBlockmapFile('C:\\x\\sanovids-updater\\PENDING\\temp-a.exe', win)).toBe('C:\\x\\sanovids-updater\\current.blockmap')
    expect(rules.cachedBlockmapFile('/home/me/.cache/sanovids-updater/pending/a.exe', posix)).toBe('/home/me/.cache/sanovids-updater/current.blockmap')
    // Not in a "pending" folder: never guess another folder to delete in.
    for (const bad of ['C:\\x\\sanovids-updater\\a.exe', 'C:\\Users\\me\\Downloads\\SanoVids-Setup.exe', 'C:\\pending', '', null, 42]) {
      expect(rules.cachedBlockmapFile(bad, win), String(bad)).toBeNull()
    }
    expect(rules.cachedBlockmapFile(FILE, null)).toBeNull()
  })
})

describe('updater rules: the file must BE the offered update (anti-rollback, anti-swap)', () => {
  const signed: SigVerdict = { ok: true, status: 'signed', reason: 'ok', timestamped: true, productVersion: '0.5.1', productName: 'SanoVids' }
  const expected = { version: '0.5.1', current: '0.5.0', appName: 'SanoVids', size: 98_000_000 }
  const problem = (v: Partial<SigVerdict>, e: Partial<typeof expected> = {}) => rules.installerIdentityProblem({ ...signed, ...v }, { ...expected, ...e })

  it('the offered, newer installer of this app → accepted', () => {
    expect(problem({})).toBe('')
    expect(problem({ productVersion: '0.6.0-beta.2' }, { version: '0.6.0-beta.2' })).toBe('')
    expect(problem({ productName: 'SanoVidsUpdTest' }, { appName: 'SanoVidsUpdTest' })).toBe('') // test identities
    expect(rules.INSTALLER_MIN_BYTES).toBe(20 * 1024 * 1024)
    expect(problem({}, { size: rules.INSTALLER_MIN_BYTES })).toBe('')
  })

  it('an older genuine release offered as a new version → wrong-version (the feed labels it, the signed file does not lie)', () => {
    expect(problem({ productVersion: '0.4.2' }, { version: '9.9.9' })).toBe('wrong-version')
    expect(problem({ productVersion: '0.5.2' })).toBe('wrong-version') // another newer build than the one offered
    expect(problem({ productVersion: '0.5.1.0' })).toBe('wrong-version') // the app exe's own "x.y.z.0"
    expect(problem({ productVersion: '1, 0, 0, 2894' })).toBe('wrong-version') // elevate.exe
    expect(problem({ productVersion: undefined })).toBe('wrong-version') // no VersionInfo / an older script
    expect(problem({}, { version: '' })).toBe('wrong-version')
    expect(problem({}, { version: 'garbage' })).toBe('wrong-version')
  })

  it('offered and signed as the running version or older → not-newer', () => {
    expect(problem({ productVersion: '0.5.0' }, { version: '0.5.0' })).toBe('not-newer')
    expect(problem({ productVersion: '0.4.2' }, { version: '0.4.2' })).toBe('not-newer')
    expect(problem({ productVersion: '0.5.0-beta.1' }, { version: '0.5.0-beta.1' })).toBe('not-newer')
    expect(problem({}, { current: 'nope' })).toBe('not-newer')
  })

  it('another product, or a signed file that is not an installer (uninstaller, elevate.exe) → refused', () => {
    expect(problem({ productName: 'Elevate Application' })).toBe('wrong-product')
    expect(problem({ productName: undefined })).toBe('wrong-product')
    expect(problem({ productName: 'sanovids' })).toBe('wrong-product')
    expect(problem({}, { appName: '' })).toBe('wrong-product')
    expect(problem({}, { size: 380_000 })).toBe('not-installer') // "Uninstall SanoVids.exe"
    expect(problem({}, { size: -1 })).toBe('not-installer') // stat failed
    expect(problem({}, { size: Number.NaN })).toBe('not-installer')
    expect(rules.installerIdentityProblem(null, expected)).toBe('wrong-version')
    expect(rules.installerIdentityProblem(signed, null)).toBe('wrong-version')
  })

  it('every identity problem is a refusal (error "signature"), never "unverified"', () => {
    for (const r of ['wrong-version', 'not-newer', 'wrong-product', 'not-installer', 'changed']) {
      expect(rules.SIGNATURE_REFUSED_REASONS).toContain(r)
      expect(rules.signatureErrorCode(r)).toBe('signature')
    }
    for (const r of ['not-signed', 'hash-mismatch', 'other-signer']) expect(rules.signatureErrorCode(r)).toBe('signature')
    for (const r of ['bad-chain', 'verify-failed', 'no-pins', 'policy', 'no-file', 'inactive']) expect(rules.signatureErrorCode(r)).toBe('signature-unverified')
    for (const r of ['', 'x', null, undefined]) expect(rules.signatureErrorCode(r)).toBe('signature')
    expect(rules.signatureReasonOf('New version 0.5.2 is not signed by the application owner: sanovids-signature:other-signer')).toBe('other-signer')
    expect(rules.signatureReasonOf('sanovids-signature:policy')).toBe('policy')
    expect(rules.signatureReasonOf('sanovids-signature:invented')).toBe('')
    expect(rules.signatureReasonOf(42)).toBe('')
  })
})

describe('updater rules: refused files are remembered by checksum (updater.json)', () => {
  const A = sha('file A')
  const B = sha('file B')
  const C = sha('file C')
  const entry = (sha512: string, reason = 'other-signer', at = NOW, version = '0.5.92'): Rejected => ({ version, sha512, reason, at })

  it('isSha512 / offerHashes read latest.yml checksums only', () => {
    expect(rules.isSha512(A)).toBe(true)
    for (const bad of ['', 'abc', `${A}x`, A.slice(1), null, 42]) expect(rules.isSha512(bad)).toBe(false)
    expect(rules.offerHashes({ version: '0.5.92', files: [{ url: 'SanoVids-Setup-0.5.92.exe', sha512: A, size: 1 }, { url: 'x.zip', sha512: B }], sha512: A })).toEqual([A, B])
    expect(rules.offerHashes({ files: [{ sha512: 'nope' }, null, 'x'], sha512: C })).toEqual([C])
    for (const bad of [null, undefined, 'x', {}, { files: 'x' }]) expect(rules.offerHashes(bad)).toEqual([])
    const many = Array.from({ length: 12 }, (_, i) => ({ sha512: sha(`f${i}`) }))
    expect(rules.offerHashes({ files: many })).toHaveLength(8)
  })

  it('parseUpdaterFile keeps valid entries only (the last 5); updaterFileData writes them back', () => {
    const file = rules.parseUpdaterFile({ v: 1, autoDownload: false, rejected: [entry(A), { ...entry(B), reason: 'nope' }, { ...entry(C), sha512: 'short' }, { ...entry(C), version: 'x' }, { ...entry(C), at: -1 }, 'junk', null] })
    expect(file).toEqual({ autoDownload: false, rejected: [entry(A)] })
    expect(rules.parseUpdaterFile({ rejected: [] })).toEqual({ autoDownload: true })
    expect(rules.parseUpdaterFile({ rejected: 'x' })).toEqual({ autoDownload: true })
    const seven = Array.from({ length: 7 }, (_, i) => entry(sha(`r${i}`), 'not-signed', NOW + i))
    expect(rules.parseUpdaterFile({ rejected: seven }).rejected).toEqual(seven.slice(-rules.REJECTED_MAX))
    expect(rules.REJECTED_MAX).toBe(5)
    const attempt = { version: '0.5.0', from: '0.4.2', at: NOW }
    expect(rules.updaterFileData({ autoDownload: true, attempt, rejected: [entry(A), { bad: 1 }] })).toEqual({ v: 1, autoDownload: true, attempt, rejected: [entry(A)] })
    expect(rules.updaterFileData({ autoDownload: false })).toEqual({ v: 1, autoDownload: false })
    expect(rules.updaterFileData(null)).toEqual({ v: 1, autoDownload: true })
    // Round trip.
    expect(rules.parseUpdaterFile(JSON.stringify(rules.updaterFileData({ autoDownload: true, rejected: [entry(A)] })))).toEqual({ autoDownload: true, rejected: [entry(A)] })
  })

  it('rememberRejected replaces the same file, caps the list, ignores invalid entries', () => {
    let list = rules.rememberRejected(undefined, { version: '0.5.92', sha512: A, reason: 'other-signer' }, NOW)
    expect(list).toEqual([entry(A)])
    list = rules.rememberRejected(list, { version: '0.5.92', sha512: A, reason: 'hash-mismatch' }, NOW + 5)
    expect(list).toEqual([entry(A, 'hash-mismatch', NOW + 5)])
    expect(rules.rememberRejected(list, { version: '0.5.92', sha512: null, reason: 'other-signer' }, NOW)).toEqual(list) // no checksum
    expect(rules.rememberRejected(list, { version: '0.5.92', sha512: B, reason: '' }, NOW)).toEqual(list)
    for (let i = 0; i < 8; i++) list = rules.rememberRejected(list, { version: '0.5.93', sha512: sha(`n${i}`), reason: 'not-signed' }, NOW + i)
    expect(list).toHaveLength(5)
    expect(list.some((e) => e.sha512 === A)).toBe(false) // the oldest went first
  })

  it('findRejected: matched by checksum only; refused files stay refused, undecided ones retry a day later', () => {
    const list = [entry(A, 'other-signer', NOW - 30 * DAY), entry(B, 'policy', NOW - HOUR)]
    expect(rules.findRejected(list, [A], NOW)).toEqual(list[0]) // refused long ago: still refused
    expect(rules.findRejected(list, [C, A], NOW)?.sha512).toBe(A)
    expect(rules.findRejected(list, [C], NOW)).toBeNull() // a re-uploaded, other file under the same version downloads
    expect(rules.findRejected(list, [B], NOW)).toEqual(list[1]) // undecided an hour ago: not again yet
    expect(rules.UNVERIFIED_RETRY_MS).toBe(DAY)
    expect(rules.findRejected(list, [B], NOW - HOUR + DAY)).toBeNull() // a day later: tried again
    expect(rules.findRejected([entry(B, 'verify-failed', NOW + HOUR)], [B], NOW)).toBeNull() // clock went back: retried
    expect(rules.findRejected(list, [], NOW)).toBeNull() // no checksum announced: nothing to match
    expect(rules.findRejected(list, null, NOW)).toBeNull()
    expect(rules.findRejected('junk', [A], NOW)).toBeNull()
  })

  it('forgetRejected ("Thử lại") drops the entries of the offered files only', () => {
    const list = [entry(A), entry(B, 'policy'), entry(C)]
    expect(rules.forgetRejected(list, [B, C])).toEqual([entry(A)])
    expect(rules.forgetRejected(list, [])).toEqual(list)
    expect(rules.forgetRejected(list, null)).toEqual(list)
    expect(rules.forgetRejected(null, [A])).toEqual([])
  })
})

describe('signature rules: ConstrainedLanguage, clock skew / expiry, VersionInfo, the child environment', () => {
  const PIN = '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'
  const GENUINE = {
    v: 1,
    status: 1,
    sigType: 'Authenticode',
    thumbprint: PIN,
    signer: 'Nguyễn Giang Minh (Jame Steven)',
    tsThumbprint: '51D9ABDA034973D84F4266ACA48248E6B369C439',
    chainOk: true,
    chainStatus: ['UntrustedRoot'],
    chainLen: 1,
    hresult: '0x800B0109',
    error: null as string | null,
  }
  const judge = (patch: Record<string, unknown>) => rules.judgeSignature({ ...GENUINE, ...patch }, [PIN])

  it('the script says when PowerShell runs in ConstrainedLanguage (before anything that would fail there)', () => {
    const s = rules.SIGNATURE_SCRIPT
    const guard = "if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){ Write-Output ('SVSIG'+(@{v=1;status=-1;error='clm'}|ConvertTo-Json -Compress)+'SVSIG'); exit }"
    expect(s).toContain(guard)
    expect(s.indexOf(guard)).toBeLessThan(s.indexOf('$r=[ordered]'))
    expect(s.indexOf(guard)).toBeLessThan(s.indexOf('GetType()'))
    expect(s.startsWith("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; if($ExecutionContext")).toBe(true)
    // Real output of that branch (PowerShell 5.1, session switched to ConstrainedLanguage).
    const parsed = rules.parseSignatureOutput('SVSIG{"status":-1,"error":"clm","v":1}SVSIG\r\n')
    expect(rules.judgeSignature(parsed, [PIN])).toEqual({ ok: false, status: 'unknown', reason: 'policy', timestamped: false })
    expect(rules.judgeSignature(parsed, [])).toMatchObject({ reason: 'no-pins' }) // row 1 first
    expect(rules.judgeSignature({ ...parsed, v: 2 }, [PIN])).toMatchObject({ reason: 'verify-failed' })
    expect(rules.signatureErrorCode('policy')).toBe('signature-unverified')
  })

  it('reads the signed VersionInfo; the chain ignores NotTimeValid only when timestamped', () => {
    const s = rules.SIGNATURE_SCRIPT
    expect(s).toContain('try { $vi=(Get-Item -LiteralPath $p).VersionInfo; $r.productVersion=[string]$vi.ProductVersion; $r.productName=[string]$vi.ProductName } catch { $r.productVersion=$null }')
    expect(s).toContain("$fl='AllowUnknownCertificateAuthority'; if($null -ne $r.tsThumbprint){$fl+=',IgnoreNotTimeValid'}")
    expect(s.indexOf('$r.tsThumbprint=$s.TimeStamperCertificate.Thumbprint')).toBeLessThan(s.indexOf('IgnoreNotTimeValid'))
    expect(s).toContain('X509VerificationFlags]$fl')
    expect(s).not.toMatch(/\}\s*;\s*catch/)
    expect(s.includes('"') || s.includes('\n') || s.includes('`')).toBe(false)
  })

  it('timestamped: a chain that also says NotTimeValid (PC clock behind, certificate expired since) → still signed', () => {
    expect(judge({ chainStatus: ['UntrustedRoot', 'NotTimeValid'] })).toMatchObject({ ok: true, status: 'signed', timestamped: true })
    expect(judge({ chainStatus: ['NotTimeValid', 'UntrustedRoot'] })).toMatchObject({ ok: true })
    expect(judge({ status: 0, hresult: '0x00000000', chainStatus: ['NotTimeValid'], chainLen: 2 })).toMatchObject({ ok: true }) // 7a
    // Not timestamped: the clock is all there is → bad-chain.
    expect(judge({ chainStatus: ['UntrustedRoot', 'NotTimeValid'], tsThumbprint: null })).toMatchObject({ ok: false, reason: 'bad-chain' })
    expect(judge({ status: 0, hresult: '0x00000000', chainStatus: ['NotTimeValid'], tsThumbprint: null })).toMatchObject({ reason: 'bad-chain' })
    // WinVerifyTrust itself refusing the time (CERT_E_EXPIRED at the signing time) stays refused.
    expect(judge({ hresult: '0x800B0101', chainStatus: ['UntrustedRoot', 'NotTimeValid'] })).toMatchObject({ reason: 'bad-chain' })
    // Other flags, a NotTimeValid without the untrusted root in 7b, duplicates or a longer chain stay bad-chain.
    expect(judge({ chainStatus: ['NotTimeValid'] })).toMatchObject({ reason: 'bad-chain' })
    expect(judge({ chainStatus: ['UntrustedRoot', 'NotTimeValid', 'Revoked'] })).toMatchObject({ reason: 'bad-chain' })
    expect(judge({ chainStatus: ['UntrustedRoot', 'UntrustedRoot'] })).toMatchObject({ reason: 'bad-chain' })
    expect(judge({ chainStatus: ['UntrustedRoot', 'NotTimeValid'], chainLen: 2 })).toMatchObject({ reason: 'bad-chain' })
    expect(judge({ chainStatus: ['UntrustedRoot', 'NotTimeValid'], chainOk: false })).toMatchObject({ reason: 'bad-chain' })
  })

  it('product fields: parsed when present, passed on only with a signed verdict', () => {
    const wrap = (o: unknown) => `SVSIG${JSON.stringify(o)}SVSIG`
    const p = rules.parseSignatureOutput(wrap({ ...GENUINE, productVersion: ' 0.5.1 ', productName: 'Sano\u0007Vids' }))
    expect(p).toMatchObject({ productVersion: '0.5.1', productName: 'SanoVids' })
    expect(rules.judgeSignature(p, [PIN])).toEqual({
      ok: true,
      status: 'signed',
      reason: 'ok',
      thumbprint: PIN,
      signer: 'Nguyễn Giang Minh (Jame Steven)',
      productVersion: '0.5.1',
      productName: 'SanoVids',
      timestamped: true,
    })
    // Empty / missing / not strings → absent (an older script, a non-PE file).
    const empty = rules.parseSignatureOutput(wrap({ ...GENUINE, productVersion: '', productName: null }))
    expect(empty).not.toHaveProperty('productVersion')
    expect(empty).not.toHaveProperty('productName')
    expect(rules.parseSignatureOutput(wrap({ ...GENUINE, productVersion: 7 }))).not.toHaveProperty('productVersion')
    expect((rules.parseSignatureOutput(wrap({ ...GENUINE, productVersion: '1'.repeat(100) }))?.productVersion as string).length).toBe(64)
    // Not on a refusal (nobody may act on a product name of an unverified file).
    expect(rules.judgeSignature({ ...p, thumbprint: '5B768D22' + '0123456789ABCDEF0123456789ABCDEF' }, [PIN])).not.toHaveProperty('productVersion')
    expect(rules.judgeSignature({ ...p, status: 3 }, [PIN])).not.toHaveProperty('productName')
  })

  it('powershellEnv drops CLR profiler / runtime injection variables (any case), keeps the rest', () => {
    const env = rules.powershellEnv(
      {
        Path: 'C:\\Windows',
        SystemRoot: 'C:\\Windows',
        COR_ENABLE_PROFILING: '1',
        cor_profiler: '{guid}',
        COR_PROFILER_PATH_64: 'D:\\evil.dll',
        COMPlus_Version: 'v2',
        complus_etwenabled: '0',
        DOTNET_gcServer: '1',
        CORECLR_ENABLE_PROFILING: '1',
        PSModulePath: 'x',
        __PSLockdownPolicy: '4', // a policy marker is never removed
      },
      'D:\\a.exe',
    )
    expect(env).toEqual({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', __PSLockdownPolicy: '4', SANOVIDS_SIG_PATH: 'D:\\a.exe' })
  })
})

describe('electron-updater internals the pinned verifier relies on (6.8.10)', () => {
  const read = (rel: string) => nodeFs.readFileSync(nodePath.join(process.cwd(), 'node_modules', 'electron-updater', 'out', rel), 'utf8')

  it('NsisUpdater awaits this.verifySignature on every download (our instance override replaces it)', () => {
    const nsis = read('NsisUpdater.js')
    expect(nsis).toContain('async verifySignature(tempUpdateFile)')
    expect(nsis).toContain('await this.verifySignature(destinationFile)')
    expect(nsis).toContain('"ERR_UPDATER_INVALID_SIGNATURE"')
    // …and its own implementation skips the check when app-update.yml has no publisherName: why we override it.
    expect(nsis).toMatch(/publisherName == null\) \{\s*return null;/)
  })

  it('BaseUpdater reads autoInstallOnAppQuit again at quit time and installs this.installerPath', () => {
    const base = read('BaseUpdater.js')
    expect(base).toContain('this.autoInstallOnAppQuit')
    expect(base).toMatch(/this\.app\.onQuit\(exitCode => \{[\s\S]*?if \(!this\.autoInstallOnAppQuit\)/)
    expect(base).toContain('return this.downloadedUpdateHelper == null ? null : this.downloadedUpdateHelper.file;')
    // The download helper's done(): 'update-downloaded' is emitted from here (our async check runs after it).
    expect(base).toMatch(/done: event => \{\s*this\.dispatchUpdateDownloaded\(event\);\s*this\.addQuitHandler\(\);/)
  })

  it('AppUpdater / DownloadedUpdateHelper: the cache housekeeping updater.cjs relies on', () => {
    const appUpdater = read('AppUpdater.js')
    const helper = read('DownloadedUpdateHelper.js')
    // Cleared after an update: pending\ is only emptied when a new download starts.
    expect(appUpdater).toContain('async getOrCreateDownloadHelper()')
    expect(helper).toContain('async clear()')
    expect(helper).toMatch(/async clear\(\) \{[\s\S]*?await this\.cleanCacheDirForPendingUpdate\(\);/)
    expect(helper).toContain('return path.join(this.cacheDir, "pending");')
    // …and swallows any error (a file still locked by the installer that just ran): updater.cjs lists and retries.
    expect(helper).toMatch(/async cleanCacheDirForPendingUpdate\(\) \{\s*try \{[\s\S]*?emptyDir\)\(this\.cacheDirForPendingUpdate\);\s*\}\s*catch \(_ignore\)/)
    // done() copies the NEW version's blockmap next to the cached installer.exe: stale once that version is refused.
    expect(appUpdater).toContain('const cachedBlockMapFile = path.join(downloadedUpdateHelper.cacheDir, "current.blockmap");')
    expect(appUpdater).toContain('await (0, fs_extra_1.copyFile)(pendingBlockMapFile, cachedBlockMapFile);')
    expect(appUpdater).toContain('let oldBlockMapData = await getBlockMapFromCacheDir(this.downloadedUpdateHelper.cacheDir);')
    // The download is sha512-checked against latest.yml (so a refused file's checksum is the announced one).
    expect(appUpdater).toContain('sha512: fileInfo.info.sha512,')
  })

  it('updater.cjs installs our verifier on both hooks and re-verifies (signature, identity, content) before installing', () => {
    expect(updaterSource).toContain('updater.verifySignature =')
    expect(updaterSource).toContain('updater.verifyUpdateCodeSignature =')
    expect(updaterSource).toContain("require('./signature.cjs')")
    expect(updaterSource).toContain('signature.readSignerPins()')
    expect(updaterSource).toContain("updater.on('update-downloaded', (info) => void onDownloaded(info))")
    expect(updaterSource).toContain('rules.installerIdentityProblem(v, { version, current, appName, size })')
    expect(updaterSource).toContain('verifyDownloaded(au.installerPath, state.version, readyHashes)')
    expect(updaterSource).toContain('rules.sameVerifiedMeta(verified, stat, au.installerPath)')
    expect(updaterSource).toContain('rules.sameVerifiedFile(verified, st, target, sha512)')
    expect(updaterSource).toContain("log.warn('install on quit skipped: installer not verified')")
    // The synchronous re-hash runs right before quitAndInstall (inside the same setImmediate).
    expect(updaterSource).toMatch(/setImmediate\(\(\) => \{\s*\/\/[^\n]*\n\s*const still = installerStillVerified\(\)[\s\S]*?au\.quitAndInstall\(true, true\)/)
    // …and in the quit event when electron-updater would install now.
    expect(updaterSource).toContain('if (intact && wouldInstall) intact = installerStillVerified().ok')
    // Refused files: remembered by checksum, matched on 'available', forgotten by a manual retry.
    expect(updaterSource).toContain('rules.findRejected(file.rejected, offerHashes, Date.now())')
    expect(updaterSource).toContain('rules.forgetRejected(file.rejected, offerHashes)')
    expect(updaterSource).toContain('rules.updaterFileData(file)')
    expect(updaterSource).not.toContain('new Set()') // no per-launch, per-version memory any more
    // Cache housekeeping.
    expect(updaterSource).toContain('.then(() => au.getOrCreateDownloadHelper())')
    expect(updaterSource).toContain('await helper.clear()')
    // clear() swallows errors (the just-run installer may still hold its file): the folder is listed and retried.
    expect(updaterSource).toContain('fs.readdirSync(helper.cacheDirForPendingUpdate)')
    expect(updaterSource).toContain('const PENDING_CLEAR_RETRY_MS = [5_000, 20_000, 60_000]')
    expect(updaterSource).toContain("downloadInFlight || quittingForUpdate || state.status === 'downloading' || state.status === 'ready'")
    expect(updaterSource).toContain('cacheTidy = clearPendingAfterUpdate(0)')
    expect(updaterSource).toContain("notice && notice.kind === 'updated'")
    expect(updaterSource).toContain('cacheTidy\n      .then(() => au.downloadUpdate())')
    expect(updaterSource).toContain('rules.cachedBlockmapFile(installer, path)')
    expect(updaterSource).toContain('if (stat) dropCachedBlockmap(au.installerPath)')
    // No direct 'downloaded' dispatch from the electron-updater event any more.
    expect(updaterSource).not.toMatch(/on\('update-downloaded', \(info\) => dispatch\(/)
    // updater.json is never rewritten without the refused files (only the attempt is dropped).
    expect(updaterSource).not.toContain('file = { autoDownload: file.autoDownload }')
  })
})

describe('packaging guarantees (package.json, preload, main)', () => {
  const RENDERER_LIBS = [
    '@fontsource/be-vietnam-pro',
    '@fontsource/jetbrains-mono',
    '@xyflow/react',
    'idb-keyval',
    'jszip',
    'lucide-react',
    'react',
    'react-dom',
    'zundo',
    'zustand',
  ]

  it('electron-updater is the only runtime dependency; renderer libs are bundled devDependencies', () => {
    expect(pkg.dependencies).toEqual({ 'electron-updater': '6.8.10' })
    for (const lib of RENDERER_LIBS) {
      expect(pkg.dependencies[lib], lib).toBeUndefined()
      expect(pkg.devDependencies[lib], lib).toBeTruthy()
    }
    expect(pkg.devDependencies['js-yaml']).toBe('^4.1.0')
  })

  it('build.files no longer drops node_modules and keeps the other entries in order', () => {
    expect(pkg.build.files).toEqual(['dist/**/*', '!dist/sw.js', '!dist/workbox-*.js', '!dist/assets/*.woff', 'electron/**/*', 'package.json'])
    expect(pkg.build.files.some((f) => f.includes('node_modules'))).toBe(false)
  })

  it('publishes to the public releases repo, never with a token', () => {
    expect(pkg.build.publish).toEqual([{ provider: 'github', owner: 'JameSteven404', repo: 'sanovids-releases', releaseType: 'release' }])
    for (const key of ['token', 'private', 'channel', 'publisherName']) expect(pkg.build.publish[0][key], key).toBeUndefined()
  })

  it('scripts: never auto-publish', () => {
    expect(pkg.scripts['dist:win']).toContain('--publish never')
    expect(pkg.scripts['dist:win']).toMatch(/^node scripts\/update-notes\.mjs && /)
    expect(pkg.scripts.release).toBeUndefined() // electron-builder auto-publishes when npm_lifecycle_event === 'release'
    expect(pkg.scripts['release:check']).toBe('node scripts/publish-release.mjs --dry-run')
    expect(pkg.scripts['release:publish']).toBe('node scripts/publish-release.mjs')
  })

  it('the test-only data folder key never ships', () => {
    expect(pkgSource).not.toContain('sanovidsTestProfileDir')
  })

  it('preload exposes exactly the updates API', () => {
    const block = /updates: \{([\s\S]*?)\n {2}\},\n\}\)/.exec(preloadSource)
    expect(block).not.toBeNull()
    const keys = [...block![1].matchAll(/^ {4}(\w+): /gm)].map((m) => m[1])
    expect(keys).toEqual(['getState', 'check', 'download', 'install', 'setPrefs', 'openReleasePage', 'onState'])
    expect(preloadSource).toContain("'updates:state'")
    for (const ch of ['getState', 'check', 'download', 'install', 'setPrefs', 'openReleasePage']) expect(preloadSource).toContain(`'updates:${ch}'`)
  })

  it('main.cjs resolves the data folder before the single-instance lock', () => {
    const req = mainSource.indexOf("require('./updater-rules.cjs')")
    const lock = mainSource.indexOf('requestSingleInstanceLock')
    expect(req).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(req)
    expect(mainSource.indexOf("app.setPath('userData', profile.dir)")).toBeLessThan(lock)
    expect(mainSource).toContain('process.exit(2)')
    expect(mainSource).not.toMatch(/forceDevUpdateConfig\s*=\s*true|setFeedURL\(/)
    // The guard sees through links (realpath) to the real folder.
    expect(mainSource).toContain('fsMod: { existsSync: fs.existsSync, realpathSync: fs.realpathSync.native }')
  })

  it('updater-rules.cjs requires nothing (main, updater and scripts share it; app.asar cannot resolve npm helpers from electron/)', () => {
    const code = rulesSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\brequire\s*\(/)
    expect(code).not.toMatch(/\bimport\s*\(/)
  })

  it('main.cjs: placement and the portable taskbar identity come from updater-rules (no path crosses to the page)', () => {
    expect(mainSource.split('updaterRules.placement(').length - 1).toBe(1)
    expect(mainSource.split('updaterRules.portableRelaunch(').length - 1).toBe(1)
    expect(mainSource).toContain('realpath: fs.realpathSync.native,')
    expect(mainSource).toContain('portableFile: process.env.PORTABLE_EXECUTABLE_FILE,')
    expect(mainSource).toContain('win.setAppDetails(relaunch)')
  })

  it('main.cjs records the install-on-quit attempt in the app quit event (never for a vetoed quit)', () => {
    expect(mainSource).toContain("app.on('quit', (_event, exitCode) => updater && updater.onQuit(exitCode))")
    expect(mainSource).not.toContain('onBeforeQuit')
  })
})
