'use strict'

/**
 * dsh-review-vscode — hunk rulings (accept/reject/batch) + undo.
 *
 * Owns the per-hunk application logic, persisted decisions + ops, rolling
 * core rewinding, and the minimal document replacement helper. Depends on
 * pending.js for render/persistence plumbing (pending.js never imports back
 * into actions.js, so there is no cycle).
 */

const vscode = require('vscode')
const fs = require('node:fs')
const { state, log } = require('./runtime.js')
const { splitLines } = require('./inline-diff.js')
const { ReviewCore } = require('./review-core.js')
const { appendOp, rewriteOps, writeTextAtomic } = require('./review-session.js')
const { markEntry, beforePathOf, afterPathOf, findEntryForFile } = require('./journal.js')
const {
  pendingFor, makePending, loadCore, saveCore, loadDecisions, saveDecisions, igIn,
  refreshPending, updateReviewModeContext,
} = require('./pending.js')
const { updateStatusBar } = require('./store.js')

/** Replace the document with `text` using a minimal-range edit. */
async function applyDocText(uri, text) {
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString())
  if (!editor) return false
  const target = String(text ?? '')
  if (editor.document.getText() === target) return true
  return await applyMinimalReplace(editor, uri, editor.document.getText(), target)
}

/**
 * Pop the top persisted review operation and restore the world to its
 * pre-op state. Works for accept ops too (no document edit is needed — the
 * baseline is rewound). The reject case rewrites the document to the
 * pre-reject text with one native undo entry.
 */
async function undoReviewActionFor(st, src) {
  if (!st || !st.core) {
    log('CUSTOM UNDO no state via', src || '?')
    await vscode.commands.executeCommand('undo')
    return
  }
  if (st.ops.length === 0) {
    log('CUSTOM UNDO empty stack via', src || '?', '— native undo')
    await vscode.commands.executeCommand('undo')
    updateReviewModeContext()
    return
  }
  const op = st.ops[st.ops.length - 1]
  log('CUSTOM UNDO via', src || '?', 'op', op.n, op.type)

  // Rewind the rolling baseline. Accept ops never edited the document;
  // reject ops must also restore the pre-op document text.
  st.core.originalText = op.preBaselineText !== undefined ? op.preBaselineText : st.core.originalText
  if (op.type === 'reject') {
    const preDoc = op.preDocText !== undefined ? op.preDocText : st.core.modifiedText
    const applied = await applyDocText(st.uri, preDoc)
    if (applied) st.core.modifiedText = preDoc
  }

  st.ops.pop()
  try { rewriteOps(st.storeDir, st.changeId, st.ops) } catch (e) { log('rewriteOps failed:', e && e.message || e) }

  const recs = op.decisions || (op.decision ? [op.decision] : null)
  if (recs && recs.length > 0) {
    st.decisions = st.decisions.filter((g) => !recs.some((ig) => igIn(ig, g)))
    saveDecisions(st)
    if (op.type === 'accept') st.accepted = Math.max(0, st.accepted - recs.length)
  }

  if (st.resolved) {
    st.resolved = false
    try {
      markEntry(st.storeDir, st.changeId, { status: 'committed' })
      log('CUSTOM UNDO revived review:', st.changeId)
    } catch (e) { log('revive markEntry failed:', e && e.message || e) }
  }
  saveCore(st)
  refreshPending(st.uri)
  updateReviewModeContext()
  updateStatusBar(undefined, true)
}

async function undoLast(st, src) {
  const editor = vscode.window.activeTextEditor
  const target = st || (editor ? pendingFor(editor.document.uri) : null)
  await undoReviewActionFor(target, src || 'command')
}

