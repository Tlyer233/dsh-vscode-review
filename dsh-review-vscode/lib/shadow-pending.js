'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  ensureShadowRoot,
  pendingFileFor,
  pendingDir,
  workbenchRepoId,
  canonicalWorkbench,
} = require('./workbench.js')
const { thisWindowWorkbenchPaths } = require('./workbench-match.js')
const { acquireLock, releaseLock } = require('./lockfile.js')

/**
 * Per-pending-file lock (shared with the dsh host): both processes do
 * read-modify-write on this JSON; lock-free, the later writer silently
 * reverts the earlier one's entries.
 * @param {string} workbench
 * @param {() => any} fn
 */
function withPendingLock(workbench, fn) {
  const id = pendingFileFor(workbench).split(/[\\/]/).pop().replace(/\.json$/, '')
  const lock = path.join(pendingDir(), '.' + id + '.lock')
  let acquired = false
  try {
    acquireLock(lock, { timeoutMs: 3000 })
    acquired = true
    return fn()
  } finally {
    if (acquired) releaseLock(lock)
  }
}

/**
 * @param {string} workbench
 * @returns {any[]}
 */
function readPending(workbench) {
  ensureShadowRoot()
  if (!workbench) return []
  const p = pendingFileFor(workbench)
  if (!fs.existsSync(p)) return []
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

/**
 * Unique workbench paths for this VS Code window (prefer realpath).
 * @returns {string[]}
 */
function ownedWorkbenchRoots() {
  const raw = thisWindowWorkbenchPaths()
  const seen = new Set()
  const out = []
  for (const p of raw) {
    const c = canonicalWorkbench(p)
    if (!c || seen.has(c)) continue
    seen.add(c)
    out.push(c)
  }
  return out
}

/** Merge pending entries for all folders in this window. */
function readOwnedPending() {
  const list = []
  for (const wb of ownedWorkbenchRoots()) {
    for (const e of readPending(wb)) {
      if (e) list.push(e)
    }
  }
  return list
}

/**
 * @param {string} workbench
 * @param {any[]} entries
 */
function writePendingAtomic(workbench, entries) {
  ensureShadowRoot()
  if (!workbench) return
  const p = pendingFileFor(workbench)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = p + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, p)
}

/**
 * @param {string} filePath
 * @param {{ before: string, after: string }} rolling
 * @param {string} [workbench]
 */
function upsertRolling(filePath, rolling, workbench) {
  const wbs = workbench ? [canonicalWorkbench(workbench)] : ownedWorkbenchRoots()
  for (const wb of wbs) {
    const hit = withPendingLock(wb, () => {
      const list = readPending(wb)
      const idx = list.findIndex((e) => e && e.filePath === filePath)
      if (idx < 0) return false
      const prev = list[idx]
      const next = {
        ...prev,
        before: rolling.before,
        after: rolling.after,
        updatedAt: Date.now(),
      }
      delete next.baselineText
      delete next.documentText
      list[idx] = next
      writePendingAtomic(wb, list)
      return true
    })
    if (hit) return true
  }
  return false
}

/**
 * @param {string} filePath
 * @param {string} [workbench]
 */
function removeEntry(filePath, workbench) {
  const wbs = workbench ? [canonicalWorkbench(workbench)] : ownedWorkbenchRoots()
  for (const wb of wbs) {
    const hit = withPendingLock(wb, () => {
      const list = readPending(wb)
      const next = list.filter((e) => e && e.filePath !== filePath)
      if (next.length === list.length) return false
      writePendingAtomic(wb, next)
      return true
    })
    if (hit) return true
  }
  return false
}

module.exports = {
  readPending,
  readOwnedPending,
  writePendingAtomic,
  upsertRolling,
  removeEntry,
  ownedWorkbenchRoots,
  pendingDir,
  workbenchRepoId,
}
