'use strict'

/**
 * Read from global shadow bare repo (matches dsh-review/shadow.js).
 * Tree path = files/<sha1(canonical absPath)>.
 *
 * Mirror of the host guards (shadow-bloat postmortem):
 *  - pointer blobs (oversize/binary) read as "absent" (null), never as text;
 *  - HEAD moves use CAS update-ref under the shared .snapshot.lock;
 *  - user gitconfig is isolated (GIT_CONFIG_GLOBAL=/dev/null) so autocrlf
 *    cannot make commit-path and cat-file-path read back different bytes.
 */

const { execFile, spawn } = require('node:child_process')
const crypto = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const { globalGitDir, ensureShadowRoot, shadowRoot } = require('./workbench.js')
const { acquireLock, releaseLock, refOldValue } = require('./lockfile.js')
const { maybeStartMaintain } = require('./shadow-maintain.js')

const POINTER_PREFIX = 'DSSHADOW1 ptr '
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
const snapshotLockPath = () => path.join(shadowRoot(), '.snapshot.lock')

function cleanEnv() {
  const env = { ...process.env }
  for (const k of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_TEMPLATE_DIR',
  ]) delete env[k]
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_SYSTEM = '/dev/null'
  return env
}

function canonicalAbs(absFile) {
  const abs = path.resolve(String(absFile || ''))
  const base = abs.split(/[\\/]/).pop()
  const dir = abs.slice(0, abs.length - base.length)
  try { return path.join(fs.realpathSync.native(dir), base) } catch { return abs }
}

function blobKey(absFile) {
  const id = crypto.createHash('sha1').update(canonicalAbs(absFile)).digest('hex')
  return 'files/' + id
}

/** True when `text` is the host's oversize/binary pointer line. */
function isPointerText(text) {
  return typeof text === 'string' && text.startsWith(POINTER_PREFIX)
}

function gitWith(args, extraEnv) {
  const gitDir = globalGitDir()
  return new Promise((resolve, reject) => {
    execFile('git', ['--git-dir', gitDir, ...args], {
      env: { ...cleanEnv(), ...(extraEnv || {}) },
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message || String(err)).trim()))
        return
      }
      resolve(String(stdout || ''))
    })
  })
}

function git(args) {
  return gitWith(args, null)
}

/**
 * @param {string[]} args
 * @param {string} text
 * @returns {Promise<string>}
 * @description git with stdin (hash-object --stdin).
 */
function gitStdin(args, text) {
  const gitDir = globalGitDir()
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--git-dir', gitDir, ...args], {
      env: cleanEnv(),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error((stderr || 'git exit ' + code).trim()))
        return
      }
      resolve(String(stdout || '').trim())
    })
    child.stdin.end(String(text ?? ''), 'utf8')
  })
}

/**
 * @param {string} text
 * @returns {Promise<string>} blob id
 * @description Write text as a dangling blob (no read-tree / commit-tree).
 */
async function hashTextBlob(text) {
  ensureShadowRoot() // repo dir + pending dir exist
  const blob = await gitStdin(['hash-object', '-w', '--stdin'], text) // one spawn, stdin body
  return String(blob || '').trim() // 40-char sha
}

/**
 * @param {string} absFile
 * @param {string} beforeBlob
 * @param {string} afterBlob
 * @returns {Promise<void>}
 * @description Pin rolling blobs so `git gc` cannot prune them.
 */
async function pinRollingBlobs(absFile, beforeBlob, afterBlob) {
  const id = crypto.createHash('sha1').update(canonicalAbs(absFile)).digest('hex') // same id as blobKey
  if (beforeBlob) await git(['update-ref', 'refs/dsh-review/before/' + id, beforeBlob]) // replace previous before pin
  if (afterBlob) await git(['update-ref', 'refs/dsh-review/after/' + id, afterBlob]) // replace previous after pin
}

let snapshotTail = Promise.resolve()

/**
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
function enqueueSnapshot(fn) {
  const run = snapshotTail.then(fn, fn)
  snapshotTail = run.then(() => undefined, () => undefined)
  return run
}

/**
 * @param {string} absFile
 * @param {string} text
 * @param {string} [message]
 * @returns {Promise<string>} commit hash
 * @description Snapshot in-memory text (ruling baseline / remaining doc).
 *              Locked + CAS like the host side; bodies over 512 MiB are
 *              refused outright (a ruling cannot re-read them anyway).
 */
