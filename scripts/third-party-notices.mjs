// Generates build/license-third-party.txt: the licence texts of every open-source package SanoVids ships, copied into
// the install folder as THIRD-PARTY-NOTICES.txt (package.json build.extraFiles). LICENSE.txt clause 6, the installer
// licence page, README and Cài đặt → Giới thiệu point at it; Electron's and Chromium's own licences ship next to it as
// LICENSE.electron.txt / LICENSES.chromium.html (electron-builder copies them).
//
// Which packages: Vite bundles every package the renderer imports (and strips their licence comments), so the roots
// are the bare imports of src/ (tests excluded, `import type` ignored, known `virtual:` modules mapped to the package
// that backs them) plus package.json `dependencies` (packed into app.asar). Each root is expanded through its
// `dependencies` / installed `optionalDependencies`, resolved like Node (nested node_modules first). Listing a package
// that tree-shaking later drops is harmless; missing one is not, so an unknown `virtual:` module throws. The bundler
// itself puts small runtime helpers in the bundle (Vite's preload helper, Rolldown's CommonJS interop): their core
// licences are listed too (BUNDLER_RUNTIME, without their dependencies or the licences of their own bundled code).
//
// Usage:  node scripts/third-party-notices.mjs           write the file
//         node scripts/third-party-notices.mjs --check   exit 1 when the committed file is out of date
// scripts/__tests__/thirdPartyNotices.test.mjs fails when the committed file differs from what node_modules gives.
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** Repo path of the generated file (UTF-8 with BOM, LF) and its name in the install folder. */
export const NOTICES_SOURCE = 'build/license-third-party.txt'
export const NOTICES_SHIPPED = 'THIRD-PARTY-NOTICES.txt'
/** `virtual:` modules of Vite plugins → the npm packages whose code they put in the bundle. */
export const VIRTUAL_MODULES = Object.freeze({ 'virtual:pwa-register': ['workbox-window'] })
/** Bundler packages whose runtime helpers end up in dist/: listed with their core licence only, never expanded. */
export const BUNDLER_RUNTIME = Object.freeze(['vite', 'rolldown'])

const CODE_FILE = /\.(?:[cm]?[jt]sx?|css)$/i
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i
const LICENSE_FILE = /^(?:licen[sc]e|copying|notice)(?:[-._][^/\\]*)?$/i
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, '')]))

// ───────────────────────────── imports of src/ ─────────────────────────────

/**
 * Bare module specifiers imported by one source text (TS / TSX / JS / CSS). `import type` / `export type` are skipped
 * (erased at build time); relative, absolute and `node:` imports are not packages.
 */
export function bareImports(text) {
  const src = String(text ?? '')
  const out = new Set()
  const add = (spec) => {
    if (!spec || /^[./]/.test(spec) || /^[a-z]:[\\/]/i.test(spec) || spec.startsWith('node:') || /^(?:https?|data):/.test(spec)) return
    out.add(spec)
  }
  // import x from 'a' · import { a, b } from 'a' (multi-line) · export * from 'a' · export { x } from 'a'
  const fromRe = /^[ \t]*(?:import|export)[ \t]+(type[ \t]+)?[\w\s{},*$]*?\bfrom[ \t]*['"]([^'"\n]+)['"]/gm
  for (const m of src.matchAll(fromRe)) if (!m[1]) add(m[2])
  // import 'a' (side effect, e.g. CSS)
  for (const m of src.matchAll(/^[ \t]*import[ \t]*['"]([^'"\n]+)['"]/gm)) add(m[1])
  // import('a')
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g)) add(m[1])
  // CSS @import 'a' / @import url('a')
  for (const m of src.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"\n]+)['"]/g)) add(m[1])
  return [...out].sort()
}

/** 'a/b/c' → 'a', '@s/a/b' → '@s/a'; null for builtins. */
export function packageNameOf(spec) {
  const parts = String(spec).split('/')
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  return BUILTINS.has(name) ? null : name
}

function walkFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== '__tests__' && e.name !== 'node_modules') walkFiles(p, out)
    } else if (e.isFile() && CODE_FILE.test(e.name) && !TEST_FILE.test(e.name)) out.push(p)
  }
  return out
}

