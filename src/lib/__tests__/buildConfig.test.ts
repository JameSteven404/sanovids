// package.json build configuration: author / copyright / publisher strings, code signing with the pinned
// certificate, Electron fuses, installer icons + license page, the signer pins read by the app, and the license /
// certificate files the installer ships — plus the macOS build (Apple Silicon, ad hoc "-", hardened runtime, no
// notarization, licences inside the app, dmg + zip, dist:mac). electron-builder reads all of this at build time, so a
// silent change here would ship an unsigned or mis-credited release.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import pkgSource from '../../../package.json?raw'

const AUTHOR = 'Nguyễn Giang Minh (Jame Steven)'
const COPYRIGHT_BUILD = '© 2026 Nguyễn Giang Minh (Jame Steven) · Đồng hành: Sano Group'
const PIN = '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'
const BOM = [0xef, 0xbb, 0xbf]

interface Author {
  name: string
  url?: string
  email?: string
}
interface Pkg {
  name: string
  productName: string
  version: string
  description: string
  author: Author
  homepage: string
  sanovids: { signers: string[]; devUnlockKeys?: unknown }
  scripts: Record<string, string>
  build: Record<string, unknown> & {
    copyright: string
    icon: string
    extraMetadata: { author: Author } & Record<string, unknown>
    extraFiles: unknown
    electronFuses: Record<string, boolean>
    win: Record<string, unknown> & { signtoolOptions: Record<string, unknown>; extraFiles: unknown }
    mac: Record<string, unknown> & { extraResources: { from: string; to: string }[]; extendInfo: Record<string, string>; target: unknown }
    dmg: Record<string, unknown> & { contents: Record<string, unknown>[] }
    nsis: Record<string, unknown>
    publish: Record<string, unknown>[]
  }
}

const pkg = JSON.parse(pkgSource) as Pkg
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel))
const nodeRequire = createRequire(import.meta.url)

describe('author, copyright and publisher', () => {
  it('every author string is the exact NFC author name', () => {
    const names = [pkg.author.name, pkg.build.extraMetadata.author.name, pkg.build.win.signtoolOptions.publisherName]
    for (const name of names) {
      expect(name).toBe(AUTHOR)
      expect(name).toBe((name as string).normalize('NFC'))
    }
    expect(pkg.author).toEqual({ name: AUTHOR })
    expect(pkg.build.copyright).toBe(COPYRIGHT_BUILD)
    expect(pkg.build.copyright).toBe(pkg.build.copyright.normalize('NFC'))
    // Sano Group is a partner, never the author.
    expect(pkg.author.name).not.toContain('Sano')
    expect(pkg.build.copyright).toMatch(/· Đồng hành: Sano Group$/)
  })

  it('the full author name survives electron-builder package normalization (via extraMetadata)', () => {
    const { normalizePackageData } = nodeRequire('app-builder-lib/out/util/normalizePackageData') as {
      normalizePackageData: (data: unknown) => void
    }
    const { deepAssign } = nodeRequire('builder-util-runtime') as { deepAssign: (target: unknown, ...objects: unknown[]) => unknown }

    // Without extraMetadata the "(Jame Steven)" part is parsed as a URL and dropped from CompanyName / Publisher.
    // If this ever stops happening upstream, extraMetadata.author is harmless but this guard should be revisited.
    const plain = structuredClone(pkg)
    normalizePackageData(plain)
    expect(plain.author.name).not.toBe(AUTHOR)
    expect(plain.author.name).toBe('Nguyễn Giang Minh')

    const fixed = structuredClone(pkg)
    normalizePackageData(fixed)
    deepAssign(fixed, pkg.build.extraMetadata)
    expect(fixed.author.name).toBe(AUTHOR)
  })

  it('extraMetadata only carries the author (test pins are added by test configs, never here)', () => {
    expect(pkg.build.extraMetadata).toEqual({ author: { name: AUTHOR } })
  })
})

