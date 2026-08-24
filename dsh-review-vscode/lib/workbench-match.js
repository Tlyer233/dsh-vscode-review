'use strict'

/**
 * Workbench ownership (STRICT).
 *
 * Model:
 *   VS Code window folders  ↔  dsh session workbench (session.header.cwd)
 *
 * Rules:
 * 1. Tag every pending entry with the dsh session workbench that did the edit
 *    (`entry.workbench`). Never infer ownership from `entry.filePath`.
 * 2. This VS Code window may startReview / show dock rows only when
 *    `entry.workbench` equals one of its workspace folders (realpath OR raw).
 * 3. The edited file MAY lie outside the folder; that is allowed.
 * 4. No parent/child fuzzy match. Exact path equality after normalize only.
 */

const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')

function normalizePath(p) {
  const s = String(p || '').replace(/\/+$/, '')
  if (!s) return ''
  try {
    return fs.realpathSync.native(s).replace(/\/+$/, '')
  } catch {
    return path.resolve(s).replace(/\/+$/, '')
  }
}

/** True iff a and b name the same directory (realpath preferred, else resolve). */
function sameWorkbench(a, b) {
  const x = normalizePath(a)
  const y = normalizePath(b)
  if (!x || !y) return false
  if (x === y) return true
  // Also compare raw stripped forms in case one side failed realpath.
  const rx = String(a || '').replace(/\/+$/, '')
  const ry = String(b || '').replace(/\/+$/, '')
  return !!rx && !!ry && rx === ry
}

/** Workspace folder paths for THIS VS Code window (raw + realpath). */
function thisWindowWorkbenchPaths() {
  const folders = vscode.workspace.workspaceFolders || []
  const out = []
  for (const folder of folders) {
    const raw = folder.uri.fsPath
    out.push(raw)
    try {
      out.push(fs.realpathSync.native(raw))
    } catch { /* raw only */ }
  }
  return out
}

/**
 * Does THIS window own the given dsh workbench?
 * @param {string|null|undefined} workbench - entry.workbench / session cwd
 */
function windowOwnsWorkbench(workbench) {
  if (!workbench) return false
  const paths = thisWindowWorkbenchPaths()
  for (const p of paths) {
    if (sameWorkbench(workbench, p)) return true
  }
  return false
}

/**
 * Should this pending entry surface in THIS window?
 * Gate on entry.workbench only — never on filePath location.
 */
function entryOwnedByThisWindow(entry) {
  if (!entry || !entry.workbench) return false
  return windowOwnsWorkbench(entry.workbench)
}

module.exports = {
  normalizePath,
  sameWorkbench,
  thisWindowWorkbenchPaths,
  windowOwnsWorkbench,
  entryOwnedByThisWindow,
}
