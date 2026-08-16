import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const journal = require('../lib/journal.js')
const commit = require('../lib/commit.js')

let failures = 0
function check(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name)
  else { failures++; console.error('  ✗ ' + name + (extra !== undefined ? ' — ' + extra : '')) }
}

const store = mkdtempSync(join(tmpdir(), 'dsh-review-vscode-test-'))
mkdirSync(store, { recursive: true })
const NL = String.fromCharCode(10)

// fixture: one update entry + one create entry
const updId = '11111111-aaaa-4bbb-8ccc-000000000001'
const updFile = join(store, '..', 'work-file.txt')
writeFileSync(updFile, 'v1' + NL + 'v2' + NL, 'utf8')
writeFileSync(join(store, updId + '.json'), JSON.stringify({
  id: updId, at: '2026-01-01T00:00:00.000Z', tool: 'write',
  filePath: updFile, operation: 'update', status: 'committed',
  beforeAvailable: true, beforeTruncated: false, afterAvailable: true,
  revertedAt: null,
}, null, 2) + NL)
writeFileSync(join(store, updId + '.before'), 'v1' + NL + 'v2' + NL, 'utf8')
writeFileSync(join(store, updId + '.after'), 'v1b' + NL + 'v2' + NL, 'utf8')

const creId = '22222222-bbbb-4ccc-8ddd-000000000002'
const creFile = join(store, '..', 'new-file.txt')
writeFileSync(join(store, creId + '.json'), JSON.stringify({
  id: creId, at: '2026-01-01T00:00:01.000Z', tool: 'write',
  filePath: creFile, operation: 'create', status: 'committed',
  beforeAvailable: false, beforeTruncated: false, afterAvailable: true,
  revertedAt: null,
}, null, 2) + NL)
writeFileSync(join(store, creId + '.before'), '')
writeFileSync(join(store, creId + '.after'), 'brand new' + NL, 'utf8')

console.log('\n[1] journal')
{
  const entries = journal.listEntries(store)
  check('lists 2 entries', entries.length === 2)
  check('newest first', entries[0].id === creId)
  const found = journal.findEntryForFile(store, updFile)
  check('find by absolute path', found && found.id === updId)
  const byBase = journal.findEntryForFile(store, 'work-file.txt')
  check('find by basename', byBase && byBase.id === updId)
  const byKey = journal.findEntryForFile(store, 'key:' + updFile)
  check('find by key: prefix', byKey && byKey.id === updId)
  const byId = journal.findEntryForFile(store, creFile, creId)
  check('find by change_id', byId && byId.id === creId)
  check('missing file -> null', journal.findEntryForFile(store, join(store, 'nope.txt')) === null)
  check('titleFor sane', journal.titleFor(entries[0]).includes('create'))
  check('beforePath resolves', journal.beforePathOf(store, updId).endsWith('.before'))

  // Absolute path must not be stolen by another file with the same basename.
  const pk1 = join(store, '..', 'a', 'package.json')
  const pk2 = join(store, '..', 'b', 'package.json')
  const pk1Id = 'aaaaaaaa-1111-4bbb-8ccc-00000000000a'
  const pk2Id = 'bbbbbbbb-2222-4ccc-8ddd-00000000000b'
  writeFileSync(join(store, pk1Id + '.json'), JSON.stringify({ id: pk1Id, at: '2025-01-01T00:00:00.000Z', tool: 'edit', filePath: pk1, operation: 'update', status: 'committed' }) + NL)
  writeFileSync(join(store, pk2Id + '.json'), JSON.stringify({ id: pk2Id, at: '2026-01-02T00:00:00.000Z', tool: 'edit', filePath: pk2, operation: 'update', status: 'committed' }) + NL)
  check('absolute path matches exact entry', journal.findEntryForFile(store, pk1)?.id === pk1Id)
  check('basename lookup still works', journal.findEntryForFile(store, 'package.json')?.id === pk2Id)
}