async function commitTextSnapshot(absFile, text, message) {
  return enqueueSnapshot(async () => {
    const lock = acquireLock(snapshotLockPath())
    try {
      return await commitTextSnapshotNow(absFile, text, message)
    } finally {
      releaseLock(lock)
    }
  })
}

/**
 * @param {string} absFile
 * @param {string} text
 * @param {string} [message]
 * @returns {Promise<string>}
 */
async function commitTextSnapshotNow(absFile, text, message) {
  ensureShadowRoot()
  const gitDir = globalGitDir()
  if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
    throw new Error('shadow repo missing: ' + gitDir)
  }
  maybeStartMaintain() // detached, marker-gated; covers ext-only sessions
  const abs = canonicalAbs(absFile)
  const key = blobKey(abs)
  const bytes = Buffer.byteLength(String(text ?? ''), 'utf8')
  if (bytes > 64 * MAX_SNAPSHOT_BYTES) {
    throw new Error('commitTextSnapshot: text too large (' + bytes + 'B)')
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const indexFile = path.join(shadowRoot(), '.index-' + crypto.randomBytes(8).toString('hex'))
    const envIndex = { GIT_INDEX_FILE: indexFile }
    try {
      let parent = ''
      try {
        parent = String(await git(['rev-parse', 'HEAD'])).trim()
      } catch { /* empty repo */ }
      if (parent) {
        await gitWith(['read-tree', parent], envIndex)
      }
      const blob = await gitStdin(['hash-object', '-w', '--stdin'], text)
      await gitWith(['update-index', '--add', '--cacheinfo', '100644', blob, key], envIndex)
      const tree = String(await gitWith(['write-tree'], envIndex)).trim()
      const commitArgs = parent
        ? ['commit-tree', tree, '-p', parent, '-m', String(message || 'ruling')]
        : ['commit-tree', tree, '-m', String(message || 'ruling')]
      const commit = String(await git(commitArgs)).trim()
      try {
        await git(['update-ref', 'HEAD', commit, refOldValue(parent)])
      } catch (e) {
        const drift = String((e && e.message) || '')
        if (/value of /i.test(drift) && attempt < 2) continue // HEAD moved under us
        throw e
      }
      return commit
    } finally {
      try { fs.unlinkSync(indexFile) } catch { /* noop */ }
      try { fs.unlinkSync(indexFile + '.lock') } catch { /* noop */ }
    }
  }
  throw new Error('commitTextSnapshot: HEAD kept drifting, giving up after 3 attempts')
}

/**
 * @param {string} _workbench ignored (global repo); kept for call-site compat
 * @param {string} commit
 * @param {string} absFile
 * @returns {Promise<string|null>} content, or null when absent / pointer-only
 */
async function showAt(_workbench, commit, absFile) {
  if (!commit || !absFile) return null
  ensureShadowRoot()
  const key = blobKey(absFile)
  let text = null
  try {
    text = await git(['show', commit + ':' + key]) // commit hash path
  } catch { /* rolling persist stores blob ids, not commits */ }
  if (text == null) {
    // The id is a raw blob (pending stores blob ids since 2.1.22). Check the
    // type first: cat-file on a COMMIT dumps raw commit bytes and would
    // poison the diff baseline instead of failing clean.
    let type = ''
    try { type = String(await git(['cat-file', '-t', commit])).trim() } catch { return null }
    if (type !== 'blob') return null
    try {
      text = await git(['cat-file', 'blob', commit])
    } catch {
      return null
    }
  }
  // A pointer line is metadata, not file text — treat as absent so callers
  // never diff "DSSHADOW1 ptr ..." against real content.
  if (isPointerText(text)) return null
  return text
}

/**
 * @param {string} id
 * @returns {Promise<boolean>} true when <id> directly addresses a blob whose
 * body is the host's oversize/binary pointer line.
 */
async function isPointerBlob(id) {
  if (!id || !/^[0-9a-f]{40}$/.test(String(id))) return false
  let type = ''
  try { type = String(await git(['cat-file', '-t', id])).trim() } catch { return false }
  if (type !== 'blob') return false
  try { return isPointerText(await git(['cat-file', 'blob', id])) } catch { return false }
}

function readDisk(absFile) {
  try {
    return fs.readFileSync(absFile, 'utf8')
  } catch {
    return ''
  }
}

module.exports = { showAt, readDisk, blobKey, commitTextSnapshot, hashTextBlob, pinRollingBlobs, isPointerText, isPointerBlob }
