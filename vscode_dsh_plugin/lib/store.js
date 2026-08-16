'use strict'

/**
 * dsh-review-vscode — store scan + status bar badge.
 *
 * `unresolvedFromStore` walks every manifest to compute the set of files
 * whose review is still unresolved; it is cached (refresh at most every
 * second unless forced). `updateStatusBar` turns that count into the
 * "dsh review: N pending" status bar item.
 */

const vscode = require('vscode')
const fs = require('node:fs')
const path = require('node:path')
const { state, log } = require('./runtime.js')
const { resolveStoreDir, listEntries } = require('./journal.js')
const { findReviewSession } = require('./review-session.js')

// Store-scan cache: unresolvedFromStore reads every manifest (300+ files);
// refresh it at most every second, force it after a review state change.
let unresolvedCache = { dir: '', at: 0, value: [] }

/**
 * Unresolved review sessions from the store, one per file (Copilot/Trae
 * show file-level review groups, not one badge per write/edit entry).
 */
function unresolvedFromStore(storeDir, force = false) {
  if (!storeDir) return []
  const now = Date.now()
  if (!force && unresolvedCache.dir === storeDir && now - unresolvedCache.at < 1000) {
    return unresolvedCache.value
  }
  const seen = new Set()
  const out = []
  const entries = listEntries(storeDir)
  for (const e of entries) {
    if (!e || e.status !== 'committed' || !e.filePath) continue
    if (!fs.existsSync(e.filePath)) continue
    const key = path.resolve(e.filePath)
    if (seen.has(key)) continue
    const session = findReviewSession(storeDir, e.filePath, entries)
    if (!session) continue
    if (!fs.existsSync(session.baselinePath) && session.rootEntry.operation !== 'create') continue
    seen.add(key)
    out.push({ entry: session.rootEntry, session })
  }
  unresolvedCache = { dir: storeDir, at: now, value: out }
  return out
}

function updateStatusBar(storeDir, force = false) {
  if (!state.statusBar) return
  // Badge = unresolved changes in the store (survives restarts), which also
  // reflects in-memory completion once entries are marked reverted/accepted.
  const unresolved = resolveStoreDir(vscode.workspace.getConfiguration('dshReview').get('storeDir') || '')
  const n = unresolvedFromStore(unresolved, force).length
  if (n > 0) {
    state.statusBar.text = '$(git-compare) dsh review: ' + n + ' pending'
    state.statusBar.tooltip = 'Open the dsh review pending list'
    state.statusBar.show()
  } else {
    state.statusBar.hide()
  }
}

module.exports = { unresolvedFromStore, updateStatusBar }