console.log('\n[2] verify')
{
  const fsx = {
    readFile: async (p) => { try { return Buffer.from(readFileSync(p, 'utf8')) } catch { return null } },
    writeFile: async () => {}, deleteFile: async () => {}, exists: async () => true,
  }
  const upd = journal.readManifest(store, updId)
  writeFileSync(updFile, 'v1b' + NL + 'v2' + NL, 'utf8')
  let v = await commit.verifyEntry({ fsx, entry: upd, afterBytes: readFileSync(join(store, updId + '.after')) })
  check('match detected', v === 'match')
  writeFileSync(updFile, 'v1b' + NL + 'HUMAN' + NL, 'utf8')
  v = await commit.verifyEntry({ fsx, entry: upd, afterBytes: readFileSync(join(store, updId + '.after')) })
  check('drift detected', v === 'drifted')
  rmSync(updFile)
  v = await commit.verifyEntry({ fsx, entry: upd, afterBytes: readFileSync(join(store, updId + '.after')) })
  check('missing detected', v === 'missing')
  writeFileSync(updFile, 'v1' + NL + 'v2' + NL, 'utf8')
}

console.log('\n[3] revert (update)')
{
  const fsx = {
    readFile: async (p) => { try { return Buffer.from(readFileSync(p, 'utf8')) } catch { return null } },
    writeFile: async (p, buf) => { writeFileSync(p, buf, 'utf8') },
    deleteFile: async (p) => { rmSync(p) },
    exists: async (p) => existsSync(p),
  }
  const upd = journal.readManifest(store, updId)
  const res = await commit.revertEntry({ fsx, entry: upd, beforeBytes: readFileSync(join(store, updId + '.before')) })
  check('revert ok', res.ok === true && res.action === 'update')
  check('content restored', readFileSync(updFile, 'utf8') === 'v1' + NL + 'v2' + NL)
  journal.markEntry(store, updId, { status: 'reverted', revertedAt: '2026-01-01T00:00:02.000Z' })
  const again = await commit.revertEntry({ fsx, entry: journal.readManifest(store, updId), beforeBytes: Buffer.from('x') })
  check('already-reverted refused', again.ok === false && /already reverted/.test(again.error))
  check('markEntry persisted', journal.readManifest(store, updId).status === 'reverted')
}

console.log('\n[4] revert (create -> delete)')
{
  const fsx = {
    readFile: async () => null,
    writeFile: async () => {},
    deleteFile: async (p) => { rmSync(p) },
    exists: async (p) => existsSync(p),
  }
  writeFileSync(creFile, 'brand new' + NL, 'utf8')
  const cre = journal.readManifest(store, creId)
  const res = await commit.revertEntry({ fsx, entry: cre, beforeBytes: null })
  check('create reverted by delete', res.ok === true && res.action === 'deleted')
  check('file removed', !existsSync(creFile))
}

console.log('\n[5] resolveStoreDir')
{
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/fake-dsh-home'
  check('default honors DSH_HOME', journal.defaultStoreDir() === resolve('/tmp/fake-dsh-home/review/changes'))
  delete process.env.DSH_HOME
  const home = require('node:os').homedir()
  check('default (no DSH_HOME) is ~/.dsh/review/changes', journal.defaultStoreDir() === join(home, '.dsh', 'review', 'changes'))
  process.env.DSH_HOME = old
  check('configured path wins', journal.resolveStoreDir('/data/review') === resolve('/data/review'))
  check('tilde expanded', journal.resolveStoreDir('~/review/x') === join(home, 'review', 'x'))
  check('empty -> default', journal.resolveStoreDir('') === journal.defaultStoreDir())
}

rmSync(updFile, { force: true })
rmSync(creFile, { force: true })
rmSync(store, { recursive: true, force: true })
console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'))
process.exit(failures === 0 ? 0 : 1)

