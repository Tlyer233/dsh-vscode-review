'use strict'

/**
 * dsh-review-vscode — file-level review session (Copilot-style rolling baseline).
 *
 * A "session" for one file starts at the OLDEST committed journal entry for
 * that file (the original pre-AI state). Its rolling baseline lives at
 * `<sessionId>.baseline`:
 *
 *   - on startup it falls back to `<sessionId>.before`
 *   - accepting a hunk merges the accepted lines INTO the baseline
 *   - rejecting a hunk edits the document back to the baseline block
 *
 * This makes the editor show diff(baseline, document) at all times, exactly
 * like Copilot/Trae chat-editing: accepted hunks disappear naturally and are
 * never re-reviewed after later manual edits. Decisions + operation records
 * are persisted for undo/history and for the legacy web panel fallback.
 *
 * Pure Node CJS; no `vscode` import.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { diffHunks, splitLines, acceptHunk, rejectHunk } = require('./inline-diff')
const journal = require('./journal')

const OPS_VERSION = 1
const INLINE_TEXT_LIMIT = 256 * 1024

function readText(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8') } catch { return fallback }
}

function writeTextAtomic(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2)
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, p)
}

function sha1(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex')
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex')
}

/** Committed entries for one absolute file path, oldest first. */
function committedEntriesForFile(dir, filePath, preloadedEntries) {
  const abs = journal.normalizeFilePath(filePath)
  const all = Array.isArray(preloadedEntries) ? preloadedEntries : journal.listEntries(dir)
  return all
    .filter((e) => e && e.status === 'committed' && journal.entryMatches(e, abs))
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
}

function baselinePathFor(dir, id) {
  return path.join(dir, String(id) + '.baseline')
}

/**
 * Resolve the review session for a file.
 * @returns null or { sessionId, rootEntry, baselinePath, entries }
 */
function findReviewSession(dir, filePath, preloadedEntries) {
  const entries = committedEntriesForFile(dir, filePath, preloadedEntries)
  if (entries.length === 0) return null

  let rootEntry = null
  let baselinePath = null
  for (const e of entries) {
    const before = journal.beforePathOf(dir, e.id)
    if (fs.existsSync(before)) {
      rootEntry = e
      baselinePath = before
      break
    }
    if (e.operation === 'create') {
      rootEntry = e
      baselinePath = baselinePathFor(dir, e.id)
      if (!fs.existsSync(baselinePath)) writeTextAtomic(baselinePath, '')
      break
    }
  }
  if (!rootEntry) return null

  const rolling = baselinePathFor(dir, rootEntry.id)
  if (fs.existsSync(rolling)) baselinePath = rolling
  return { sessionId: rootEntry.id, rootEntry, baselinePath, entries }
}

function readBaseline(session) {
  if (!session || !session.baselinePath) return ''
  return readText(session.baselinePath, '')
}

function writeBaseline(dir, sessionId, text) {
  writeTextAtomic(baselinePathFor(dir, sessionId), String(text ?? ''))
}

/** Compute the visible review hunks. Rolling baseline: no decision filtering needed. */
function visibleHunks(baselineText, docText) {
  return diffHunks(baselineText, docText)
}

function decisionsPath(dir, sessionId) {
  return path.join(dir, String(sessionId) + '.decisions.json')
}

function loadDecisions(dir, sessionId) {
  try {
    const arr = JSON.parse(fs.readFileSync(decisionsPath(dir, sessionId), 'utf8'))
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object') : []
  } catch { return [] }
}

function saveDecisions(dir, sessionId, decisions) {
  writeTextAtomic(decisionsPath(dir, sessionId), JSON.stringify(decisions, null, 2) + '\n')
}

/** Stable content signature for one hunk (used for undo/decision identity). */
function hunkSig(baselineText, docText, h) {
  const b = splitLines(baselineText)
  const d = splitLines(docText)
  const bt = h.beforeStart >= 0 && h.beforeCount > 0
    ? b.slice(h.beforeStart, h.beforeStart + h.beforeCount).join('\n')
    : ''
  const text = h.afterCount > 0
    ? d.slice(h.afterStart, h.afterStart + h.afterCount).join('\n')
    : ''
  return sha1(JSON.stringify([h.beforeStart, h.beforeCount, h.afterStart, h.afterCount, bt, text])).slice(0, 16)
}

function makeDecision(baselineText, docText, h, type) {
  const b = splitLines(baselineText)
  const d = splitLines(docText)
  const beforeBlock = h.beforeStart >= 0 && h.beforeCount > 0
    ? b.slice(h.beforeStart, h.beforeStart + h.beforeCount).join('\n')
    : ''
  const afterBlock = h.afterCount > 0
    ? d.slice(h.afterStart, h.afterStart + h.afterCount).join('\n')
    : ''
  return {
    sig: hunkSig(baselineText, docText, h),
    oa: h.afterStart,
    oc: h.afterCount,
    ob: h.beforeStart,
    od: h.beforeCount,
    text: afterBlock,
    bt: beforeBlock,
    type,
    at: new Date().toISOString(),
  }
}

function decisionMatches(a, b) {
  if (!a || !b) return false
  if (a.sig && b.sig) return a.sig === b.sig
  return a.oa === b.oa && a.oc === b.oc && a.ob === b.ob && a.od === b.od &&
    (a.text || '') === (b.text || '') && (a.bt || '') === (b.bt || '')
}