/** Root packages: bare imports of src/ (virtual modules mapped) + package.json dependencies. Sorted, unique. */
export function rootPackages(root = ROOT) {
  const names = new Set()
  for (const file of walkFiles(path.join(root, 'src'))) {
    for (const spec of bareImports(fs.readFileSync(file, 'utf8'))) {
      if (spec.startsWith('virtual:')) {
        const mapped = VIRTUAL_MODULES[spec]
        if (!mapped) throw new Error(`${path.relative(root, file)} imports ${spec}: add it to VIRTUAL_MODULES in scripts/third-party-notices.mjs`)
        for (const n of mapped) names.add(n)
        continue
      }
      const name = packageNameOf(spec)
      if (name) names.add(name)
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  for (const name of Object.keys(pkg.dependencies ?? {})) names.add(name)
  return [...names].sort()
}

// ───────────────────────────── dependency closure ─────────────────────────────

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Directory of `name` as Node resolves it from `fromDir` (nested node_modules first, then every ancestor), or null. */
function resolvePackageDir(root, fromDir, name) {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'))
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    if (path.resolve(dir) === path.resolve(root)) return null
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Every package (name@version, unique) reachable from the roots through dependencies / installed optional
 * dependencies; `@types/*` (no runtime code) skipped. → { packages: [{ name, version, dir, pkg }], missing: [names] }
 */
export function collectPackages(root = ROOT, roots = rootPackages(root), leaves = BUNDLER_RUNTIME) {
  const byKey = new Map()
  const seenDirs = new Set()
  const missing = new Set()
  const visit = (fromDir, name, optional, leaf = false) => {
    if (name.startsWith('@types/')) return
    const dir = resolvePackageDir(root, fromDir, name)
    if (!dir) {
      if (!optional) missing.add(name)
      return
    }
    if (seenDirs.has(dir)) return
    seenDirs.add(dir)
    const pkg = readJson(path.join(dir, 'package.json'))
    if (!pkg) {
      missing.add(name)
      return
    }
    const key = `${pkg.name ?? name}@${pkg.version ?? '?'}`
    if (!byKey.has(key)) byKey.set(key, { name: pkg.name ?? name, version: String(pkg.version ?? '?'), dir, pkg })
    if (leaf) return
    const optionalDeps = new Set(Object.keys(pkg.optionalDependencies ?? {}))
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dir, dep, optionalDeps.has(dep))
    for (const dep of optionalDeps) if (!(pkg.dependencies && dep in pkg.dependencies)) visit(dir, dep, true)
  }
  for (const name of roots) visit(root, name, false)
  for (const name of leaves) visit(root, name, false, true)
  const packages = [...byKey.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name < b.name ? -1 : 1))
  return { packages, missing: [...missing].sort() }
}

// ───────────────────────────── rendering ─────────────────────────────

/** SPDX expression of a package.json (`license`, or the legacy `licenses` / object forms). */
export function licenseId(pkg) {
  const l = pkg?.license ?? pkg?.licenses
  if (typeof l === 'string') return l
  if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : x?.type)).filter(Boolean).join(' OR ') || 'không ghi'
  if (l && typeof l === 'object' && typeof l.type === 'string') return l.type
  return 'không ghi'
}

/** Web page of a package: homepage, else the repository URL as https. '' when none. */
export function packageUrl(pkg) {
  if (typeof pkg?.homepage === 'string' && /^https?:\/\//.test(pkg.homepage)) return pkg.homepage
  const repo = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url
  if (typeof repo !== 'string' || !repo) return ''
  if (/^github:|^[\w.-]+\/[\w.-]+$/.test(repo)) return `https://github.com/${repo.replace(/^github:/, '')}`
  return repo
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:/]+):/, 'https://$1/')
    .replace(/\.git$/, '')
}

