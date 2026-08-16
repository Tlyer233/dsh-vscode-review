/**
 * dsh-review smoke test — runs the plugin apply() against a minimal fake ctx
 * and a real-disk-backed fake fs, then drives the dsh event sequence for
 * write/edit and asserts: journal entries, snapshot files, fake trae CLI
 * invocation, review_status verification, version-guarded review_revert,
 * create→revert deleting the file, and the stale-guard refusal.
 *
 * Run:  node test/smoke.mjs   (from the plugin directory)
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, chmodSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(__dirname, '..')

let failures = 0
function check(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name)
  else { failures++; console.error('  ✗ ' + name + (extra !== undefined ? ' — ' + extra : '')) }
}

// ── real-disk-backed fake ctx + fake fs ─────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'dsh-review-test-'))
const workspace = join(tmp, 'workspace')
mkdirSync(workspace, { recursive: true })

function makeFs(root) {
  let counter = 0
  const writeLog = []
  const abs = (t) => t.displayPath.replace(/^key:/, '')
  return {
    writeLog,
    resolve: async (p) => { const a = isAbsolute(p) ? p : join(root, p); return { targetKey: 'key:' + a, displayPath: a } },
    processPath: (t) => abs(t),
    stat: async (target) => {
      const a = abs(target)
      if (!existsSync(a)) return undefined
      return { type: 'file', version: 'v' + counter, size: statSync(a).size }
    },
    readBytes: async (target, _signal, maxBytes) => {
      const a = abs(target)
      if (!existsSync(a)) return undefined
      return Buffer.from(readFileSync(a, 'utf8')).subarray(0, maxBytes)
    },
    readText: async (target) => {
      const a = abs(target)
      return existsSync(a) ? readFileSync(a, 'utf8') : undefined
    },
    writeText: async (target, content, expected, _signal) => {
      const a = abs(target)
      const before = existsSync(a) ? readFileSync(a, 'utf8') : undefined
      if (expected && expected.kind === 'replaceIfVersion') {
        if (expected.version !== 'v' + counter) {
          const err = new Error('stale: expected ' + expected.version + ' got v' + counter)
          err.code = 'FS_STALE_VERSION'
          throw err
        }
      }
      mkdirSync(dirname(a), { recursive: true })
      writeFileSync(a, content, 'utf8')
      counter++
      const version = 'v' + counter
      const operation = before === undefined ? 'create' : 'update'
      const outcome = { operation, version, before: before === undefined ? null : before, after: content }
      writeLog.push({ abs: a, operation, version, content })
      return outcome
    },
    editText: async (target, edit, _expected, _signal) => {
      const a = abs(target)
      const before = existsSync(a) ? readFileSync(a, 'utf8') : ''
      if (!before.includes(edit.oldString)) { const e = new Error('no match'); e.code = 'FS_EDIT_NOT_FOUND'; throw e }
      const after = edit.replaceAll ? before.split(edit.oldString).join(edit.newString) : before.replace(edit.oldString, edit.newString)
      writeFileSync(a, after, 'utf8')
      counter++
      return { version: 'v' + counter, before, after }
    },
    currentVersion: () => 'v' + counter,
  }
}

const listeners = new Map()
const registeredTools = {}
const sections = []
let fs = makeFs(workspace)
const context = {
  on: (event, cb) => {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(cb)
  },
  get: (key) => (key === 'fs' ? fs : undefined),
  emit: () => {},
  logger: { warn: (...a) => console.warn('[fake-ctx]', ...a) },
  tools: { register: (def) => { registeredTools[def.name] = def } },
  systemPrompt: { section: (s) => sections.push(s) },
  inject: (_services, cb) => cb(context),
  effect: () => () => {},
}

// ── fake trae CLI: records argv lines to a log file ─────────────────────────
const traeLog = join(tmp, 'trae.log')
const fakeTrae = join(tmp, 'fake-trae.mjs')
const NL = String.fromCharCode(10)
writeFileSync(fakeTrae, [
  '#!/usr/bin/env node',
  "import { appendFileSync } from 'node:fs'",
  "appendFileSync(process.env.FAKE_TRAE_LOG, JSON.stringify({ args: process.argv.slice(2) }) + String.fromCharCode(10))",
  '',
].join(NL))
chmodSync(fakeTrae, 0o755)
process.env.FAKE_TRAE_LOG = traeLog

// ── load and apply the plugin ───────────────────────────────────────────────
const plugin = await import(join(pluginDir, 'lib/index.js'))
const journal = await import(join(pluginDir, 'lib/review-journal.js'))
const journalDir = join(tmp, 'review-store')
plugin.apply(context, {
  journalDir,
  autoOpenDiff: true,
  openOnRevert: true,
  traeCommand: fakeTrae,
  reuseWindow: false,
})

const changesDir = journal.changesDir
function walkJson(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => n.endsWith('.json'))
}
function readEntry(id) {
  return JSON.parse(readFileSync(join(changesDir(journalDir), id + '.json'), 'utf8'))
}
function traeCalls() {
  if (!existsSync(traeLog)) return []
  return readFileSync(traeLog, 'utf8').trim().split(NL).filter(Boolean).map((l) => JSON.parse(l))
}
async function waitTraeCalls(count, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const calls = traeCalls()
    if (calls.length >= count) return calls
    await sleep(50)
  }
  return traeCalls()
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function execFor(name, args) {
  return { name, arguments: args, callId: 'cid-' + Math.random(), signal: new AbortController().signal, agent: undefined, token: Symbol('t') }
}
async function preExecute(exec) {
  const cbs = listeners.get('tools/pre-execute') || []
  for (const cb of cbs) await cb(exec, async () => ({ kind: 'allow' }))
}
function observed(target, version) {
  const cbs = listeners.get('fs/observed') || []
  for (const cb of cbs) cb(target, { kind: 'present', version })
}
function toolsResult(exec, value) {
  const cbs = listeners.get('tools/result') || []
  for (const cb of cbs) cb(exec, { isError: false, value })
}

// ── scenario 1: write (update) → verify → second write → revert → stale ─────
console.log('\n[1] write-update flow')
let entry1Id
{
  const filePath = join(workspace, 'src/app.js')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(filePath, 'line1' + NL + 'line2' + NL, 'utf8')
  const content = 'line1' + NL + 'line2' + NL + 'line3-ai' + NL
  const target = { targetKey: 'key:' + filePath, displayPath: filePath }

  const outcome = await fs.writeText(target, content)
  const exec = execFor('write', { file_path: 'src/app.js', content })
  await preExecute(exec)
  observed(target, outcome.version)
  toolsResult(exec, { path: filePath, operation: 'update', before: 'line1' + NL + 'line2' + NL, after: content })
  await sleep(250)

  const jsons = walkJson(changesDir(journalDir))
  check('journal entry created', jsons.length === 1, 'found ' + jsons.length)
  const id = jsons[0].slice(0, -5)
  entry1Id = id
  const entry = readEntry(id)
  check('entry committed', entry.status === 'committed')
  check('entry beforeAvailable', entry.beforeAvailable === true)
  check('entry operation update', entry.operation === 'update')
  check('entry version recorded', typeof entry.version === 'string' && entry.version.length > 0)
  check('before snapshot exact', readFileSync(join(changesDir(journalDir), id + '.before'), 'utf8') === 'line1' + NL + 'line2' + NL)
  check('after snapshot exact', readFileSync(join(changesDir(journalDir), id + '.after'), 'utf8') === content)

  const calls = await waitTraeCalls(1)
  check('trae --diff invoked once', calls.length === 1 && calls[0].args[0] === '--diff')
  if (!calls.length) {
    const e1 = readEntry(id)
    console.error('    debug traeResult:', JSON.stringify(e1.traeResult), 'opened:', e1.openedInTrae)
  }
  check('trae left = before snapshot', calls[0] && calls[0].args[1] === join(changesDir(journalDir), id + '.before'))
  check('trae right = real file', calls[0] && calls[0].args[2] === filePath)
  check('trae no reuse-window', calls[0] && !calls[0].args.includes('--reuse-window'))

  const statusTool = registeredTools['review_status']
  const status1 = await statusTool.execute({})
  check('review_status total=1', status1.total === 1)
  check('review_status verified match', status1.entries[0].verified === 'match')
  check('review_status opened flag', status1.entries[0].opened_in_trae === true)

  // drift detection (manual external edit)
  writeFileSync(filePath, 'line1' + NL + 'CHANGED' + NL + 'line3-ai' + NL, 'utf8')
  const status2 = await statusTool.execute({})
  check('review_status drifted detected', status2.entries[0].verified === 'drifted')
  writeFileSync(filePath, content, 'utf8')

  // second AI write on the same file → newer committed entry
  const content2 = 'line1' + NL + 'line2' + NL + 'line3-ai' + NL + 'line4' + NL
  const outcome2 = await fs.writeText(target, content2)
  const exec2 = execFor('write', { file_path: 'src/app.js', content: content2 })
  await preExecute(exec2)
  observed(target, outcome2.version)
  toolsResult(exec2, { path: filePath, operation: 'update', before: content, after: content2 })
  await sleep(250)
  const jsons2 = walkJson(changesDir(journalDir))
  check('second entry recorded', jsons2.length === 2)

  // revert → newest committed entry (entry2) restored
  const revertTool = registeredTools['review_revert']
  const rev = await revertTool.execute({ file_path: 'src/app.js' }, execFor('review_revert', {}))
  check('revert returns reverted', rev.status === 'reverted')
  check('revert restored previous content', readFileSync(filePath, 'utf8') === content)
  const entry2 = readEntry(rev.id)
  check('entry2 marked reverted', entry2.status === 'reverted' && entry2.revertedAt !== null)

  const calls2 = await waitTraeCalls(3)
  check('trae revert diff (after vs real)', calls2.length === 3 && calls2[2].args[0] === '--diff' && calls2[2].args[1].endsWith('.after'))

  // stale guard: reverting the OLD entry (v1) now must refuse
  let staleRefused = false
  try {
    await revertTool.execute({ file_path: 'src/app.js', change_id: entry1Id }, execFor('review_revert', {}))
  } catch (error) {
    staleRefused = /stale|fs version mismatch|changed after/i.test(String(error.message))
    if (!staleRefused) console.error('    unexpected error:', error.message)
  }
  check('stale guard refuses old-version revert', staleRefused)
}

// ── scenario 2: write (create) then revert deletes ──────────────────────────
console.log('\n[2] create then revert-delete flow')
{
  const filePath = join(workspace, 'new/thing.txt')
  const content = 'brand new file' + NL
  const target = { targetKey: 'key:' + filePath, displayPath: filePath }
  const outcome = await fs.writeText(target, content) // simulate AI creation
  const exec = execFor('write', { file_path: 'new/thing.txt', content })
  await preExecute(exec)
  observed(target, outcome.version)
  toolsResult(exec, { path: filePath, operation: 'create', before: null, after: content })
  await sleep(250)

  const jsons = walkJson(changesDir(journalDir))
  const createEntries = jsons.map((n) => readEntry(n.slice(0, -5))).filter((e) => e.operation === 'create')
  check('create entry recorded', createEntries.length === 1)
  const createEntry = createEntries[0]
  check('create beforeAvailable false', createEntry.beforeAvailable === false)
  check('empty left snapshot written', existsSync(join(changesDir(journalDir), createEntry.id + '.before')))

  const revertTool = registeredTools['review_revert']
  const res = await revertTool.execute({ file_path: filePath }, execFor('review_revert', {}))
  check('revert-delete ok', res.deleted === true)
  check('created file removed from disk', !existsSync(filePath))
  check('create entry marked reverted', readEntry(createEntry.id).status === 'reverted')
}

// ── scenario 3: edit flow ───────────────────────────────────────────────────
console.log('\n[3] edit flow')
{
  const filePath = join(workspace, 'src/edit-me.txt')
  writeFileSync(filePath, 'aaa' + NL + 'bbb' + NL + 'ccc' + NL, 'utf8')
  const target = { targetKey: 'key:' + filePath, displayPath: filePath }
  const exec = execFor('edit', { file_path: 'src/edit-me.txt', old_string: 'bbb', new_string: 'BBB' })
  await preExecute(exec)
  const outcome = await fs.editText(target, { oldString: 'bbb', newString: 'BBB', replaceAll: false })
  observed(target, outcome.version)
  toolsResult(exec, { path: filePath, before: outcome.before, after: outcome.after })
  await sleep(250)

  const jsons = walkJson(changesDir(journalDir))
  const editEntry = jsons.map((n) => readEntry(n.slice(0, -5))).find((e) => e.tool === 'edit' && e.filePath === filePath)
  check('edit entry recorded', editEntry !== undefined)
  if (editEntry) {
    check('edit beforeAvailable', editEntry.beforeAvailable === true)
    check('edit before snapshot', readFileSync(join(changesDir(journalDir), editEntry.id + '.before'), 'utf8') === 'aaa' + NL + 'bbb' + NL + 'ccc' + NL)
    const revertTool = registeredTools['review_revert']
    await revertTool.execute({ file_path: 'src/edit-me.txt' }, execFor('review_revert', {}))
    check('edit reverted content', readFileSync(filePath, 'utf8') === 'aaa' + NL + 'bbb' + NL + 'ccc' + NL)
  }
}

// ── summary ─────────────────────────────────────────────────────────────────
console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'))
rmSync(tmp, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)

