'use strict'

/**
 * dsh-review-vscode — file-level pending state + inline render pipeline.
 *
 * Owns the in-memory `pending` map, persisted ReviewCore / decisions
 * helpers, the diff-cached inline render loop, and review-mode context.
 * Depends on state/log (runtime.js), ReviewCore, journal, and
 * review-session.writeTextAtomic. It does NOT import actions.js (which
 * imports back into pending.js for refreshPending etc.).
 */

const vscode = require('vscode')
const fs = require('node:fs')
const path = require('node:path')
const { state, log } = require('./runtime.js')
const { beforePathOf, afterPathOf, markEntry, findAnyEntryForFile } = require('./journal.js')
const { removedLinesForHunk } = require('./inline-diff.js')
const { loadOps, writeTextAtomic } = require('./review-session.js')
const { ReviewCore } = require('./review-core.js')

// Injected by extension.js after lensEmitter is created (avoids a lazy
// require cycle through the vscode EventEmitter plumbing).
let lensEmitter = null
function setLensEmitter(emitter) { lensEmitter = emitter }

const pending = state.pending

let refreshTimer = null
let refreshQueue = new Map()  // uri -> true
const refreshTimers = new Map() // uri -> debounce timer for document/visible events

function pendingFor(uri) { return pending.get(uri.toString()) }

/**
 * A RESOLVED entry that still has a persistent ops stack. Batch verdicts
 * from the dsh panel mark manifests accepted/reverted; opening such a file
 * later must revive the pending state (without showing hunks) so Cmd+Z can
 * undo that file's last operation.
 */
function findRestorableEntry(storeDir, filePath) {
  const entry = findAnyEntryForFile(storeDir, filePath)
  if (!entry || entry.status === 'committed') return null
  try {
    const ops = loadOps(storeDir, entry.id)
    return Array.isArray(ops) && ops.length > 0 ? entry : null
  } catch { return null }
}

function corePathFor(state) {
  return path.join(state.storeDir, String(state.changeId) + '.core')
}

/** Persisted ReviewCore (rolling baseline + modified snapshot). */
function loadCore(storeDir, changeId) {
  try {
    const raw = fs.readFileSync(path.join(storeDir, String(changeId) + '.core'), 'utf8')
    const core = ReviewCore.fromJSON(JSON.parse(raw))
    return core && core.id === String(changeId) ? core : null
  } catch { return null }
}

function saveCore(state) {
  if (!state || !state.core) return
  try {
    writeTextAtomic(corePathFor(state), JSON.stringify(state.core.toJSON(), null, 2) + '\n')
  } catch (e) { log('saveCore failed:', e && e.message || e) }
}

function makePending(uri, changeId, storeDir, beforePath, afterPath) {
  const decisions = loadDecisions(storeDir, changeId)
  const st = {
    uri, changeId, storeDir, beforePath, afterPath,
    docText: '', hunks: [],
    decisions,
    accepted: decisions.reduce((n, d) => n + (d.type === 'accept' ? 1 : 0), 0),
    ops: loadOps(storeDir, changeId), // persistent undo stack (review-session.js)
    core: loadCore(storeDir, changeId), // rolling baseline survives reload
    lastDiffDoc: null,       // diff cache: doc text of the last computed hunks
    lastDiffOriginal: null,  // diff cache: baseline text of the last computed hunks
    lastRenderSig: null,     // inset rebuild cache: signature of the last mounted hunks
  }
  pending.set(uri.toString(), st)
  updateStatusBar()
  updateReviewModeContext()
  return st
}

/**
 * Persisted per-hunk rulings for a change: [{oa, oc, text, type}] where
 * text is the CLEAN after-block (no accept-space pollution) used as a
 * drift-immune content key, type is 'accept' | 'reject'. Survives restarts,
 * so reopening resumes exactly where the user left off (only un-ruled hunks
 * show). AC = keep AI block, RJ = revert to before.
 */