/** Drops the "licenses of bundled dependencies" appendix some packages add after their own licence (Vite). */
export function coreLicense(text) {
  const s = String(text ?? '')
  const i = s.search(/^#+ *Licenses of bundled dependencies/im)
  return (i > 0 ? s.slice(0, i) : s).replace(/\s+$/, '')
}

/** Licence / notice files at the top of a package folder, as text (BOM dropped, CRLF → LF, core licence only). */
export function licenseTexts(dir) {
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name))
    .map((e) => e.name)
    .sort()
  const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (names.length) return names.map((name) => ({ name, text: coreLicense(read(name)) }))
  // No licence file: the "License" section of the README, when there is one (e.g. isarray).
  const readme = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^readme(?:\.(?:md|markdown|txt))?$/i.test(e.name))
    .map((e) => e.name)
    .sort()[0]
  const section = readme ? readmeLicenseSection(read(readme)) : ''
  return section ? [{ name: `${readme} (License)`, text: section }] : []
}

/** The "## License" section of a README (heading included, up to the next heading of the same or a higher level). */
export function readmeLicenseSection(text) {
  const lines = String(text ?? '').split('\n')
  const start = lines.findIndex((l) => /^#{1,6}\s*licen[sc]e\b/i.test(l))
  if (start < 0) return ''
  const level = /^#+/.exec(lines[start])[0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i])
    if (m && m[1].length <= level) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n').replace(/\s+$/, '')
}

const RULE = '='.repeat(80)
const THIN = '-'.repeat(80)

/** The whole notices file (without the BOM). Deterministic: same node_modules → same text. */
export function renderNotices(packages) {
  const head = [
    'SANOVIDS — GIẤY PHÉP CỦA CÁC THÀNH PHẦN MÃ NGUỒN MỞ (THIRD-PARTY NOTICES)',
    '',
    'SanoVids dùng các thành phần mã nguồn mở liệt kê dưới đây. Mỗi thành phần thuộc bản quyền của các tác giả của nó',
    'và được dùng theo giấy phép riêng của nó, chép nguyên văn (tiếng Anh) bên dưới.',
    'Giấy phép của Electron và Chromium nằm cùng thư mục: LICENSE.electron.txt, LICENSES.chromium.html.',
    'Giấy phép của chính SanoVids: LICENSE.txt.',
    '',
    `Danh sách (${packages.length} thành phần):`,
    ...packages.map((p) => `  - ${p.name} ${p.version} — ${licenseId(p.pkg)}`),
    '',
  ]
  const body = packages.flatMap((p) => {
    const url = packageUrl(p.pkg)
    const files = licenseTexts(p.dir)
    const lines = [RULE, `${p.name} ${p.version}`, `Giấy phép: ${licenseId(p.pkg)}`]
    if (url) lines.push(url)
    lines.push(THIN)
    if (!files.length) {
      const author = typeof p.pkg.author === 'string' ? p.pkg.author : p.pkg.author?.name
      lines.push(`(Gói này không kèm file giấy phép. package.json ghi giấy phép ${licenseId(p.pkg)}${author ? `, tác giả ${author}` : ''}.)`)
    } else {
      files.forEach((f, i) => {
        if (files.length > 1 || /\(License\)$/.test(f.name)) lines.push(`[${f.name}]`)
        lines.push(f.text)
        if (i < files.length - 1) lines.push('')
      })
    }
    lines.push('')
    return lines
  })
  return `${[...head, ...body, RULE].join('\n')}\n`
}

/** → { text (BOM included), packages, missing } for the repo at `root`. */
export function generateNotices(root = ROOT) {
  const { packages, missing } = collectPackages(root)
  return { text: `﻿${renderNotices(packages)}`, packages, missing }
}

// ───────────────────────────── CLI ─────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { text, packages, missing } = generateNotices(ROOT)
  const target = path.join(ROOT, ...NOTICES_SOURCE.split('/'))
  for (const name of missing) console.warn(`third-party-notices: ${name} is required but not installed (skipped)`)
  if (process.argv.includes('--check')) {
    let current = ''
    try {
      current = fs.readFileSync(target, 'utf8')
    } catch {
      current = ''
    }
    if (current !== text) {
      console.error(`third-party-notices: ${NOTICES_SOURCE} is out of date — run: node scripts/third-party-notices.mjs`)
      process.exit(1)
    }
    console.log(`third-party-notices: ${NOTICES_SOURCE} is up to date (${packages.length} packages)`)
  } else {
    fs.writeFileSync(target, text, 'utf8')
    console.log(`third-party-notices: wrote ${NOTICES_SOURCE} (${packages.length} packages, ${Buffer.byteLength(text)} bytes)`)
  }
}
