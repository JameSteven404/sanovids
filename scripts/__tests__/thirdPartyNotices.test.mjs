// scripts/third-party-notices.mjs: the import scanner, the licence helpers, and the committed
// build/license-third-party.txt (shipped as THIRD-PARTY-NOTICES.txt) being exactly what node_modules gives today.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BUNDLER_RUNTIME,
  NOTICES_SHIPPED,
  NOTICES_SOURCE,
  bareImports,
  collectPackages,
  coreLicense,
  generateNotices,
  licenseId,
  licenseTexts,
  packageNameOf,
  packageUrl,
  readmeLicenseSection,
  rootPackages,
} from '../third-party-notices.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('bareImports', () => {
  it('finds static, multi-line, side-effect, dynamic and CSS imports', () => {
    const src = [
      "import React, { useState } from 'react'",
      'import {',
      '  ReactFlow,',
      '  type Node,',
      "} from '@xyflow/react'",
      "import '@fontsource/be-vietnam-pro/400.css'",
      "export { create } from 'zustand'",
      "export * from 'zundo'",
      "const JSZip = await import('jszip')",
      "@import url('@xyflow/react/dist/style.css');",
      "@import 'lucide-react/x.css';",
    ].join('\n')
    expect(bareImports(src)).toEqual(['@fontsource/be-vietnam-pro/400.css', '@xyflow/react', '@xyflow/react/dist/style.css', 'jszip', 'lucide-react/x.css', 'react', 'zundo', 'zustand'])
  })
  it('skips type-only, relative, absolute and node: imports and text that only looks like one', () => {
    const src = [
      "import type { Take } from 'electron'",
      "export type { X } from 'vitest'",
      "import { a } from './a'",
      "import b from '../b'",
      "import fs from 'node:fs'",
      "const s = 'Bấm vào from \\'Bảng phát triển\\''",
      "toast(`Lỗi khi import from 'file'`)",
    ].join('\n')
    expect(bareImports(src)).toEqual([])
  })
  it('packageNameOf: scoped / deep paths, builtins', () => {
    expect(packageNameOf('@xyflow/react/dist/style.css')).toBe('@xyflow/react')
    expect(packageNameOf('zustand/react/shallow')).toBe('zustand')
    expect(packageNameOf('react-dom/client')).toBe('react-dom')
    expect(packageNameOf('fs')).toBeNull()
    expect(packageNameOf('path')).toBeNull()
  })
})