describe('code signing', () => {
  it('build.win signs every exe and the unsigned Electron DLLs with the pinned certificate', () => {
    expect(pkg.build.win).toEqual({
      target: ['nsis', 'portable'],
      icon: 'build/icon.ico',
      forceCodeSigning: true,
      signExts: ['ffmpeg.dll', 'vk_swiftshader.dll', 'vulkan-1.dll', 'dxcompiler.dll'],
      signtoolOptions: {
        certificateSha1: PIN,
        signingHashAlgorithms: ['sha256'],
        rfc3161TimeStampServer: 'http://timestamp.digicert.com',
        publisherName: AUTHOR,
      },
      // moved down from build.extraFiles (a top-level list would land in SanoVids.app/Contents and break codesign);
      // electron-builder unions both lists, so the Windows result is the same
      extraFiles: [
        { from: 'LICENSE.txt', to: 'LICENSE.txt' },
        { from: 'build/license-third-party.txt', to: 'THIRD-PARTY-NOTICES.txt' },
      ],
    })
  })

  it('never uses the signing options that hide a missing certificate or drop the update publisher check', () => {
    const win = pkg.build.win
    const sign = win.signtoolOptions
    for (const key of ['certificateSubjectName', 'sign', 'certificateFile', 'certificatePassword', 'timeStampServer']) {
      expect(sign[key], `signtoolOptions.${key}`).toBeUndefined()
    }
    for (const key of ['verifyUpdateCodeSignature', 'certificateSubjectName', 'certificateFile', 'certificatePassword', 'sign', 'azureSignOptions']) {
      expect(win[key], `win.${key}`).toBeUndefined()
    }
    for (const key of ['toolsets', 'cscLink', 'cscKeyPassword', 'asarUnpack', 'disableAsarIntegrity', 'channel', 'forceCodeSigning']) {
      expect(pkg.build[key], `build.${key}`).toBeUndefined()
    }
    expect(pkg.build.asar).not.toBe(false)
    expect(pkgSource).not.toMatch(/"(certificateSubjectName|certificateFile|certificatePassword|verifyUpdateCodeSignature|disableAsarIntegrity|asarUnpack)"/)
  })
})

describe('electron fuses', () => {
  it('build.electronFuses is exactly the hardened set (cookie encryption explicitly off)', () => {
    expect(pkg.build.electronFuses).toEqual({
      runAsNode: false,
      enableCookieEncryption: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    })
    expect(Object.keys(pkg.build.electronFuses)).toHaveLength(7)
    expect(pkg.build.electronFuses.enableCookieEncryption).toBe(false)
    expect('loadBrowserProcessSpecificV8Snapshot' in pkg.build.electronFuses).toBe(false)
  })
})

describe('icons, installer pages and license', () => {
  it('nsis gets the new icon, bitmaps and the license page; existing options are unchanged', () => {
    expect(pkg.build.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'SanoVids',
      uninstallDisplayName: 'SanoVids',
      installerLanguages: ['vi_VN', 'en_US'],
      language: '1066',
      multiLanguageInstaller: true,
      artifactName: 'SanoVids-Setup-${version}.${ext}',
      installerIcon: 'build/icon.ico',
      installerSidebar: 'build/installerSidebar.bmp',
      uninstallerSidebar: 'build/uninstallerSidebar.bmp',
      installerHeader: 'build/installerHeader.bmp',
      license: 'build/license_vi.txt',
    })
    for (const key of ['uninstallerIcon', 'installerHeaderIcon', 'script', 'include']) {
      expect(pkg.build.nsis[key], `nsis.${key}`).toBeUndefined()
    }
    expect(pkg.build.icon).toBe('build/icon.png')
  })

  it('every referenced icon / bitmap / license file exists', () => {
    const files = [
      'build/icon.ico',
      'build/icon.png',
      'build/installerSidebar.bmp',
      'build/uninstallerSidebar.bmp',
      'build/installerHeader.bmp',
      'build/license_vi.txt',
      'LICENSE.txt',
      'build/license-third-party.txt',
      'public/icons/icon.ico',
    ]
    for (const rel of files) expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true)
  })

  it('LICENSE.txt and THIRD-PARTY-NOTICES.txt are shipped next to the app (Windows: build.win.extraFiles)', () => {
    expect(pkg.build.extraFiles).toBeUndefined()
    expect(pkg.build.win.extraFiles).toEqual([
      { from: 'LICENSE.txt', to: 'LICENSE.txt' },
      { from: 'build/license-third-party.txt', to: 'THIRD-PARTY-NOTICES.txt' },
    ])
  })
})