async function acceptHunk(arg) {
  const st = pendingFor(vscode.Uri.parse(String(arg && arg.uri)))
  if (!st || !st.core) return
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === st.uri.toString())
  if (!editor) return
  const docText = editor.document.getText()
  st.core.modifiedText = docText
  const beforeText = st.core.originalText
  const hunks = st.core.hunks()
  if (arg.hunkIndex === undefined || arg.hunkIndex < 0 || arg.hunkIndex >= hunks.length) {
    log('ACCEPT stale index', arg.hunkIndex, 'hunks', hunks.length)
    refreshPending(st.uri)
    return
  }
  const h = hunks[arg.hunkIndex]
  log('ACCEPT', arg.hunkIndex, JSON.stringify(h))
  const preDocText = docText

  // Legacy decision record (audit + web panel compatibility). The inline UI
  // no longer filters by it: ReviewCore owns the visible hunks.
  const docLines = splitLines(docText)
  const dec = {
    oa: h.afterStart,
    oc: h.afterCount,
    text: h.afterCount > 0 && docLines.length > 0
      ? docLines.slice(Math.max(0, Math.min(h.afterStart, docLines.length - 1)), Math.min(h.afterStart + h.afterCount, docLines.length)).join('\n')
      : '',
    bt: h.beforeCount > 0 ? splitLines(beforeText).slice(h.beforeStart, h.beforeStart + h.beforeCount).join('\n') : '',
    type: 'accept',
  }

  // Copilot semantics: accept only advances the ORIGINAL baseline. The
  // document is untouched, so no trailing-space hack is needed.
  const preBaselineText = st.core.originalText
  const result = st.core.acceptHunk(arg.hunkIndex)
  if (!result) {
    log('ACCEPT core rejected index', arg.hunkIndex)
    refreshPending(st.uri)
    return
  }

  st.decisions = st.decisions.concat([dec])
  saveDecisions(st)
  st.accepted++
  const op = appendOp(st.storeDir, st.changeId, {
    type: 'accept',
    at: new Date().toISOString(),
    hunk: { beforeStart: h.beforeStart, beforeCount: h.beforeCount, afterStart: h.afterStart, afterCount: h.afterCount },
    decision: dec,
    preDocText,
    preBaselineText,
  })
  st.ops.push(op)
  saveCore(st)
  log('  -> accepted, baseline advanced to', st.core.originalText.length, 'bytes; remaining', result.remaining.length, '; op', op.n)
  refreshPending(st.uri)
  // AC makes no document edit — deliberately no save call here (saving only
  // emitted empty dirty-state events and cost a render cycle).
}

async function rejectHunk(arg) {
  const st = pendingFor(vscode.Uri.parse(String(arg && arg.uri)))
  if (!st || !st.core) return
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === st.uri.toString())
  if (!editor) return
  const docText = editor.document.getText()
  st.core.modifiedText = docText
  const beforeText = st.core.originalText
  const hunks = st.core.hunks()
  if (arg.hunkIndex === undefined || arg.hunkIndex < 0 || arg.hunkIndex >= hunks.length) {
    log('REJECT stale index', arg.hunkIndex, 'hunks', hunks.length)
    refreshPending(st.uri)
    return
  }
  const h = hunks[arg.hunkIndex]
  log('REJECT', arg.hunkIndex, JSON.stringify(h))
  const preDocText = docText

  // Legacy decision record (audit + web panel compatibility).
  const docLines = splitLines(docText)
  const dec = {
    oa: h.afterStart,
    oc: h.afterCount,
    text: h.afterCount > 0 && docLines.length > 0
      ? docLines.slice(Math.max(0, Math.min(h.afterStart, docLines.length - 1)), Math.min(h.afterStart + h.afterCount, docLines.length)).join('\n')
      : '',
    bt: h.beforeCount > 0 ? splitLines(beforeText).slice(h.beforeStart, h.beforeStart + h.beforeCount).join('\n') : '',
    type: 'reject',
  }

  // Compute the new document with ReviewCore, but only commit it to the live
  // core after applyEdit succeeds (keeps state consistent on failure).
  const nextCore = ReviewCore.fromJSON(st.core.toJSON())
  const result = nextCore.rejectHunk(arg.hunkIndex)
  if (!result) {
    log('REJECT core rejected index', arg.hunkIndex)
    refreshPending(st.uri)
    return
  }
  const targetText = nextCore.modifiedText
  const applied = await applyMinimalReplace(editor, st.uri, docText, targetText)
  log('REJECT applied=' + applied + ' lenBefore=' + docText.length + ' lenAfter=' + editor.document.getText().length)
  if (applied) {
    st.core = nextCore
    const preBaselineText = beforeText
    st.decisions = st.decisions.concat([dec])
    saveDecisions(st)
    const op = appendOp(st.storeDir, st.changeId, {
      type: 'reject',
      at: new Date().toISOString(),
      hunk: { beforeStart: h.beforeStart, beforeCount: h.beforeCount, afterStart: h.afterStart, afterCount: h.afterCount },
      decision: dec,
      preDocText,
      preBaselineText,
    })
    st.ops.push(op)
    saveCore(st)
  }
  refreshPending(st.uri)
  // Persist the buffer to disk so the ruling survives restarts.
  try { await vscode.workspace.save(st.uri) } catch (e) { log('auto-save failed:', e && e.message || e) }
}

