/**
 * @dsn/dsh-review - change-manifest store.
 *
 * This module is the durable contract between the dsh-side plugin and the
 * future IDE-side extension (Trae / VS Code). It deliberately has ZERO
 * external dependencies so it can be imported anywhere, including by the
 * IDE extension later.
 *
 * Store layout under one root directory (default $DSH_HOME/review):
 *
 *   changes/
 *     <id>.json        manifest (mutable status; single source of truth)
 *     <id>.before      "before" snapshot text (absent when there is no text)
 *     <id>.after       "after" snapshot text (absent when unavailable)
 *
 * Manifest fields:
 *   {
 *     id, at, tool, filePath, targetKey, operation,
 *     version,              // opaque post-write fs version (revert guard)
 *     beforeAvailable,      // true  => <id>.before is FULL and revert-safe
 *     beforeTruncated,      // true  => <id>.before is a capped preview (never for revert)
 *     afterAvailable,       // true  => <id>.after is full
 *     status,               // 'committed' | 'reverted'
 *     revertedAt,
 *     openedInTrae,
 *     traeResult,           // null | 'ok' | { error }
 *     stats: { additions, deletions }   // cheap line-level summary
 *   }
 *
 * All file writes are atomic (tmp + rename). Snapshot content is capped at
 * maxSnapshotBytes; an over-cap before-snapshot is stored truncated and must
 * never be used for revert (beforeAvailable is false in that case).
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Resolve the store root: explicit config, then DSH_HOME, then ~/.dsh. */
export function resolveRoot(config = {}) {
  if (config.journalDir && config.journalDir.trim() !== '') return config.journalDir
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(process.env.HOME || process.cwd(), '.dsh')
  return join(home, 'review')
}

export function changesDir(root) {
  return join(root, 'changes')
}

export function ensureDirs(root) {
  mkdirSync(changesDir(root), { recursive: true })
  return root
}

export const DEFAULT_MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024

export function newChangeId() {
  return randomUUID()
}

/** Truncate text to a byte cap, appending a marker. Returns the capped text. */
export function capText(text, maxBytes) {
  if (maxBytes <= 0) return text
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return text
  const marker = '\n…[dsh-review: snapshot truncated]\n'
  const keep = buf.subarray(0, Math.max(0, maxBytes - Buffer.byteLength(marker)))
  return keep.toString('utf8') + marker
}

export function manifestPath(root, id) {
  return join(changesDir(root), id + '.json')
}

function writeAtomic(filePath, content) {
  const tmp = filePath + '.tmp-' + process.pid + '-' + randomUUID()
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, filePath)
}

/** Build a fresh manifest entry object from a captured change. */
export function buildEntry({ id, at, tool, filePath, targetKey, operation, version, before, after, workPath, maxSnapshotBytes }) {
  const cap = maxSnapshotBytes || DEFAULT_MAX_SNAPSHOT_BYTES
  const beforeText = before === null || before === undefined ? null : String(before)
  const afterText = after === null || after === undefined ? null : String(after)
  const beforeBytes = beforeText === null ? 0 : Buffer.byteLength(beforeText)
  const afterBytes = afterText === null ? 0 : Buffer.byteLength(afterText)
  return {
    id,
    at,
    tool,
    filePath,
    targetKey: targetKey !== undefined && targetKey !== null ? String(targetKey) : null,
    workPath: workPath || null,
    operation,
    version: version !== undefined && version !== null ? String(version) : null,
    beforeAvailable: beforeText !== null && beforeBytes <= cap,
    beforeTruncated: beforeText !== null && beforeBytes > cap,
    afterAvailable: afterText !== null && afterBytes <= cap,
    status: 'committed',
    revertedAt: null,
    openedInTrae: false,
    traeResult: null,
    stats: statsOf(beforeText, afterText),
  }
}

/** Cheap multiset line diff: additions = after - before by line-count multiset. */
function statsOf(before, after) {
  if (before === null || after === null) return { additions: 0, deletions: 0 }
  const count = (text) => {
    const m = new Map()
    for (const line of text.split('\n')) m.set(line, (m.get(line) || 0) + 1)
    return m
  }
  const b = count(before)
  const a = count(after)
  let additions = 0
  let deletions = 0
  for (const [line, n] of a) {
    const nb = b.get(line) || 0
    additions += Math.max(0, n - nb)
  }
  for (const [line, n] of b) {
    const na = a.get(line) || 0
    deletions += Math.max(0, n - na)
  }
  return { additions, deletions }
}

/**
 * Persist a change: manifest json + snapshot files (all atomic).
 * The before file is written whenever text exists (it doubles as the diff
 * preview); revert-safety is governed by entry.beforeAvailable already.
 */
export function saveEntry(root, entry, { before, after, maxSnapshotBytes } = {}) {
  ensureDirs(root)
  const cap = maxSnapshotBytes || DEFAULT_MAX_SNAPSHOT_BYTES
  if (before !== undefined && before !== null) {
    writeAtomic(snapshotPath(root, entry.id, 'before'), capText(String(before), cap))
  }
  if (after !== undefined && after !== null && entry.afterAvailable) {
    writeAtomic(snapshotPath(root, entry.id, 'after'), capText(String(after), cap))
  }
  writeAtomic(manifestPath(root, entry.id), JSON.stringify(entry, null, 2) + '\n')
  return entry
}

export function snapshotPath(root, id, side) {
  return join(changesDir(root), id + '.' + side)
}

/** Atomically write a snapshot file (used for the empty left side of creates). */
export function writeSnapshot(root, id, side, text, maxSnapshotBytes) {
  ensureDirs(root)
  writeAtomic(snapshotPath(root, id, side), capText(String(text ?? ''), maxSnapshotBytes || DEFAULT_MAX_SNAPSHOT_BYTES))
}

export function readSnapshot(root, id, side) {
  const p = snapshotPath(root, id, side)
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf8')
}

export function readEntry(root, id) {
  const p = manifestPath(root, id)
  if (!existsSync(p)) return undefined
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return undefined
  }
}

/** Patch one manifest in place (atomic rewrite). */
export function updateEntry(root, id, patch) {
  const entry = readEntry(root, id)
  if (!entry) return undefined
  const next = { ...entry, ...patch }
  writeAtomic(manifestPath(root, id), JSON.stringify(next, null, 2) + '\n')
  return next
}

/** List manifests, newest first; optionally filtered by filePath (exact, targetKey, or basename). */
export function listEntries(root, { limit = 50, filePath } = {}) {
  const dir = changesDir(root)
  let entries = []
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const entry = readEntry(root, name.slice(0, -5))
      if (entry) entries.push(entry)
    }
  }
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  if (filePath) {
    const needle = String(filePath)
    entries = entries.filter((e) =>
      e.filePath === needle || e.targetKey === needle || (e.filePath && basenameOf(e.filePath) === basenameOf(needle)))
  }
  if (limit > 0 && entries.length > limit) entries = entries.slice(0, limit)
  return entries
}

function basenameOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

export { basenameOf }

/** Find the newest entry to act on: by change id, else by filePath. */
export function findActionableEntry(root, { changeId, filePath }) {
  if (changeId) return readEntry(root, changeId)
  if (!filePath) return undefined
  const list = listEntries(root, { limit: 200, filePath })
  for (const e of list) if (e.status === 'committed') return e
  return list[0]
}

/** Remove all files of one change. */
export function removeEntryFiles(root, id) {
  const dir = changesDir(root)
  for (const suffix of ['.json', '.before', '.after']) {
    const p = join(dir, id + suffix)
    if (existsSync(p)) rmSync(p)
  }
}