function loadDecisions(storeDir, changeId) {
  try {
    const p = path.join(storeDir, String(changeId) + '.decisions.json')
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'))
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x.oa === 'number') : []
  } catch { return [] }
}

function saveDecisions(state) {
  try {
    fs.writeFileSync(path.join(state.storeDir, state.changeId + '.decisions.json'), JSON.stringify(state.decisions, null, 2) + '\n', 'utf8')
  } catch (e) { log('saveDecisions failed:', e && e.message || e) }
}

/** True when two rulings denote the same hunk (coords + clean text). */
function igIn(a, b) {
  if (!a || !b) return false
  if (a.oa !== b.oa || a.oc !== b.oc) return false
  if (typeof a.text === 'string' && typeof b.text === 'string') return a.text === b.text
  return true
}

function cleanupPending(st) {
  if (pending.get(st.uri.toString()) === st) pending.delete(st.uri.toString())
  updateStatusBar()
}

/** Recomputed decorations for the state's current hunks. */
function addRanges(st) {
  const out = []
  for (let i = 0; i < st.hunks.length; i++) {
    const h = st.hunks[i]
    if (h.afterCount > 0) out.push(new vscode.Range(h.afterStart, 0, h.afterStart + h.afterCount, 0))
  }
  return out
}

/** Red ghost overlays for removed lines, anchored just above the hunk. */
function delTargets(st) {
  const out = []
  const lines = st.docText.split(/\r?\n/)
  for (let i = 0; i < st.hunks.length; i++) {
    const h = st.hunks[i]
    if (h.beforeCount === 0) continue
    const removed = removedLinesForHunk(st.beforeText, h)
    if (removed.length === 0) continue
    let anchor
    const maxLine = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    if (h.afterStart < maxLine) {
      anchor = new vscode.Range(h.afterStart, 0, h.afterStart, 0)
    } else {
      // pure trailing deletion: anchor at end of last line
      anchor = new vscode.Range(Math.max(0, maxLine - 1), lines[Math.max(0, maxLine - 1)].length, Math.max(0, maxLine - 1), lines[Math.max(0, maxLine - 1)].length)
    }
    // VS Code collapses multi-line before-content into one line (the
    // "red green same line" issue) — show a single clipped red label instead.
    const first = String(removed[0] || '')
    const clipped = first.length > 72 ? first.slice(0, 72) + '...' : first
    const label = '- ' + clipped + (removed.length > 1 ? ' (' + removed.length + ' lines)' : '')
    out.push({
      range: anchor,
      renderOptions: {
        before: {
          contentText: label,
          color: 'rgba(248,81,73,0.9)',
          backgroundColor: 'rgba(248,81,73,0.10)',
          textDecoration: 'none; line-through',
        },
      },
    })
  }
  return out
}

/** Debounced render path for noisy events (typing, editor switches). */
function scheduleRefresh(uri, delay = 150) {
  const key = uri.toString()
  const old = refreshTimers.get(key)
  if (old) clearTimeout(old)
  refreshTimers.set(key, setTimeout(() => {
    refreshTimers.delete(key)
    if (pendingFor(uri)) refreshPending(uri)
  }, delay))
}