function removeDecisions(decisions, records) {
  return decisions.filter((d) => !records.some((r) => decisionMatches(d, r)))
}

// ── operation stack persistence ─────────────────────────────────────────────
// accept/reject records survive a reload. Small texts are embedded in the ops
// JSON; larger snapshots are stored in sidecar files. preDocText is the
// document before the operation (used to detect editor Ctrl+Z / restore);
// preBaselineText is the rolling baseline before an accept (used to undo an
// accept, which performs no document edit and therefore cannot rely on the
// editor's built-in undo stack).

function opsPath(dir, sessionId) {
  return path.join(dir, String(sessionId) + '.ops.json')
}

function sidecarPath(dir, sessionId, n, kind) {
  return path.join(dir, String(sessionId) + '.ops-' + n + '.' + kind)
}

function storeTextRecord(text, record, hashKey, inlineKey) {
  const s = String(text ?? '')
  record[hashKey] = sha256(s)
  if (s.length <= INLINE_TEXT_LIMIT) record[inlineKey] = s
  return s
}

function loadOpRecords(recPath) {
  try {
    const arr = JSON.parse(fs.readFileSync(recPath, 'utf8'))
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object') : []
  } catch { return [] }
}

function writeOpFiles(dir, sessionId, n, op) {
  const record = {
    v: OPS_VERSION,
    n,
    type: op.type,
    at: op.at || new Date().toISOString(),
    hunk: op.hunk || null,
    decision: op.decision || null,
    decisions: op.decisions && op.decisions.length > 0
      ? op.decisions
      : (op.decision ? [op.decision] : null),
  }
  const preDoc = storeTextRecord(op.preDocText, record, 'preDocHash', 'preDocText')
  const preBase = storeTextRecord(op.preBaselineText, record, 'preBaseHash', 'preBaselineText')
  const recPath = opsPath(dir, sessionId)
  const recs = loadOpRecords(recPath).filter((r) => r.n !== n).concat([record]).sort((a, b) => a.n - b.n)
  if (Buffer.byteLength(preDoc, 'utf8') > INLINE_TEXT_LIMIT) {
    writeTextAtomic(sidecarPath(dir, sessionId, n, 'doc'), preDoc)
  }
  if (Buffer.byteLength(preBase, 'utf8') > INLINE_TEXT_LIMIT) {
    writeTextAtomic(sidecarPath(dir, sessionId, n, 'base'), preBase)
  }
  writeTextAtomic(recPath, JSON.stringify(recs, null, 2) + '\n')
}

function loadOps(dir, sessionId) {
  const recPath = opsPath(dir, sessionId)
  const recs = loadOpRecords(recPath).sort((a, b) => (Number(a.n) || 0) - (Number(b.n) || 0))
  const ops = []
  for (const r of recs) {
    const preDocText = typeof r.preDocText === 'string'
      ? r.preDocText
      : readText(sidecarPath(dir, sessionId, r.n, 'doc'), '')
    const preBaselineText = typeof r.preBaselineText === 'string'
      ? r.preBaselineText
      : readText(sidecarPath(dir, sessionId, r.n, 'base'), '')
    ops.push({
      n: Number(r.n) || 0,
      type: r.type,
      at: r.at,
      hunk: r.hunk || null,
      decision: r.decision || null,
      decisions: r.decisions || (r.decision ? [r.decision] : null),
      preDocText,
      preBaselineText,
    })
  }
  return ops
}

function appendOp(dir, sessionId, op) {
  const recs = loadOpRecords(opsPath(dir, sessionId))
  const n = recs.length === 0 ? 0 : Math.max(...recs.map((r) => Number(r.n) || 0)) + 1
  op.n = n
  writeOpFiles(dir, sessionId, n, op)
  return op
}

function rewriteOps(dir, sessionId, ops) {
  const recPath = opsPath(dir, sessionId)
  const recs = loadOpRecords(recPath)
  for (const r of recs) {
    for (const kind of ['doc', 'base']) {
      try { fs.rmSync(sidecarPath(dir, sessionId, r.n, kind), { force: true }) } catch { /* noop */ }
    }
  }
  // Start from an empty record set so stale ops are actually removed.
  try { fs.rmSync(recPath, { force: true }) } catch { /* noop */ }
  for (const op of ops) writeOpFiles(dir, sessionId, op.n, op)
  if (ops.length === 0) {
    try { fs.rmSync(recPath, { force: true }) } catch { /* noop */ }
  }
}

/** Mark every still-committed journal entry for a file resolved. */
function markFileEntriesResolved(dir, filePath, status, at) {
  const changed = []
  for (const e of committedEntriesForFile(dir, filePath)) {
    journal.markEntry(dir, e.id, { status, resolvedAt: at || new Date().toISOString() })
    changed.push(e.id)
  }
  return changed
}

module.exports = {
  committedEntriesForFile,
  baselinePathFor,
  findReviewSession,
  readBaseline,
  writeBaseline,
  visibleHunks,
  decisionsPath,
  loadDecisions,
  saveDecisions,
  makeDecision,
  decisionMatches,
  removeDecisions,
  hunkSig,
  opsPath,
  loadOps,
  appendOp,
  rewriteOps,
  markFileEntriesResolved,
  readText,
  writeTextAtomic,
  sha256,
}
