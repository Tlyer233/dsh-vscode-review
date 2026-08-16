'use strict'

/**
 * dsh-review-vscode — journal (change-manifest) reader.
 *
 * Pure logic, no `vscode` import: unit-testable with plain node.
 * Contract with the dsh-review dsh plugin (lib/review-journal.js):
 *   storeDir/<id>.json   — manifest (mutable status field)
 *   storeDir/<id>.before — pre-change full text (may be empty for creates)
 *   storeDir/<id>.after  — post-change full text
 * Manifest fields used: id, tool, filePath, operation, status,
 * beforeAvailable, beforeTruncated, afterAvailable, at, revertedAt.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Where the dsh plugin keeps changes. Honors $DSH_HOME like the plugin. */
function defaultStoreDir() {
  // Must match the dsh plugin (dsh-review/lib/review-journal.js resolveRoot):
  // DSH_HOME set -> <DSH_HOME>/review/changes; otherwise ~/.dsh/review/changes.
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : os.homedir()
  const base = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? home
    : path.join(home, '.dsh')
  return path.join(base, 'review', 'changes')
}

/** Expand a leading tilde and normalize the path. */
function resolveStoreDir(configured) {
  if (configured && configured.trim() !== '') {
    const t = configured.trim()
    if (t === '~' || t.startsWith('~/')) return path.join(os.homedir(), t.slice(1))
    return path.resolve(t)
  }
  return defaultStoreDir()
}

function isAuxName(name) {
  return name.endsWith('.decisions.json') || name.endsWith('.ops.json')
}

/** Read + parse one manifest; null on any failure or aux review file. */
function readManifest(dir, id) {
  const sid = String(id)
  if (!sid || sid.endsWith('.decisions') || sid.endsWith('.ops')) return null
  try {
    const text = fs.readFileSync(path.join(dir, sid + '.json'), 'utf8')
    const entry = JSON.parse(text)
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    if (!entry.id || entry.id !== sid) return null
    if (!entry.filePath || !entry.operation) return null
    return entry
  } catch {
    return null
  }
}

/** List manifests, newest first; only valid parseable entries. */
function listEntries(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !isAuxName(n))
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    const entry = readManifest(dir, n.slice(0, -5))
    if (entry) out.push(entry)
  }
  out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
  return out
}

/** Normalize a user-supplied file path (strip scheme, absolutize). */
function normalizeFilePath(p) {
  if (typeof p !== 'string' || p === '') return ''
  let s = p.replace(/^key:/, '')
  if (s.startsWith('file://')) {
    try { s = decodeURIComponent(new URL(s).pathname) } catch { s = s.replace(/^file:/, '') }
  }
  return path.resolve(s)
}

/**
 * Match an entry to a file. Exact absolute-path match always wins. The
 * basename fallback is allowed ONLY when the caller passed a bare filename
 * (no directory part); with an absolute path it would let `a/package.json`
 * steal the entry of `b/package.json`.
 */
function entryMatches(entry, filePathAbs, bareNameFallback = false) {
  if (!entry || typeof entry.filePath !== 'string') return false
  const ep = path.resolve(entry.filePath)
  if (ep === filePathAbs) return true
  if (!bareNameFallback) return false
  const base = path.basename(filePathAbs)
  return base !== '' && (ep === base || ep.endsWith('/' + base))
}

/**
 * Find the newest committed entry for a file.
 * @param dir store dir; filePath absolute or basename; changeId optional pin
 */
function findEntryForFile(dir, filePath, changeId) {
  const abs = normalizeFilePath(filePath)
  if (!abs) return null
  if (changeId) {
    const e = readManifest(dir, changeId)
    return e && (e.status === 'committed' || e.status === 'reverted') ? e : null
  }
  const bareName = typeof filePath === 'string' && filePath.trim() !== '' &&
    !filePath.includes('/') && !filePath.includes('\\')
  // Only consider the NEWEST entry for this file. If it's already resolved
  // (accepted/reverted), do NOT fall through to older entries - those are
  // stale changes that would show a wrong diff against the current file.
  const newest = listEntries(dir).find((e) => entryMatches(e, abs, bareName))
  return newest && newest.status === 'committed' ? newest : null
}

/**
 * Newest entry for a file regardless of status. Used only to revive a
 * RESOLVED review whose persistent ops stack still has undoable operations
 * (batch verdicts from the dsh panel, for example).
 */
function findAnyEntryForFile(dir, filePath) {
  const abs = normalizeFilePath(filePath)
  if (!abs) return null
  const bareName = typeof filePath === 'string' && filePath.trim() !== '' &&
    !filePath.includes('/') && !filePath.includes('\\')
  return listEntries(dir).find((e) => entryMatches(e, abs, bareName)) || null
}

/** Absolute path of the before snapshot (may not exist). */
function beforePathOf(dir, id) {
  return path.join(dir, String(id) + '.before')
}

/** Absolute path of the after snapshot (may not exist). */
function afterPathOf(dir, id) {
  return path.join(dir, String(id) + '.after')
}

/** Human title for a diff editor tab. */
function titleFor(entry) {
  const short = String(entry.id || '').slice(0, 8)
  const base = path.basename(entry.filePath || entry.id || 'file')
  const op = entry.operation === 'create' ? 'create' : entry.tool || 'change'
  return 'dsh review ' + op + ' · ' + base + ' · ' + short
}

/** Persist a status update back into the shared manifest. */
function markEntry(dir, id, patch) {
  const entry = readManifest(dir, id)
  if (!entry) return null
  const updated = Object.assign({}, entry, patch)
  fs.writeFileSync(path.join(dir, String(id) + '.json'), JSON.stringify(updated, null, 2) + '\n', 'utf8')
  return updated
}

module.exports = {
  defaultStoreDir, resolveStoreDir, readManifest, listEntries,
  normalizeFilePath, entryMatches, findEntryForFile, findAnyEntryForFile,
  beforePathOf, afterPathOf, titleFor, markEntry,
}