function refreshPending(uri) {
  const st = pendingFor(uri)
  if (!st) return
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString())
  if (!editor) return
  const docText = editor.document.getText()
  if (!st.core) {
    const beforeText = readTextSync(st.beforePath, '')
    st.core = new ReviewCore({ id: st.changeId, original: beforeText, modified: docText })
    log('render: created core', path.basename(uri.fsPath), 'baseline', beforeText.length, 'bytes')
  } else {
    st.core.modifiedText = docText
  }
  // Reuse the last computed hunks when neither side of the diff changed.
  // This is what keeps typing/dirty-state churn from rerunning the LCS diff
  // and rebuilding every inset on each event.
  let hunks
  if (st.hunks && st.lastDiffDoc === docText && st.lastDiffOriginal === st.core.originalText) {
    hunks = st.hunks
  } else {
    hunks = st.core.hunks()
    st.lastDiffDoc = docText
    st.lastDiffOriginal = st.core.originalText
  }
  const visible = hunks
  st.docText = docText
  st.beforeText = st.core.originalText
  st.hunks = visible
  updateReviewModeContext()
  log('render:', path.basename(uri.fsPath), 'diff hunks', hunks.length, '-> visible', visible.length)
  // Revive a previously-resolved review: an undo brought hunks back, so
  // restore the manifest to committed so the file counts as unresolved again.
  if (visible.length > 0 && st.resolved) {
    st.resolved = false
    try {
      markEntry(st.storeDir, st.changeId, { status: 'committed' })
      log('revived review:', st.changeId)
    } catch (e) { log('revive markEntry failed:', e && e.message || e) }
    updateStatusBar(undefined, true)
  }
  if (visible.length === 0) {
    // Everything resolved (accepted into doc, or all rejected): finish.
    completeReview(st, docText)
    return
  }
  // Only rebuild view-zone insets when the hunk set actually changed.
  // Recreating a webview per hunk on every event was the main lag source.
  const renderSig = docText.length + ':' + st.core.originalText.length + ':' +
    visible.map((h) => h.beforeStart + ',' + h.beforeCount + ',' + h.afterStart + ',' + h.afterCount).join('|')
  const existingInsets = state.insets ? state.insets.countForEditor(editor) : 0
  let insetsMounted = existingInsets
  if (st.lastRenderSig !== renderSig || existingInsets !== visible.length) {
    try {
      insetsMounted = state.insets ? state.insets.applyToEditor(editor, st, visible.map((_, i) => i)) : 0
      st.lastRenderSig = renderSig
    } catch (e) {
      log('insets apply failed:', e && e.message || e)
      try { if (state.insets) state.insets.clearEditor(editor) } catch { /* noop */ }
    }
  }
  try {
    editor.setDecorations(state.addDec, addRanges(st))
    // When phantom rows are mounted (proposed API), deletion text lives in the
    // insets; otherwise fall back to the single-line red label decoration.
    if (insetsMounted > 0) {
      editor.setDecorations(state.delDec, [])
    } else {
      editor.setDecorations(state.delDec, delTargets(st))
    }
  } catch (e) {
    log('decorations apply failed:', e && e.message || e)
  }
  if (lensEmitter) lensEmitter.fire()
  // Insets mount transiently fails right after a document write (view-zone
  // rebuild); retry shortly afterwards so buttons never silently vanish.
  if (state.insets && state.insets.supported && insetsMounted === 0 && visible.length > 0) {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      refreshQueue.delete(uri)
      if (pendingFor(uri)) refreshPending(uri)
    }, 250)
  }
}

function completeReview(st, docText) {
  // Keep the pending state alive (with its Ops stack + ignored records) so
  // the user can still Ctrl+Z the last accept/reject and have the markers
  // come back to re-decide. We only clear the visuals, drop insets, and mark
  // the manifest resolved; the in-memory state is retained and revived on
  // the next undo (see onDidChangeTextDocument). It is released later when a
  // new change opens over the same uri.
  st.resolved = true
  clearEditorDecorations(st.uri)
  if (lensEmitter) lensEmitter.fire()
  updateStatusBar(undefined, true)
  const status = st.accepted === 0 ? 'reverted' : 'accepted'
  try {
    markEntry(st.storeDir, st.changeId, { status, resolvedAt: new Date().toISOString() })
  } catch (e) { log('markEntry failed:', e && e.message || e) }
  updateReviewModeContext()
  log('inline review done (reversible):', st.changeId, status, 'accepted', st.accepted, 'ignored', st.decisions.length)
}

