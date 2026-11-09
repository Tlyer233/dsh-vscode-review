/**
 * Global shadow git: bare repo at ~/.dsh/review/shadow/repo.git.
 * Each snapshot only writes the touched file blob (no full-tree add -A).
 * Tree path = files/<sha1(canonical absPath)> so any absolute path works.
 *
 * Guards (shadow-bloat postmortem):
 *  - Oversized (>8 MiB) or binary (NUL / known magic) files are stored as a
 *    one-line pointer blob, never the body: 12 GiB of zips lived in the
 *    current tree because the snapshot had no size/type gate.
 *  - Bare repos reject `update-index --force-remove` ("must be run in a work
 *    tree", rc 128) — the old delete path swallowed that fatal, so the tree
 *    only ever grew. Removals now rebuild the index from `ls-tree` minus the
 *    key, and any other failure is LOGGED instead of hushed.
 *  - HEAD moves via CAS `update-ref HEAD <new> <old>` under a cross-process
 *    lockfile: the dsh host and the VS Code extension commit concurrently and
 *    used to orphan each other's commits (lost update).
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import {
  canonicalWorkbench,
  ensureShadowRoot,
  globalGitDir,
  shadowRoot,
} from './workbench.js'
import { acquireLock, releaseLock, refOldValue } from './lockfile.js'

const execFileAsync = promisify(execFile)

const snapshotLockPath = () => join(shadowRoot(), '.snapshot.lock')
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
export const POINTER_PREFIX = 'DSSHADOW1 ptr '

/** Serialize all snapshots in THIS process; the lockfile covers the other one. */
let snapshotTail = Promise.resolve()

/**
 * Run `fn` after prior snapshots finish (does not skip the next on failure).
 * @param {() => Promise<any>} fn
 */
function enqueueSnapshot(fn) {
  const run = snapshotTail.then(fn, fn)
  snapshotTail = run.then(() => undefined, () => undefined)
  return run
}

function cleanEnv() {
  const env = { ...process.env }
  for (const k of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_TEMPLATE_DIR',
  ]) delete env[k]
  // The user's global gitconfig must not rewrite snapshot bytes: core.autocrlf
  // affects hash-object/show but NOT cat-file → asymmetric content.
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_SYSTEM = '/dev/null'
  return env
}

/**
 * realpath-normalised absolute path. Only the PARENT is resolved — the file
 * itself may not exist (create-before / delete-after), and realpathing the
 * file would then silently fall back to the raw path and fork the blobKey.
 */
export function canonicalAbs(absFile) {
  const abs = resolve(String(absFile || ''))
  const base = abs.split(/[\\/]/).pop()
  const dir = abs.slice(0, abs.length - base.length)
  try { return join(realpathSync.native(dir), base) } catch { return abs }
}

/** Stable tree path for an absolute file (independent of workbench). */
export function blobKey(absFile) {
  const id = createHash('sha1').update(canonicalAbs(absFile)).digest('hex')
  return 'files/' + id
}

/**
 * Human label for logs: relative to workbench when possible, else abs.
 * @param {string} workbench
 * @param {string} absFile
 */
export function displayPath(workbench, absFile) {
  const root = canonicalWorkbench(workbench)
  const abs = resolve(String(absFile || ''))
  let rel = relative(root, abs)
  if (!rel || rel.startsWith('..')) return abs
  return rel.split('\\').join('/')
}

/** @deprecated use displayPath — kept name for call sites that meant "label" */
export function relPath(workbench, absFile) {
  return displayPath(workbench, absFile)
}

async function git(args, extraEnv = {}) {
  const gitDir = globalGitDir()
  const { stdout, stderr } = await execFileAsync('git', [
    '--git-dir', gitDir,
    ...args,
  ], {
    env: { ...cleanEnv(), ...extraEnv },
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  })
  if (stderr && /fatal:/i.test(stderr)) throw new Error(stderr.trim())
  return String(stdout || '').trim()
}

/**
 * Write `text` into the object store via `hash-object -w --stdin`.
 * @param {string} text
 * @param {Record<string,string>} extraEnv
 * @returns {Promise<string>} blob id
 */