/**
 * Accept all hunks: baseline := document (Copilot keep semantics).
 * No document edit, no trailing-space pollution.
 */
async function batchAcceptAll(st) {
  if (!st || !st.core) return
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === st.uri.toString())
  if (!editor) return
  const docText = editor.document.getText()
  st.core.modifiedText = docText
  const beforeText = st.core.originalText
  const docLines = splitLines(docText)
  const hunks = st.core.hunks()
  if (hunks.length === 0) return
  const preDocText = docText
  const igs = []
  for (const h of hunks) {
    const block = h.afterCount > 0 ? docLines.slice(h.afterStart, h.afterStart + h.afterCount).join('\n') : ''
    const blines = splitLines(beforeText)
    const bt = h.beforeCount > 0 ? blines.slice(h.beforeStart, h.beforeStart + h.beforeCount).join('\n') : ''
    igs.push({ oa: h.afterStart, oc: h.afterCount, text: block, bt, type: 'accept' })
  }
  const preBaselineText = st.core.originalText
  st.core.acceptAll()
  st.decisions = st.decisions.concat(igs)
  saveDecisions(st)
  st.accepted += igs.length
  const op = appendOp(st.storeDir, st.changeId, {
    type: 'accept',
    at: new Date().toISOString(),
    decisions: igs,
    preDocText,
    preBaselineText,
  })
  st.ops.push(op)
  saveCore(st)
  log('batchAcceptAll:', igs.length, 'hunks (baseline := document); op', op.n)
  refreshPending(st.uri)
  // Copilot's file-level Keep saves the file; keep that behavior here.
  try { await vscode.workspace.save(st.uri) } catch (e) { log('auto-save failed:', e && e.message || e) }
}

/**
 * Reject all hunks: document := baseline in one WorkspaceEdit (single
 * native undo entry).
 */
async function batchRejectAll(st) {
  if (!st || !st.core) return
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === st.uri.toString())
  if (!editor) return
  const docText = editor.document.getText()
  st.core.modifiedText = docText
  const beforeText = st.core.originalText
  const docLines = splitLines(docText)
  const hunks = st.core.hunks()
  if (hunks.length === 0) return
  const preDocText = docText
  const igs = []
  for (const h of hunks) {
    const block = h.afterCount > 0 ? docLines.slice(h.afterStart, h.afterStart + h.afterCount).join('\n') : ''
    const blines = splitLines(beforeText)
    const bt = h.beforeCount > 0 ? blines.slice(h.beforeStart, h.beforeStart + h.beforeCount).join('\n') : ''
    igs.push({ oa: h.afterStart, oc: h.afterCount, text: block, bt, type: 'reject' })
  }
  const nextCore = ReviewCore.fromJSON(st.core.toJSON())
  nextCore.rejectAll()
  const applied = await applyMinimalReplace(editor, st.uri, docText, nextCore.modifiedText)
  if (applied) {
    st.core = nextCore
    st.decisions = st.decisions.concat(igs)
    saveDecisions(st)
    const op = appendOp(st.storeDir, st.changeId, {
      type: 'reject',
      at: new Date().toISOString(),
      decisions: igs,
      preDocText,
      preBaselineText: beforeText,
    })
    st.ops.push(op)
    saveCore(st)
  }
  log('batchRejectAll:', igs.length, 'hunks (document := baseline)')
  refreshPending(st.uri)
  try { await vscode.workspace.save(st.uri) } catch (e) { log('auto-save failed:', e && e.message || e) }
}

