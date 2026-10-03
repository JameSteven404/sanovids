// Writes build/release-notes.md from the CHANGELOG.md section of the package.json version.
// electron-builder picks that file up from buildResources (build/) and copies it into latest.yml `releaseNotes`, which
// is what the app shows under "Có gì mới" in the update dialog. Run by `npm run dist:win` before the build.
// Never fails the build: a missing section gives a one-line note ("SanoVids <v>") and a warning. The file is
// gitignored and never copied into release/.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { updateNotesText } from './releaseLib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'build', 'release-notes.md')

try {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  let changelog = ''
  try {
    changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  } catch {
    // handled below as a missing section
  }
  const { found, text } = updateNotesText(changelog, version)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, text, 'utf8')
  if (found) console.log(`update-notes: build/release-notes.md ← CHANGELOG.md [${version}] (${text.length} chars)`)
  else {
    console.warn(
      `update-notes: WARNING — CHANGELOG.md has no "## [${version}] — yyyy-mm-dd" section; ` +
        `the update notes will only say "SanoVids ${version}". Add the section and build again.`,
    )
  }
} catch (e) {
  // A stale file from an older version would ship the wrong notes: remove it rather than keep it.
  try {
    fs.rmSync(out, { force: true })
  } catch {
    // ignore
  }
  console.warn(`update-notes: WARNING — could not write build/release-notes.md (${e?.message ?? e}); the update will have no notes`)
}
process.exit(0)