describe('licence helpers', () => {
  it('licenseId reads SPDX strings and the legacy forms', () => {
    expect(licenseId({ license: 'MIT' })).toBe('MIT')
    expect(licenseId({ license: { type: 'ISC' } })).toBe('ISC')
    expect(licenseId({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0')
    expect(licenseId({})).toBe('không ghi')
  })
  it('packageUrl prefers the homepage, then the repository as https', () => {
    expect(packageUrl({ homepage: 'https://react.dev/' })).toBe('https://react.dev/')
    expect(packageUrl({ repository: { url: 'git+https://github.com/a/b.git' } })).toBe('https://github.com/a/b')
    expect(packageUrl({ repository: 'git@github.com:jprichardson/node-jsonfile.git' })).toBe('https://github.com/jprichardson/node-jsonfile')
    expect(packageUrl({ repository: 'github:x/y' })).toBe('https://github.com/x/y')
    expect(packageUrl({ repository: 'x/y' })).toBe('https://github.com/x/y')
    expect(packageUrl({})).toBe('')
  })
  it('coreLicense drops a bundled-dependencies appendix (Vite)', () => {
    expect(coreLicense('# Core\nMIT text\n\n# Licenses of bundled dependencies\nlots\n')).toBe('# Core\nMIT text')
    expect(coreLicense('MIT text\n\n')).toBe('MIT text')
  })
  it('readmeLicenseSection takes the License section up to the next heading of the same level', () => {
    const md = '# pkg\n\n## Usage\nx\n\n## License\n\n(MIT)\n\n### Copyright\nme\n\n## Other\ny\n'
    expect(readmeLicenseSection(md)).toBe('## License\n\n(MIT)\n\n### Copyright\nme')
    expect(readmeLicenseSection('# none')).toBe('')
  })
  it('licenseTexts: licence files first, the README section only as a fallback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanovids-lic-'))
    try {
      fs.writeFileSync(path.join(dir, 'README.md'), '# x\n\n## License\n\nMIT, me\n')
      expect(licenseTexts(dir)).toEqual([{ name: 'README.md (License)', text: '## License\n\nMIT, me' }])
      fs.writeFileSync(path.join(dir, 'LICENSE'), '﻿MIT\r\nline\r\n\r\n')
      fs.writeFileSync(path.join(dir, 'NOTICE.txt'), 'notice')
      expect(licenseTexts(dir)).toEqual([
        { name: 'LICENSE', text: 'MIT\nline' },
        { name: 'NOTICE.txt', text: 'notice' },
      ])
    } finally {
      if (dir.startsWith(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('packages SanoVids ships', () => {
  it('roots = bare imports of src/ (no tests, virtual modules mapped) + package.json dependencies', () => {
    const roots = rootPackages(root)
    for (const name of ['react', 'react-dom', '@xyflow/react', 'zustand', 'zundo', 'lucide-react', 'idb-keyval', 'jszip', 'electron-updater', 'workbox-window', '@fontsource/be-vietnam-pro', '@fontsource/jetbrains-mono']) {
      expect(roots).toContain(name)
    }
    for (const name of ['vitest', 'electron', 'node:fs', 'fs']) expect(roots).not.toContain(name)
  })
  it('the closure follows dependencies (jszip → pako, electron-updater → js-yaml), skips @types, adds the bundler runtime', () => {
    const { packages, missing } = collectPackages(root)
    const names = packages.map((p) => p.name)
    for (const name of ['pako', 'readable-stream', 'js-yaml', 'builder-util-runtime', 'semver', 'scheduler', 'd3-zoom', ...BUNDLER_RUNTIME]) expect(names).toContain(name)
    expect(names.some((n) => n.startsWith('@types/'))).toBe(false)
    expect(missing).toEqual([])
  })
})

describe('committed notices file', () => {
  let committed = ''
  let generated = null
  beforeAll(() => {
    committed = fs.readFileSync(path.join(root, ...NOTICES_SOURCE.split('/')), 'utf8')
    generated = generateNotices(root)
  })
  afterAll(() => {
    generated = null
  })
  it('is up to date with node_modules (run `node scripts/third-party-notices.mjs` after changing dependencies)', () => {
    expect(committed === generated.text).toBe(true)
  })
  it('is UTF-8 with BOM, LF only, NFC, and names Electron / Chromium / SanoVids licences', () => {
    const buf = fs.readFileSync(path.join(root, ...NOTICES_SOURCE.split('/')))
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(buf.includes(Buffer.from('\r'))).toBe(false)
    expect(committed).toBe(committed.normalize('NFC'))
    expect(committed).toContain('LICENSE.electron.txt, LICENSES.chromium.html')
    expect(committed).toContain('LICENSE.txt')
    // the OFL text of the bundled fonts travels with them
    expect(committed).toContain('SIL OPEN FONT LICENSE Version 1.1')
  })
  it('is never picked up as an installer licence page (electron-builder: build/license.* or build/license_<lang>.*)', () => {
    const name = path.basename(NOTICES_SOURCE).toLowerCase()
    expect(/^(license|eula)\.(txt|rtf|html)$/.test(name)).toBe(false)
    expect(name.startsWith('license_') || name.startsWith('eula_')).toBe(false)
    expect(NOTICES_SHIPPED).toBe('THIRD-PARTY-NOTICES.txt')
  })
})