/**
 * Minimal edit between two full texts: strip the common prefix/suffix and
 * replace only the middle. Full-document WorkspaceEdit is what made RJ feel
 * slow on large files and produced huge undo entries.
 */
function minimalEditFor(editor, oldText, newText) {
  const oldLen = String(oldText).length
  const newLen = String(newText).length
  let prefix = 0
  const maxPrefix = Math.min(oldLen, newLen)
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++
  let suffix = 0
  const maxSuffix = Math.min(oldLen - prefix, newLen - prefix)
  while (suffix < maxSuffix && oldText[oldLen - 1 - suffix] === newText[newLen - 1 - suffix]) suffix++
  if (prefix === oldLen && prefix === newLen) return null
  const start = editor.document.positionAt(prefix)
  const end = editor.document.positionAt(oldLen - suffix)
  return {
    range: new vscode.Range(start, end),
    text: newText.slice(prefix, newLen - suffix),
  }
}

/** Apply the minimal replacement as one native undo entry. */
async function applyMinimalReplace(editor, uri, oldText, newText) {
  const edit = minimalEditFor(editor, oldText, newText)
  if (!edit) return true
  const we = new vscode.WorkspaceEdit()
  we.replace(uri, edit.range, edit.text)
  state.selfEdit = true
  try {
    return await vscode.workspace.applyEdit(we, { undoStopBefore: true, undoStopAfter: true })
  } finally {
    state.selfEdit = false
  }
}

// ── Batch verdicts from the dsh panel ──────────────────────────────────────
// One file-level acceptAll/rejectAll per file, reusing the SAME persistent
// core/decisions/ops pipeline as the inline buttons. Every file keeps its own
// op, so opening that file later and pressing Cmd+Z undoes its last verdict.

function minimalEditRangeFor(doc, oldText, newText) {
  const oldLen = String(oldText).length
  const newLen = String(newText).length
  let prefix = 0
  const maxPrefix = Math.min(oldLen, newLen)
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++
  let suffix = 0
  const maxSuffix = Math.min(oldLen - prefix, newLen - prefix)
  while (suffix < maxSuffix && oldText[oldLen - 1 - suffix] === newText[newLen - 1 - suffix]) suffix++
  if (prefix === oldLen && prefix === newLen) return null
  return {
    range: new vscode.Range(doc.positionAt(prefix), doc.positionAt(oldLen - suffix)),
    text: newText.slice(prefix, newLen - suffix),
  }
}

/** Minimal WorkspaceEdit against an OPEN text document (may be a background tab). */
async function applyDocumentEdit(doc, oldText, newText) {
  const edit = minimalEditRangeFor(doc, oldText, newText)
  if (!edit) return true
  const we = new vscode.WorkspaceEdit()
  we.replace(doc.uri, edit.range, edit.text)
  state.selfEdit = true
  try {
    return await vscode.workspace.applyEdit(we, { undoStopBefore: true, undoStopAfter: true })
  } finally {
    state.selfEdit = false
  }
}

