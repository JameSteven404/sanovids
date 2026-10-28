// Execute the actual startup gate with injected filesystem/process/app/dialog. No Electron, real profile or writes.
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import mainSource from '../../../electron/main.cjs?raw'

const rules = createRequire(import.meta.url)('../../../electron/updater-rules.cjs')
const start = mainSource.indexOf('  // D223: before Chromium opens the profile')
const end = mainSource.indexOf('  // A second launch brings THE SanoVids window', start)

function startup({ marker, readError, writeError, renameError }: { marker?: string; readError?: string; writeError?: string; renameError?: string } = {}) {
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const state = { marker, writes: [] as string[], dialogs: [] as string[], exit: null as number | null, continued: false }
  const fakeExit = new Error('fake process exit')
  const dir = 'X:\\fake-profile-test-only'
  const file = path.win32.join(dir, 'electron-version')
  let temp: string | undefined
  try {
    vm.runInNewContext(mainSource.slice(start, end), {
      updaterRules: rules, path: path.win32, profile: { dir },
      fs: {
        readFileSync: (target: string, encoding: string) => {
          expect([target, encoding]).toEqual([file, 'utf8'])
          if (readError || marker === undefined) throw Object.assign(new Error('injected read failure'), { code: readError || 'ENOENT' })
          return state.marker
        },
        mkdirSync: (target: string, opts: { recursive: boolean }) => { expect([target, opts.recursive]).toEqual([dir, true]) },
        // The marker itself changes only by the rename: a failed or torn temp write leaves it as it was.
        writeFileSync: (target: string, value: string, opts: { flush: boolean }) => {
          expect([target, opts.flush]).toEqual([`${file}.tmp`, true])
          if (writeError) throw Object.assign(new Error('injected write failure'), { code: writeError })
          temp = value
        },
        renameSync: (from: string, to: string) => {
          expect([from, to, temp]).toEqual([`${file}.tmp`, file, expect.any(String)])
          if (renameError) throw Object.assign(new Error('injected rename failure'), { code: renameError })
          state.marker = temp
          state.writes.push(temp!)
        },
      },
      process: { versions: { electron: '44.5.1' }, exit: (code: number) => { state.exit = code; throw fakeExit } },
      app: { getName: () => 'Sano Agent' },
      dialog: { showErrorBox: (_title: string, text: string) => { state.dialogs.push(text) } },
    }, { timeout: 1000 })
    state.continued = true
  } catch (e) {
    if (e !== fakeExit) throw e
  }
  return state
}

describe('shared profile startup: injected filesystem regression', () => {
  it.each(['', ' \r\n', 'garbage', '45.0', '45.0.0\n44.5.1'])('preserves an existing invalid marker %j and refuses to open it', (marker) => {
    const state = startup({ marker })
    expect(state).toMatchObject({ marker, writes: [], exit: 4, continued: false })
    expect(state.dialogs).toHaveLength(1)
    expect(state.dialogs[0]).toContain('không hợp lệ')
  })
  it.each(['EACCES', 'EIO'])('preserves a newer marker on read %s even when writes would succeed', (readError) => {
    const state = startup({ marker: '45.0.0', readError })
    expect(state).toMatchObject({ marker: '45.0.0', writes: [], exit: 4, continued: false })
    expect(state.dialogs).toHaveLength(1)
    expect(state.dialogs[0]).toContain('Không đọc được')
  })
  it('initializes a missing marker on ENOENT', () => {
    expect(startup()).toEqual({ marker: '44.5.1', writes: ['44.5.1'], dialogs: [], exit: null, continued: true })
  })
  it('refuses a readable newer major without rewriting it', () => {
    const state = startup({ marker: '45.0.0' })
    expect(state).toMatchObject({ marker: '45.0.0', writes: [], exit: 4, continued: false })
    expect(state.dialogs).toHaveLength(1)
  })
  it.each([{ writeError: 'EACCES' }, { writeError: 'ENOSPC' }, { renameError: 'EPERM' }])('refuses startup if recording the version fails, keeping the old record: %j', (failure) => {
    const state = startup({ marker: '43.9.9', ...failure })
    expect(state).toMatchObject({ marker: '43.9.9', writes: [], exit: 4, continued: false })
    expect(state.dialogs).toHaveLength(1)
    expect(state.dialogs[0]).toContain('Không ghi được')
  })
  it('preserves the highest same-major marker', () => {
    expect(startup({ marker: '44.6.0' })).toEqual({ marker: '44.6.0', writes: [], dialogs: [], exit: null, continued: true })
  })
  it('records a valid older major and leaves an equal marker alone', () => {
    expect(startup({ marker: '43.9.9' })).toEqual({ marker: '44.5.1', writes: ['44.5.1'], dialogs: [], exit: null, continued: true })
    expect(startup({ marker: '44.5.1' })).toEqual({ marker: '44.5.1', writes: [], dialogs: [], exit: null, continued: true })
  })
})