function hashTextObject(text, extraEnv = {}) {
  const gitDir = globalGitDir()
  return new Promise((res, rej) => {
    const child = spawn('git', ['--git-dir', gitDir, 'hash-object', '-w', '--stdin'], {
      env: { ...cleanEnv(), ...extraEnv },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', rej)
    child.on('close', (code) => {
      if (code !== 0) rej(new Error((err || 'hash-object exit ' + code).trim()))
      else res(String(out).trim())
    })
    child.stdin.end(String(text), 'utf8')
  })
}

/** True when `text` is a snapshot pointer line (body was never stored). */
export function isPointerText(text) {
  return typeof text === 'string' && text.startsWith(POINTER_PREFIX)
}

/**
 * Decide whether this file's body must NOT enter the object store.
 * @param {string} abs
 * @returns {Promise<{skip: boolean, size: number, reason: string}>}
 */
export async function snapshotGate(abs) {
  let st
  try { st = statSync(abs) } catch { return { skip: false, size: 0, reason: '' } }
  if (!st.isFile()) return { skip: false, size: 0, reason: '' }
  if (st.size > MAX_SNAPSHOT_BYTES) return { skip: true, size: st.size, reason: 'size>' + MAX_SNAPSHOT_BYTES }
  let fd = -1
  try {
    const head = Buffer.alloc(Math.min(st.size, 8192))
    fd = openSync(abs, 'r')
    const n = readSync(fd, head, 0, head.length, 0)
    const b = head.subarray(0, n)
    for (let i = 0; i < b.length; i++) if (b[i] === 0) return { skip: true, size: st.size, reason: 'nul' }
    const l = b.subarray(0, 8).toString('latin1')
    if (
      l.startsWith('PK\x03\x04') || l.startsWith('\x1f\x8b') ||
      l.startsWith('\x89PNG\r\n\x1a\n') || l.startsWith('\xff\xd8\xff') ||
      l.startsWith('%PDF-') || l.startsWith('\x7fELF') ||
      l.startsWith('\xca\xfe\xba\xbe') || l.startsWith('Rar!\x1a\x07')
    ) return { skip: true, size: st.size, reason: 'magic' }
    return { skip: false, size: st.size, reason: '' }
  } catch {
    return { skip: false, size: st.size, reason: '' }
  } finally {
    if (fd >= 0) { try { closeSync(fd) } catch { /* noop */ } }
  }
}

/** Pointer line body: prefix + path + size + mtime (path may contain spaces). */
function pointerText(abs, size, mtimeMs) {
  return POINTER_PREFIX + abs + ' ' + size + ' ' + Math.floor(mtimeMs)
}

/**
 * Rebuild a fresh index from `<commit>`'s tree minus `dropKey`, in ONE
 * `update-index -z --add --remove --stdin` call fed with `cacheinfo` records.
 * Bare-safe: this replaces the always-failing `update-index --force-remove`.
 * Whole-output Buffer assembly (no chunk splitting, UTF-8 paths preserved).
 * @param {string} commit
 * @param {string} dropKey
 * @param {Record<string,string>} env  (must carry GIT_INDEX_FILE)
 */
async function reindexFromTree(commit, dropKey, env) {
  const gitDir = globalGitDir()
  const raw = await new Promise((res, rej) => {
    const ls = spawn('git', ['--git-dir', gitDir, 'ls-tree', '-r', '-z', commit], { env: { ...cleanEnv() } })
    const chunks = []
    let err = ''
    ls.stdout.on('data', (d) => chunks.push(d))
    ls.stderr.on('data', (d) => { err += d })
    ls.on('error', rej)
    ls.on('close', (code) => {
      if (code !== 0) rej(new Error((err || 'ls-tree exit ' + code).trim()))
      else res(Buffer.concat(chunks))
    })
  })

  const parts = []
  for (const entry of raw.toString('utf8').split('\0')) {
    if (!entry) continue
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const path = entry.slice(tab + 1)
    if (path === dropKey) continue // the removal itself
    const meta = entry.slice(0, tab).split(' ')
    if (meta.length !== 3 || meta[1] !== 'blob') continue // skip symlinks/gitsubs
    parts.push(Buffer.from(meta[0] + ' ' + meta[2] + ' ' + path + '\0', 'utf8'))
  }
  if (!parts.length) return // parent tree held only this key → empty index is correct

  await new Promise((res, rej) => {
    const ux = spawn('git', ['--git-dir', gitDir, 'update-index', '-z', '--add', '--remove', '--stdin'], { env: { ...cleanEnv(), ...env } })
    let err = ''
    ux.stderr.on('data', (d) => { err += d })
    ux.on('error', rej)
    ux.on('close', (code) => {
      if (code !== 0) rej(new Error((err || 'update-index exit ' + code).trim()))
      else res()
    })
    ux.stdin.end(Buffer.concat(parts))
  })
}

export async function ensureShadowRepo() {
  ensureShadowRoot()
  const gitDir = globalGitDir()
  if (!existsSync(join(gitDir, 'HEAD'))) {
    mkdirSync(gitDir, { recursive: true })
    await execFileAsync('git', ['init', '--bare', '--template=', gitDir], {
      env: cleanEnv(),
      encoding: 'utf8',
    })
    await git(['config', 'commit.gpgSign', 'false'])
    await git(['config', 'user.name', 'dsh-shadow'])
    await git(['config', 'user.email', 'shadow@localhost'])
    // Byte-faithful snapshots + we own maintenance (DeepSeek-TUI / d4-snap
    // convention): auto-gc must never fire under a plumbing-only writer.
    await git(['config', 'core.autocrlf', 'false'])
    await git(['config', 'gc.auto', '0'])
  }
  maybeStartMaintain()
  return { gitDir }
}

/**
 * Detached maintenance trigger (hermes-agent style): fires at most every 7
 * days off the .last-maintain marker; never blocks or breaks a snapshot.
 * The child gets DSH_SHADOW_MAINTAIN=1 so its own ensureShadowRepo does not
 * re-trigger.
 */
function maybeStartMaintain() {
  if (process.env.DSH_SHADOW_MAINTAIN === '1') return
  const marker = join(shadowRoot(), '.last-maintain')
  let fire = true
  try {
    if (Date.now() - statSync(marker).mtimeMs < 7 * 24 * 3600 * 1000) fire = false
  } catch { /* missing marker → run */ }
  if (!fire) return
  try { writeFileSync(marker, '', { flag: 'a' }) } catch { /* best effort */ }
  try {
    const script = fileURLToPath(import.meta.url).replace(/shadow\.js$/, 'maintain.js')
    const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore', env: { ...process.env, DSH_SHADOW_MAINTAIN: '1' } })
    child.on('error', () => { /* node missing? irrelevant to snapshot */ })
    child.unref()
  } catch { /* best effort */ }
}

/**
 * One-file snapshot. Queued (process) + locked (cross-process). Missing file
 * → drop that blob key from the tree (create-before / delete-after).
 * @param {string} absFile
 * @param {string} message
 * @returns {Promise<string>} commit hash
 */
export async function commitFileSnapshot(absFile, message) {
  return enqueueSnapshot(async () => {
    const lock = acquireLock(snapshotLockPath())
    try {
      return await commitFileSnapshotNow(absFile, message)
    } finally {
      releaseLock(lock)
    }
  })
}

/**
 * Isolated git index per call; runs under enqueueSnapshot + snapshot lock,
 * with CAS update-ref and up to 3 retries on HEAD drift.
 * @param {string} absFile
 * @param {string} message
 * @returns {Promise<string>}
 */
async function commitFileSnapshotNow(absFile, message) {
  await ensureShadowRepo()
  const abs = canonicalAbs(absFile)
  const key = blobKey(absFile)

  for (let attempt = 0; attempt < 3; attempt++) {
    const indexFile = join(shadowRoot(), '.index-' + randomBytes(8).toString('hex'))
    const env = { GIT_INDEX_FILE: indexFile }
    try {
      let parent = ''
      try {
        parent = await git(['rev-parse', 'HEAD'])
      } catch { /* empty repo */ }

      if (existsSync(abs)) {
        let blob
        const gate = await snapshotGate(abs)
        if (gate.skip) {
          let st
          try { st = statSync(abs) } catch { st = { size: gate.size, mtimeMs: 0 } }
          blob = await hashTextObject(pointerText(abs, st.size, st.mtimeMs), env)
          console.info('[dsh-review] snapshot pointer:', displayPath('.', abs), gate.reason, st.size + 'B')
        } else {
          blob = await git(['hash-object', '-w', '--', abs])
        }
        // Pointer lines embed mtime; identical content must not churn commits.
        if (parent) {
          try {
            const prev = await git(['rev-parse', parent + ':' + key])
            if (prev === blob) return parent
          } catch { /* key not in parent tree */ }
        }
        if (parent) await git(['read-tree', parent], env)
        await git(['update-index', '--add', '--cacheinfo', '100644', blob, key], env)
      } else if (parent) {
        let inTree = true
        try {
          await git(['rev-parse', parent + ':' + key])
        } catch { inTree = false }
        if (inTree) await reindexFromTree(parent, key, env)
      }

      const tree = await git(['write-tree'], env)
      const commitArgs = parent
        ? ['commit-tree', tree, '-p', parent, '-m', String(message || 'snapshot')]
        : ['commit-tree', tree, '-m', String(message || 'snapshot')]
      const commit = await git(commitArgs)
      try {
        await git(['update-ref', 'HEAD', commit, refOldValue(parent)])
      } catch (e) {
        const drift = String((e && e.message) || '')
        if (/value of /i.test(drift) && attempt < 2) {
          console.warn('[dsh-review] HEAD drifted, retrying:', drift)
          continue
        }
        throw e
      }
      return commit
    } finally {
      try { unlinkSync(indexFile) } catch { /* noop */ }
      try { unlinkSync(indexFile + '.lock') } catch { /* noop */ }
    }
  }
  throw new Error('commitFileSnapshot: HEAD kept drifting, giving up after 3 attempts')
}

/**
 * Read file content at a shadow commit OR a bare blob id (pending stores blob
 * ids since 2.1.22; older entries carry commit hashes — both must resolve).
 * Pointer blobs read as "absent": the body was never stored (oversize /
 * binary), so callers must not diff the pointer line as file text.
 * @param {string} commitOrBlob
 * @param {string} absFile
 * @returns {Promise<string|null>}
 */
export async function showAt(commitOrBlob, absFile) {
  if (!commitOrBlob || !absFile) return null
  const key = blobKey(absFile)
  let text = null
  try {
    await ensureShadowRepo()
    text = await git(['show', `${commitOrBlob}:${key}`])
  } catch { /* blob id (2.1.22+) or key absent at this commit */ }
  if (text == null) {
    // Second chance: the id is a raw blob (post-2.1.22 pending). Guard the
    // type first — cat-file on a COMMIT object would dump raw commit bytes
    // and poison the diff baseline.
    let type = ''
    try { type = await git(['cat-file', '-t', commitOrBlob]) } catch { /* unknown */ }
    if (type !== 'blob') return null
    try {
      text = await git(['cat-file', 'blob', commitOrBlob])
    } catch (e) {
      console.warn('[dsh-review] showAt failed:', String((e && e.message) || e))
      return null
    }
  }
  if (isPointerText(text)) return null
  return text
}

/**
 * Blob id stored for `absFile` at `commit` (null when absent / pointer-only).
 * pending should carry THIS (not the commit hash): a commit pins the whole
 * cumulative tree — every other file's blob too — which defeats gc reclaim.
 * @param {string} commit
 * @param {string} absFile
 * @returns {Promise<string|null>}
 */
export async function treeEntryBlobId(commit, absFile) {
  if (!commit || !absFile) return null
  try {
    return await git(['rev-parse', commit + ':' + blobKey(absFile)]) || null
  } catch {
    return null // key absent at this commit (create-before / after-delete)
  }
}

export function entryId(filePath) {
  return createHash('sha1').update(String(filePath)).digest('hex').slice(0, 12)
}

/** @deprecated no-op alias — global repo has no per-wb dir */
export function shadowPaths() {
  return { gitDir: globalGitDir(), root: shadowRoot() }
}