async function batchVerdictFile(storeDir, filePath, action, batchMode) {
  const file = String(filePath || '')
  const entry = findEntryForFile(storeDir, file)
  if (!entry) return { file, ok: false, hunks: 0, error: 'no committed review entry' }
  const uri = vscode.Uri.file(entry.filePath)
  let doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
  if (doc && doc.isClosed) doc = null
  let docText = ''
  if (doc) {
    docText = doc.getText()
  } else {
    try { docText = fs.readFileSync(entry.filePath, 'utf8') } catch (e) {
      return { file, ok: false, hunks: 0, error: 'read failed: ' + (e && e.message || e) }
    }
  }
  let core = loadCore(storeDir, entry.id)
  if (!core) {
    let beforeText = ''
    try { beforeText = fs.readFileSync(beforePathOf(storeDir, entry.id), 'utf8') } catch {
      if (entry.operation !== 'create') beforeText = docText
    }
    core = new ReviewCore({ id: String(entry.id), original: beforeText, modified: docText })
  } else {
    core.modifiedText = docText
  }
  const hunks = core.hunks()
  if (hunks.length === 0) return { file, ok: true, skipped: true, hunks: 0 }
  const beforeText = core.originalText
  const docLines = splitLines(docText)
  const beforeLines = splitLines(beforeText)
  const type = action === 'rejectAll' ? 'reject' : 'accept'
  const igs = hunks.map((h) => ({
    oa: h.afterStart,
    oc: h.afterCount,
    text: h.afterCount > 0 ? docLines.slice(h.afterStart, h.afterStart + h.afterCount).join('\n') : '',
    bt: h.beforeCount > 0 ? beforeLines.slice(h.beforeStart, h.beforeStart + h.beforeCount).join('\n') : '',
    type,
  }))
  const decisions = loadDecisions(storeDir, entry.id).concat(igs)
  const preDocText = docText
  const preBaselineText = beforeText
  let st = pendingFor(uri)
  if (doc && !st) {
    st = makePending(uri, entry.id, storeDir, beforePathOf(storeDir, entry.id), afterPathOf(storeDir, entry.id))
    st.core = core
  }
  if (type === 'accept') {
    core.acceptAll()
    saveCore({ storeDir, changeId: entry.id, core })
    saveDecisions({ storeDir, changeId: entry.id, decisions })
    const op = appendOp(storeDir, entry.id, {
      type: 'accept',
      at: new Date().toISOString(),
      decisions: igs,
      preDocText,
      preBaselineText,
    })
    markEntry(storeDir, entry.id, { status: 'accepted', resolvedAt: new Date().toISOString() })
    if (st) {
      st.core = core
      st.decisions = decisions
      st.accepted += igs.length
      st.ops.push(op)
    }
  } else {
    const nextCore = ReviewCore.fromJSON(core.toJSON())
    nextCore.rejectAll()
    if (doc) {
      const applied = await applyDocumentEdit(doc, docText, nextCore.modifiedText)
      if (!applied) return { file, ok: false, hunks: igs.length, error: 'applyEdit rejected' }
    } else {
      try { writeTextAtomic(entry.filePath, nextCore.modifiedText) } catch (e) {
        return { file, ok: false, hunks: igs.length, error: 'write failed: ' + (e && e.message || e) }
      }
    }
    saveCore({ storeDir, changeId: entry.id, core: nextCore })
    saveDecisions({ storeDir, changeId: entry.id, decisions })
    const op = appendOp(storeDir, entry.id, {
      type: 'reject',
      at: new Date().toISOString(),
      decisions: igs,
      preDocText,
      preBaselineText,
    })
    markEntry(storeDir, entry.id, { status: 'reverted', resolvedAt: new Date().toISOString() })
    if (st) {
      st.core = nextCore
      st.decisions = decisions
      st.ops.push(op)
    }
  }
  log('BATCH FILE', type, file, 'hunks=' + igs.length, st ? 'open' : 'headless', st ? 'ops=' + st.ops.length : '')
  // Batch mode refreshes UI once at the end of the whole run; per-file
  // refreshes were the main source of AC lag for large lists.
  if (!batchMode) {
    if (st) refreshPending(st.uri)
    updateReviewModeContext()
    updateStatusBar(undefined, true)
  }
  return { file, ok: true, hunks: igs.length, action: type }
}

async function runBatchVerdict(storeDir, filePaths, action) {
  const files = Array.isArray(filePaths) ? filePaths : []
  const results = []
  for (const f of files) {
    try {
      results.push(await batchVerdictFile(storeDir, f, action, true))
    } catch (e) {
      results.push({ file: String(f || ''), ok: false, hunks: 0, error: e && e.message || String(e) })
    }
    // Yield the extension-host event loop between files so a large batch
    // never freezes the whole VS Code window.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const ok = results.filter((r) => r.ok).length
  log('BATCH VERDICT', action, ok + '/' + results.length, 'file(s)')
  try {
    updateReviewModeContext()
    updateStatusBar(undefined, true)
  } catch { /* noop */ }
  return results
}

module.exports = {
  applyDocText,
  undoReviewActionFor,
  undoLast,
  acceptHunk,
  rejectHunk,
  batchAcceptAll,
  batchRejectAll,
  minimalEditFor,
  applyMinimalReplace,
  runBatchVerdict,
}
