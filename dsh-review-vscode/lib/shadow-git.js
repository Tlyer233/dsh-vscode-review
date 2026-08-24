'use strict'

/**
 * Read from global shadow bare repo (matches dsh-review/shadow.js).
 * Tree path = files/<sha1(absPath)>.
 */

const { execFile, spawn } = require('node:child_process')
const crypto = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const { globalGitDir, ensureShadowRoot, shadowRoot } = require('./workbench.js')

function cleanEnv() {
  const env = { ...process.env }
  for (const k of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_TEMPLATE_DIR',
  ]) delete env[k]
  return env
}

function blobKey(absFile) {
  const abs = path.resolve(String(absFile || ''))
  const id = crypto.createHash('sha1').update(abs).digest('hex')
  return 'files/' + id
}

function git(args) {
  const gitDir = globalGitDir()
  return new Promise((resolve, reject) => {
    execFile('git', ['--git-dir', gitDir, ...args], {
      env: cleanEnv(),
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
  const id = crypto.createHash('sha1').update(path.resolve(String(absFile || ''))).digest('hex') // same id as blobKey
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
 * @description Snapshot in-memory text (ruling baseline / remaining doc). Same tree key as host.
 */
async function commitTextSnapshot(absFile, text, message) {
  return enqueueSnapshot(() => commitTextSnapshotNow(absFile, text, message))
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
  const abs = path.resolve(String(absFile || ''))
  const key = blobKey(abs)
  const indexFile = path.join(shadowRoot(), '.index-' + crypto.randomBytes(8).toString('hex'))
  const envIndex = { GIT_INDEX_FILE: indexFile }
  try {
    let parent = ''
    try {
      parent = String(await git(['rev-parse', 'HEAD'])).trim()
    } catch { /* empty repo */ }
    if (parent) {
      await gitWithIndex(['read-tree', parent], envIndex)
    }
    const blob = await gitStdin(['hash-object', '-w', '--stdin'], text)
    await gitWithIndex(['update-index', '--add', '--cacheinfo', '100644', blob, key], envIndex)
    const tree = String(await gitWithIndex(['write-tree'], envIndex)).trim()
    const commitArgs = parent
      ? ['commit-tree', tree, '-p', parent, '-m', String(message || 'ruling')]
      : ['commit-tree', tree, '-m', String(message || 'ruling')]
    const commit = String(await git(commitArgs)).trim()
    await git(['update-ref', 'HEAD', commit])
    return commit
  } finally {
    try { fs.unlinkSync(indexFile) } catch { /* noop */ }
    try { fs.unlinkSync(indexFile + '.lock') } catch { /* noop */ }
  }
}

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} extraEnv
 * @returns {Promise<string>}
 */
function gitWithIndex(args, extraEnv) {
  const gitDir = globalGitDir()
  return new Promise((resolve, reject) => {
    execFile('git', ['--git-dir', gitDir, ...args], {
      env: { ...cleanEnv(), ...extraEnv },
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

/**
 * @param {string} _workbench ignored (global repo); kept for call-site compat
 * @param {string} commit
 * @param {string} absFile
 */
async function showAt(_workbench, commit, absFile) {
  if (!commit || !absFile) return null
  ensureShadowRoot()
  const key = blobKey(absFile)
  try {
    return await git(['show', `${commit}:${key}`])
  } catch { /* rolling persist stores blob ids, not commits */ }
  try {
    return await git(['cat-file', 'blob', commit]) // blob hash in before/after
  } catch {
    return null
  }
}

function readDisk(absFile) {
  try {
    return fs.readFileSync(absFile, 'utf8')
  } catch {
    return ''
  }
}

module.exports = { showAt, readDisk, blobKey, commitTextSnapshot, hashTextBlob, pinRollingBlobs }