/** Remove decorations AND mounted insets for an editor. */
function clearPendingUI(uri) {
  for (const ed of vscode.window.visibleTextEditors) {
    if (ed.document.uri.toString() === uri.toString()) {
      ed.setDecorations(state.addDec, [])
      ed.setDecorations(state.delDec, [])
      if (state.insets) state.insets.clearEditor(ed)
    }
  }
}

function clearEditorDecorations(uri) {
  clearPendingUI(uri)
}

async function startInlineReview(storeDir, entry) {
  const realPath = entry.filePath
  if (!fs.existsSync(realPath)) { log('skip inline (file missing):', realPath); return }
  const beforePath = beforePathOf(storeDir, entry.id)
  const uri = vscode.Uri.file(realPath)
  let editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString())
  if (!editor) {
    try {
      const doc = await vscode.workspace.openTextDocument(uri)
      editor = await vscode.window.showTextDocument(doc, { preview: false })
    } catch (e) {
      log('cannot open document:', realPath, e && e.message || e)
      return
    }
  }
  const st = makePending(uri, entry.id, storeDir, beforePath, afterPathOf(storeDir, entry.id))
  log('inline review', entry.id, path.basename(realPath), '(before snapshot:', path.basename(beforePath) + ', doc = AI output)')
  refreshPending(uri)
}

/** Move selection/reveal to the next (dir=1) or previous (dir=-1) hunk. */
function navHunk(dir) {
  const editor = vscode.window.activeTextEditor
  if (!editor) return
  const st = pendingFor(editor.document.uri)
  if (!st || !st.hunks || st.hunks.length === 0) return
  const ordered = st.hunks.map((_, i) => i)
  const anchor = editor.selection.active.line
  let target
  if (dir > 0) {
    target = ordered.find((i) => st.hunks[i].afterStart > anchor)
    if (target === undefined) target = ordered[0]
  } else {
    target = [...ordered].reverse().find((i) => st.hunks[i].afterStart < anchor)
    if (target === undefined) target = ordered[ordered.length - 1]
  }
  const h = st.hunks[target]
  const pos = new vscode.Position(Math.max(0, h.afterStart), 0)
  const range = new vscode.Range(pos, pos)
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter)
  editor.selection = new vscode.Selection(pos, pos)
}

/** Keep the review-mode context key in sync with the active editor. */
function updateReviewModeContext() {
  const editor = vscode.window.activeTextEditor
  const st = editor ? pendingFor(editor.document.uri) : null
  const active = !!(st && st.core && st.ops.length > 0)
  const hasPendingFile = !!(st && st.core && st.hunks && st.hunks.length > 0)
  log('CTX reviewMode=' + active + ' pending=' + hasPendingFile,
    'editor=' + (editor ? path.basename(editor.document.uri.fsPath) : 'none'),
    'ops=' + (st ? st.ops.length : -1))
  try {
    vscode.commands.executeCommand('setContext', 'dshReview.reviewMode', active)
    vscode.commands.executeCommand('setContext', 'dshReview.hasPendingFile', hasPendingFile)
  } catch { /* noop */ }
}

function readTextSync(p, fallback) {
  try { return fs.readFileSync(p, 'utf8') } catch { return fallback }
}

module.exports = {
  setLensEmitter,
  pendingFor,
  findRestorableEntry,
  corePathFor,
  loadCore,
  saveCore,
  makePending,
  loadDecisions,
  saveDecisions,
  igIn,
  cleanupPending,
  addRanges,
  delTargets,
  scheduleRefresh,
  refreshPending,
  completeReview,
  clearPendingUI,
  clearEditorDecorations,
  startInlineReview,
  navHunk,
  updateReviewModeContext,
  readTextSync,
}

// updateStatusBar lives in store.js (status bar + store badge). The pending
// pipeline (makePending/refreshPending/completeReview) calls it without any
// import cycle because store.js only depends on runtime.js + journal +
// review-session, never back on pending.js.
const { updateStatusBar } = require('./store.js')