/** Width / height of a PNG (IHDR). */
const pngSize = (buf: Buffer) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) })
/** The keys of a flat XML plist dict whose values are <true/> / <false/> (comments ignored), or null when it is anything else. */
function plistBooleans(xml: string): Record<string, boolean> | null {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '')
  const dict = /<plist[^>]*>\s*<dict>([\s\S]*?)<\/dict>\s*<\/plist>/.exec(body)
  if (!dict) return null
  const out: Record<string, boolean> = {}
  const re = /<key>([^<]+)<\/key>\s*<(true|false)\/>/g
  let rest = dict[1]
  for (const m of dict[1].matchAll(re)) {
    out[m[1]] = m[2] === 'true'
    rest = rest.replace(m[0], '')
  }
  return rest.trim() ? null : out
}

describe('macOS build (Apple Silicon, ad hoc, check-only updates)', () => {
  const mac = pkg.build.mac
  const dmg = pkg.build.dmg

  it('build.mac: dmg + zip for arm64 only, ad-hoc identity ("-") forced, hardened runtime, no notarization', () => {
    expect(mac.target).toEqual([
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ])
    expect(mac.identity).toBe('-')
    expect(mac.forceCodeSigning).toBe(true)
    expect(mac.type).toBe('distribution')
    expect(mac.hardenedRuntime).toBe(true)
    expect(mac.notarize).toBe(false)
    expect(mac.gatekeeperAssess).toBe(false)
    expect(mac.minimumSystemVersion).toBe('13.0') // Electron 44 needs macOS 13 Ventura
    expect(mac.category).toBe('public.app-category.video')
    expect(mac.darkModeSupport).toBe(true)
    expect(mac.icon).toBe('build/icon.icns')
    expect(mac.artifactName).toBe('SanoVids-Mac-${version}-${arch}.${ext}')
  })

  it('never the options that crash the ad-hoc signing or ship a key: mac.sign, identity null, certificates, notarize objects', () => {
    // electron-builder 26.15.3 reads mac.identity; a mac.sign object passes the schema and then crashes the signing
    for (const key of ['sign', 'cscLink', 'cscKeyPassword', 'certificateFile', 'certificatePassword', 'provisioningProfile', 'binaries', 'electronLanguages', 'timestamp', 'signIgnore']) {
      expect(mac[key], `mac.${key}`).toBeUndefined()
    }
    expect(mac.identity).not.toBeNull()
    expect(typeof mac.notarize).toBe('boolean')
    expect(pkgSource).not.toMatch(/"(cscLink|CSC_LINK|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID|teamId)"/)
    expect(pkgSource).not.toMatch(/\.p12"|\.pfx"/)
  })

  it('one entitlements file for app and helpers: exactly allow-jit + disable-library-validation (required with an ad-hoc signature)', () => {
    expect(mac.entitlements).toBe('build/entitlements.mac.plist')
    expect(mac.entitlementsInherit).toBe('build/entitlements.mac.plist')
    const xml = read('build/entitlements.mac.plist').toString('utf8')
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(plistBooleans(xml)).toEqual({
      'com.apple.security.cs.allow-jit': true,
      'com.apple.security.cs.disable-library-validation': true,
    })
    expect(xml.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(/get-task-allow|allow-dyld-environment-variables|device\.camera|device\.audio-input|personal-information/)
  })

  it('the licence files ship inside the app (Contents/Resources): ours and Electron / Chromium’s (electron-builder deletes those on macOS)', () => {
    expect(mac.extraResources).toEqual([
      { from: 'LICENSE.txt', to: 'LICENSE.txt' },
      { from: 'build/license-third-party.txt', to: 'THIRD-PARTY-NOTICES.txt' },
      { from: 'node_modules/electron/dist/LICENSE', to: 'LICENSE.electron.txt' },
      { from: 'node_modules/electron/dist/LICENSES.chromium.html', to: 'LICENSES.chromium.html' },
    ])
    for (const { from } of mac.extraResources) expect(fs.existsSync(path.join(ROOT, from)), from).toBe(true)
    // LICENSE.txt clause 6 names exactly the shipped names
    const clause = read('LICENSE.txt').toString('utf8').split('\n').find((l) => l.startsWith('6. ')) ?? ''
    for (const f of clause.match(/[A-Za-z.-]+\.(?:txt|html)/g) ?? []) expect(mac.extraResources.map((r) => r.to), f).toContain(f)
  })

  it('folder-access prompts are Vietnamese (NFC); no camera / microphone / location prompt', () => {
    expect(Object.keys(mac.extendInfo).sort()).toEqual([
      'NSDesktopFolderUsageDescription',
      'NSDocumentsFolderUsageDescription',
      'NSDownloadsFolderUsageDescription',
      'NSNetworkVolumesUsageDescription',
      'NSRemovableVolumesUsageDescription',
    ])
    for (const [k, v] of Object.entries(mac.extendInfo)) {
      expect(v, k).toBe(v.normalize('NFC'))
      expect(v, k).toMatch(/^SanoVids lưu video/)
    }
  })

  it('build.dmg: no licence dialog, not signed, no update info (latest-mac.yml lists the zip), a HiDPI background', () => {
    expect(dmg.license).toBeNull()
    expect(dmg.sign).toBe(false)
    expect(dmg.writeUpdateInfo).toBe(false)
    expect(dmg.title).toBe('SanoVids ${version}')
    expect(dmg.iconSize).toBe(96)
    expect(dmg.contents).toEqual([
      { x: 140, y: 190, type: 'file' },
      { x: 400, y: 190, type: 'link', path: '/Applications' },
    ])
    expect(dmg.background).toBe('build/dmg-background.png')
    expect(pngSize(read('build/dmg-background.png'))).toEqual({ width: 540, height: 380 })
    expect(pngSize(read('build/dmg-background@2x.png'))).toEqual({ width: 1080, height: 760 })
  })

  it('build/icon.icns is a real icns: PNG entries up to 1024 px (committed: no icon converter download on the Mac)', () => {
    const buf = read('build/icon.icns')
    expect(buf.toString('latin1', 0, 4)).toBe('icns')
    expect(buf.readUInt32BE(4)).toBe(buf.length)
    const entries: Record<string, number> = {}
    for (let o = 8; o < buf.length; ) {
      const type = buf.toString('latin1', o, o + 4)
      const len = buf.readUInt32BE(o + 4)
      const png = buf.subarray(o + 8, o + len)
      expect(png.readUInt32BE(0), type).toBe(0x89504e47)
      entries[type] = pngSize(png).width
      o += len
    }
    expect(entries).toEqual({ icp4: 16, icp5: 32, ic11: 32, icp6: 64, ic12: 64, ic07: 128, ic13: 256, ic08: 256, ic14: 512, ic09: 512, ic10: 1024 })
  })

  it('the Windows build is unchanged by the Mac config (same top-level icon, fuses, files; electron-builder validates it all)', async () => {
    expect(pkg.build.icon).toBe('build/icon.png')
    expect(Object.keys(pkg.build)).toEqual(['appId', 'productName', 'executableName', 'copyright', 'directories', 'files', 'extraMetadata', 'icon', 'electronLanguages', 'npmRebuild', 'electronFuses', 'win', 'mac', 'dmg', 'nsis', 'portable', 'publish'])
    const { validateConfiguration } = nodeRequire('app-builder-lib/out/util/config/config.js') as {
      validateConfiguration: (config: unknown, debugLogger: unknown) => Promise<void>
    }
    await expect(validateConfiguration(structuredClone(pkg.build), { isEnabled: false, add() {} })).resolves.toBeUndefined()
  })
})

describe('signer pins and metadata', () => {
  it('sanovids.signers is top-level (build is stripped from the packaged package.json) and holds the pin', () => {
    expect(pkg.sanovids.signers).toEqual([PIN])
    // Only the signer pins and (once the owner made it) the development-mode unlock key pins (DV2a pins the real one).
    expect(Object.keys(pkg.sanovids).every((k) => k === 'signers' || k === 'devUnlockKeys')).toBe(true)
    expect(pkg.build.sanovids).toBeUndefined()
    expect(pkg.build.extraMetadata.sanovids).toBeUndefined()
    expect(pkg.homepage).toBe('https://github.com/JameSteven404/sanovids-releases')
  })

  it('development-mode unlock pins: strict shape when present, never a test key, never the test-build lock switch', () => {
    const rules = nodeRequire('../../../electron/devaccess-rules.cjs') as { pinProblems: (raw: unknown) => string[] }
    if (pkg.sanovids.devUnlockKeys !== undefined) expect(rules.pinProblems(pkg.sanovids.devUnlockKeys)).toEqual([])
    const top = pkg as unknown as Record<string, unknown>
    expect('sanovidsTestDevLock' in top).toBe(false)
    expect('sanovidsTestDevLock' in pkg.build.extraMetadata).toBe(false)
    expect('sanovidsTestProfileDir' in top).toBe(false)
    // the lock modules ship (build.files: electron/**) and the owner tool never does (no scripts/ in build.files)
    const files = pkg.build.files as string[]
    expect(files).toContain('electron/**/*')
    expect(files.some((f) => f.startsWith('scripts'))).toBe(false)
  })

  it('name, product name and description are unchanged', () => {
    expect(pkg.description).toBe('SanoVids — dựng phim AI theo từng cảnh trên canvas')
    expect(pkg.name).toBe('sanovids')
    expect(pkg.productName).toBe('SanoVids')
  })
})

describe('scripts', () => {
  it('dist:win goes through scripts/electron-build.mjs and never publishes', () => {
    expect(pkg.scripts['dist:win']).toBe(
      'node scripts/update-notes.mjs && node scripts/third-party-notices.mjs --check && vite build && node scripts/electron-build.mjs --win nsis portable --publish never && node scripts/tidy-release.mjs',
    )
    expect(pkg.scripts.release).toBeUndefined()
    expect(pkg.scripts.icons).toBe('node scripts/make-icons.mjs')
  })

  it('dist:mac: same guards (notes, notices check, electron-build.mjs, --publish never), arm64 dmg + zip into release/mac, then mac-inspect', () => {
    expect(pkg.scripts['dist:mac']).toBe(
      'node scripts/update-notes.mjs && node scripts/third-party-notices.mjs --check && vite build && node scripts/electron-build.mjs --mac dmg zip --arm64 --publish never -c.directories.output=release/mac && node scripts/mac-inspect.mjs',
    )
    expect(pkg.scripts['mac:fetch']).toBe('node scripts/fetch-mac-build.mjs')
    for (const f of ['scripts/mac-inspect.mjs', 'scripts/fetch-mac-build.mjs', '.github/workflows/mac-build.yml']) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
  })
})

describe('license and certificate files', () => {
  const LICENSES = ['LICENSE.txt', 'build/license_vi.txt', 'scripts/releases-repo/LICENSE.txt']

  it('the three license copies are byte-identical, UTF-8 with BOM, and name the author, partner and pin', () => {
    const [first, ...rest] = LICENSES.map(read)
    for (const [i, buf] of rest.entries()) expect(buf.equals(first), LICENSES[i + 1]).toBe(true)
    expect([...first.subarray(0, 3)]).toEqual(BOM)
    const text = first.subarray(3).toString('utf8')
    expect(text).toContain(pkg.sanovids.signers[0])
    expect(text).toContain(PIN)
    expect(text).toContain(AUTHOR)
    expect(text).toContain('Đồng hành: Sano Group')
  })

  it('the public certificate is the pinned one', () => {
    const cert = new crypto.X509Certificate(read('build/signing/SanoVids-NguyenGiangMinh.cer'))
    expect(cert.fingerprint.replace(/:/g, '')).toBe(PIN)
    expect(pkg.sanovids.signers).toContain(cert.fingerprint.replace(/:/g, ''))
  })
})

describe('Sano Agent (sano-agent/electron-builder.cjs: SanoVids build, own identity, same signing)', () => {
  const cfg = nodeRequire('../../../sano-agent/electron-builder.cjs') as Record<string, unknown> & {
    win: Record<string, unknown>
    nsis: Record<string, unknown>
    extraMetadata: Record<string, unknown> & { sanoAgent: { url: string } }
    publish: Record<string, unknown>[]
    directories: Record<string, unknown>
  }
  const ART = 'sano-agent/brand/build'
  const rules = nodeRequire('../../../electron/updater-rules.cjs') as { appUserModelId: (n: string) => string }

  it('electron-builder accepts it; identity: one name everywhere (the uninstaller the updater looks for), own appId', async () => {
    const { validateConfiguration } = nodeRequire('app-builder-lib/out/util/config/config.js') as {
      validateConfiguration: (config: unknown, debugLogger: unknown) => Promise<void>
    }
    await expect(validateConfiguration(structuredClone(cfg), { isEnabled: false, add() {} })).resolves.toBeUndefined()
    expect([cfg.productName, cfg.executableName, cfg.extraMetadata.productName]).toEqual(['Sano Agent', 'Sano Agent', 'Sano Agent'])
    expect(cfg.appId).not.toBe(pkg.build.appId)
    expect(cfg.appId).toBe(rules.appUserModelId('Sano Agent'))
    expect(cfg.publish).toEqual([{ provider: 'github', owner: 'JameSteven404', repo: 'sano-agent-releases', releaseType: 'release' }])
    expect(cfg.mac).toBeUndefined()
    expect(cfg.dmg).toBeUndefined()
    expect(cfg.directories).toEqual({ ...(pkg.build.directories as object), output: 'release/sano-agent' })
  })

  it('signed exactly like SanoVids: build.win but the icon, the same fuses, files and copyright', () => {
    expect(cfg.win).toEqual({ ...pkg.build.win, icon: `${ART}/icon.ico` })
    for (const key of ['electronFuses', 'files', 'copyright', 'electronLanguages', 'npmRebuild']) expect(cfg[key], key).toEqual(pkg.build[key])
    const own = ['shortcutName', 'uninstallDisplayName', 'artifactName', 'installerIcon', 'installerSidebar', 'uninstallerSidebar', 'installerHeader']
    const rest = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !own.includes(k)))
    expect(rest(cfg.nsis)).toEqual(rest(pkg.build.nsis))
    expect(cfg.nsis).toMatchObject({ shortcutName: 'Sano Agent', uninstallDisplayName: 'Sano Agent', artifactName: 'SanoAgent-Setup-${version}.${ext}' })
    for (const f of [cfg.nsis.installerIcon, cfg.nsis.installerSidebar, cfg.nsis.uninstallerSidebar, cfg.nsis.installerHeader, cfg.icon, cfg.win.icon] as string[]) {
      expect(f.startsWith(`${ART}/`), f).toBe(true)
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
    }
  })

  it('extraMetadata: no signer / test pins of its own (arrays are unioned), and a SANO address main accepts packaged', () => {
    expect(Object.keys(cfg.extraMetadata)).toEqual(['author', 'name', 'productName', 'version', 'description', 'homepage', 'sanoAgent'])
    expect(cfg.extraMetadata.author).toEqual(pkg.build.extraMetadata.author)
    const hardening = nodeRequire('../../../electron/hardening-rules.cjs') as { sanoShell: (o: unknown) => unknown }
    expect(hardening.sanoShell({ isPackaged: true, baked: cfg.extraMetadata.sanoAgent.url })).toEqual({ url: 'http://127.0.0.1:8080/', origin: 'http://127.0.0.1:8080' })
  })

  it('npm scripts: dist:sano-agent has the dist:win guards with this config; release:check / publish take --sano-agent', () => {
    expect(pkg.scripts['dist:sano-agent']).toBe(
      'node scripts/update-notes.mjs --sano-agent && node scripts/third-party-notices.mjs --check && vite build && node scripts/electron-build.mjs --config sano-agent/electron-builder.cjs --win nsis portable --publish never && node scripts/tidy-release.mjs --sano-agent',
    )
    expect(pkg.scripts['release:check:sano-agent']).toBe('node scripts/publish-release.mjs --sano-agent --dry-run')
    expect(pkg.scripts['release:publish:sano-agent']).toBe('node scripts/publish-release.mjs --sano-agent')
  })
})
