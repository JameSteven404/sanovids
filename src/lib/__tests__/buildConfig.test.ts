// package.json build configuration for 0.5.0: author / copyright / publisher strings, code signing with the pinned
// certificate, Electron fuses, installer icons + license page, the signer pins read by the app, and the license /
// certificate files the installer ships. electron-builder reads all of this at build time, so a silent change here
// would ship an unsigned or mis-credited release.
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
  sanovids: { signers: string[] }
  scripts: Record<string, string>
  build: Record<string, unknown> & {
    copyright: string
    icon: string
    extraMetadata: { author: Author } & Record<string, unknown>
    extraFiles: unknown
    electronFuses: Record<string, boolean>
    win: Record<string, unknown> & { signtoolOptions: Record<string, unknown> }
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
      'public/icons/icon.ico',
    ]
    for (const rel of files) expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true)
  })

  it('LICENSE.txt is shipped next to the app', () => {
    expect(pkg.build.extraFiles).toEqual([{ from: 'LICENSE.txt', to: 'LICENSE.txt' }])
  })
})

describe('signer pins and metadata', () => {
  it('sanovids.signers is top-level (build is stripped from the packaged package.json) and holds the pin', () => {
    expect(pkg.sanovids).toEqual({ signers: [PIN] })
    expect(pkg.build.sanovids).toBeUndefined()
    expect(pkg.build.extraMetadata.sanovids).toBeUndefined()
    expect(pkg.homepage).toBe('https://github.com/JameSteven404/sanovids-releases')
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
      'node scripts/update-notes.mjs && vite build && node scripts/electron-build.mjs --win nsis portable --publish never && node scripts/tidy-release.mjs',
    )
    expect(pkg.scripts.release).toBeUndefined()
    expect(pkg.scripts.icons).toBe('node scripts/make-icons.mjs')
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
