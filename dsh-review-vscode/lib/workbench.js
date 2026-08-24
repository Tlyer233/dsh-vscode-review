'use strict'

/**
 * Shared storage roots — mirrors dsh-review/workbench.js.
 *
 *   $DSH_HOME/review/shadow/repo.git              — global shadow git (bare)
 *   $DSH_HOME/review/shadow/pending/<wbHash>.json — per-workbench pending
 *
 * Ownership: entry.workbench (= dsh session.header.cwd). filePath may be outside.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function dshHome() {
  const env = process.env.DSH_HOME && String(process.env.DSH_HOME).trim()
  return env || path.join(os.homedir(), '.dsh')
}

/** ~/.dsh/review/shadow */
function shadowRoot() {
  return path.join(dshHome(), 'review', 'shadow')
}

/** ~/.dsh/review/shadow/repo.git */
function globalGitDir() {
  return path.join(shadowRoot(), 'repo.git')
}

/** ~/.dsh/review/shadow/pending */
function pendingDir() {
  return path.join(shadowRoot(), 'pending')
}

/**
 * @param {string} workbench
 */
function pendingFileFor(workbench) {
  return path.join(pendingDir(), workbenchRepoId(workbench) + '.json')
}

function canonicalWorkbench(raw) {
  const p = path.resolve(String(raw || ''))
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

function workbenchRepoId(workbench) {
  return crypto.createHash('sha1').update(canonicalWorkbench(workbench)).digest('hex').slice(0, 16)
}

function ensureShadowRoot() {
  const root = shadowRoot()
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(pendingDir(), { recursive: true })
  return root
}

module.exports = {
  dshHome,
  shadowRoot,
  globalGitDir,
  pendingDir,
  pendingFileFor,
  canonicalWorkbench,
  workbenchRepoId,
  ensureShadowRoot,
}
