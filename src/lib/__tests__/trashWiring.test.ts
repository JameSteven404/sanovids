// files:trashSaved is the first destructive IPC of the desktop shell (plan 3.2.4 / 3.2.9). These source checks keep its
// wiring narrow: one guarded handler, one shell.trashItem (inside filesTrashSaved) and no delete anywhere on that path,
// the checks in their order, the ledger rules pure (<save-rules>, run by saveRules.test.ts), writes recorded only after
// they happened, and a preload that passes exactly the documented fields.
import { describe, expect, it } from 'vitest'
import mainSource from '../../../electron/main.cjs?raw'
import preloadSource from '../../../electron/preload.cjs?raw'

/** Source without comments (block comments, and line comments starting at a line start or after a space). */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
const mainCode = stripComments(mainSource)
const count = (src: string, s: string) => src.split(s).length - 1

/** [start, end) of the block opened by the first '{' at or after `from`. */
function blockAt(src: string, from: number): [number, number] {
  const open = src.indexOf('{', from)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return [open, i + 1]
  }
  throw new Error('unbalanced block')
}
/** Body of `function name(` / `async function name(` in the comment-free main source. */
function fnBody(name: string): string {
  const at = mainCode.search(new RegExp(`(async )?function ${name}\\(`))
  expect(at, name).toBeGreaterThan(-1)
  // skip the parameter list (it may hold a destructuring { … })
  const params = mainCode.indexOf(')', mainCode.indexOf('(', at))
  const [s, e] = blockAt(mainCode, params)
  return mainCode.slice(s, e)
}
const saveRules = (() => {
  const m = /\/\/ <save-rules>[^\n]*\n([\s\S]*?)\/\/ <\/save-rules>/.exec(mainSource)
  if (!m) throw new Error('save-rules block not found')
  return stripComments(m[1])
})()

const DELETE_CALL = /\b(unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|truncate|truncateSync|deleteFile)\s*\(/

describe('files:trashSaved wiring (electron/main.cjs)', () => {
  it('exactly one handler, guarded (fromApp), registered with the other files:* handlers', () => {
    expect(count(mainCode, "ipcMain.handle('files:trashSaved', guard(")).toBe(1)
    expect(count(mainCode, "'files:trashSaved'")).toBe(1)
    expect(count(mainCode, "ipcMain.on('files:trashSaved'")).toBe(0)
    const bridge = fnBody('registerFileBridge')
    expect(bridge).toContain("ipcMain.handle('files:trashSaved', guard((_event, args) => filesTrashSaved(args)))")
    expect(bridge).toContain("if (!fromApp(event)) return fileError('not-allowed'")
  })

  it('exactly one shell.trashItem in the whole main process, and it is inside filesTrashSaved', () => {
    expect(count(mainCode, 'trashItem')).toBe(1)
    expect(count(mainCode, 'shell.trashItem(')).toBe(1)
    expect(fnBody('filesTrashSaved')).toContain('trash: (p) => shell.trashItem(p),')
  })

  it('nothing on the Recycle Bin path can delete, truncate or write a file', () => {
    for (const name of ['filesTrashSaved', 'trashSavedGroups', 'savedFileStatProblem', 'judgeSavedFile', 'selectTrashGroups', 'withSaveAbort']) {
      const body = fnBody(name)
      expect(body, name).not.toMatch(DELETE_CALL)
      expect(body, name).not.toMatch(/\.rm\b|writeFile|appendFile|rename\(|copyFile|createWriteStream/)
    }
    // trashSavedGroups only ever looks at a file (lstat) through the injected fs; it reads through hashFile, moves through trash
    const body = fnBody('trashSavedGroups')
    expect([...new Set([...body.matchAll(/\bfsp\.(\w+)/g)].map((m) => m[1]))]).toEqual(['lstat'])
    expect(body).not.toMatch(/\bfs\.|\bshell\b|require\(/)
    expect(body).toContain('await withSaveAbort(Promise.resolve().then(() => trash(pathMod.resolve(p))), signal)')
    // a file is moved only after the size / hash / unchanged-while-hashed checks said 'ok'
    const verdict = body.indexOf("if (verdict !== 'ok') return { result: verdict }")
    expect(verdict).toBeGreaterThan(body.indexOf('if (!sameSavedStat(before, after))'))
    expect(verdict).toBeGreaterThan(body.indexOf('savedFileOnlineOnly(before)'))
    expect(verdict).toBeLessThan(body.indexOf('trash(pathMod.resolve(p))'))
    expect(body).toContain("if (!isLedgerName(entry.name) || !isDirectChild(dir, p, pathMod)) return { result: 'changed' }")
    expect(body).toContain("if (!g || g.via === 'autosave' || !dirKey || g.folder !== dirKey")
  })

  it('filesTrashSaved checks the request, the allowlist and the folder before touching the ledger or a file', () => {
    const body = fnBody('filesTrashSaved')
    const order = ['checkTrashArgs(args, path)', 'isAllowedFolder(loadSaveState().folders, checked.folderPath, path)', 'isDirectory(dir)', 'selectTrashGroups(ledger, dirKey, checked.folderId, item)', 'trashSavedGroups(dir,']
    const at = order.map((s) => body.indexOf(s))
    for (let i = 0; i < order.length; i++) expect(at[i], order[i]).toBeGreaterThan(-1)
    for (let i = 1; i < order.length; i++) expect(at[i], order[i]).toBeGreaterThan(at[i - 1])
    expect(body).toContain("return fileError('bad-request', checked.error)")
    expect(body).toContain("return fileError('not-allowed'")
    expect(body).toContain("return fileError('missing'")
    // watchdog, and groups another call is moving are never touched twice
    expect(body).toContain('signal: AbortSignal.timeout(SAVE_TRASH_WATCHDOG_MS),')
    expect(mainCode).toContain('const SAVE_TRASH_WATCHDOG_MS = 5 * 60_000')
    expect(body).toContain('trashingIds.has(g.id)')
    expect(body).toMatch(/finally \{\s+for \(const id of claimed\) trashingIds\.delete\(id\)/)
    // the page names group ids only: never a file name or a path to move
    expect(body).not.toMatch(/args\.(files|names|name|path)\b/)
  })

  it('never autosave groups, never another folder node / take', () => {
    const body = fnBody('selectTrashGroups')
    expect(body).toContain("wanted.has(g.id) && g.folderId === folderId && g.takeId === takeId && g.via !== 'autosave'")
    expect(body).toContain('owned.filter((g) => g.folder === dirKey)')
  })

  it('a write is recorded only after it happened, only with a valid owner, before answering', () => {
    const body = fnBody('filesWriteToFolder')
    const write = body.indexOf('names = await writeGroupExclusive(dir, checked.files, fs.promises, path)')
    const owner = body.indexOf('const owner = checkSaveOwner(args.owner)')
    const record = body.indexOf('recorded: await recordSavedGroup(dir, owner, names, checked.files)')
    expect(write).toBeGreaterThan(-1)
    expect(owner).toBeGreaterThan(write)
    expect(record).toBeGreaterThan(owner)
    expect(body).toContain('if (!owner) return { ok: true, names }')
    // recording never turns a done write into a failure
    expect(fnBody('recordSavedGroup')).toMatch(/catch \(e\) \{[\s\S]*return false/)
  })

  it('the ledger lives in userData, is stored whole (tmp + rename) and loaded through the allowlist', () => {
    expect(mainCode).toContain("const SAVE_LEDGER_FILE = 'saved-files.json'")
    expect(fnBody('saveLedgerPath')).toContain("path.join(app.getPath('userData'), SAVE_LEDGER_FILE)")
    expect(fnBody('storeSaveLedger')).toContain('await renameSaveFile(fs.promises, tmp, file)')
    expect(fnBody('loadSaveLedger')).toContain('parseSaveLedger(JSON.parse(await fs.promises.readFile(saveLedgerPath(), \'utf8\')), loadSaveState().folders, path)')
    // a next ledger becomes current only once stored
    const w = fnBody('withLedger')
    expect(w.indexOf('await storeSaveLedger(next)')).toBeLessThan(w.indexOf('saveLedger = next'))
  })

  it('<save-rules> stays pure: no require, no electron, no node fs (everything is injected)', () => {
    expect(saveRules).not.toMatch(/\brequire\s*\(/)
    expect(saveRules).not.toMatch(/\bshell\b|\belectron\b|\bipcMain\b|\bprocess\./)
    expect(saveRules).not.toMatch(/\bfs\./)
    for (const fn of ['checkSaveOwner', 'checkTrashArgs', 'parseSaveLedger', 'ledgerGroup', 'ledgerWith', 'selectTrashGroups', 'judgeSavedFile', 'trashSavedGroups']) {
      expect(saveRules, fn).toMatch(new RegExp(`function ${fn}\\(`))
    }
  })
})

describe('files bridge in electron/preload.cjs', () => {
  it('trashSaved passes exactly { folderPath, folderId, items: [{ takeId, groupIds }] }', () => {
    expect(count(preloadSource, "'files:trashSaved'")).toBe(1)
    const call = /ipcRenderer\.invoke\('files:trashSaved', \{ (.*) \}\)/.exec(preloadSource)
    expect(call).not.toBeNull()
    expect([...call![1].matchAll(/(?:^|, )(\w+): /g)].map((m) => m[1])).toEqual(['folderPath', 'folderId', 'items'])
    expect(call![1]).toContain('items: trashItems(args && args.items)')
    const items = /const trashItems = \(items\) =>([\s\S]*?)\n\n/.exec(preloadSource)
    expect(items).not.toBeNull()
    expect([...items![1].matchAll(/\(\{ (\w+): [^,]*, (\w+): /g)].flatMap((m) => [m[1], m[2]])).toEqual(['takeId', 'groupIds'])
    expect(items![1]).toContain('.map(str)')
    expect(preloadSource).not.toMatch(/ipcRenderer\.send(Sync)?\('files:/)
  })

  it('writeToFolder passes { folderPath, files, owner } with owner = { folderId, takeId, via } (strings)', () => {
    const call = /ipcRenderer\.invoke\('files:writeToFolder', \{ (.*) \}\)/.exec(preloadSource)
    expect(call).not.toBeNull()
    expect([...call![1].matchAll(/(?:^|, )(\w+): /g)].map((m) => m[1])).toEqual(['folderPath', 'files', 'owner'])
    expect(call![1]).toContain('owner: saveOwner(args && args.owner)')
    expect(preloadSource).toContain(
      "const saveOwner = (o) => (o && typeof o === 'object' ? { folderId: str(o.folderId), takeId: str(o.takeId), via: str(o.via) } : undefined)",
    )
  })

  it('files block keys, and updates is still the last top-level key', () => {
    const files = /\n {2}files: \{([\s\S]*?)\n {2}\},\n/.exec(preloadSource)
    expect(files).not.toBeNull()
    expect([...files![1].matchAll(/^ {4}(\w+): /gm)].map((m) => m[1])).toEqual(['pickFolder', 'folderStatus', 'writeToFolder', 'trashSaved', 'openFolder', 'saveAs'])
    const topKeys = [...preloadSource.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1])
    expect(topKeys.at(-1)).toBe('updates')
  })
})
