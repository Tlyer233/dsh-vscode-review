'use strict'

/**
 * dsh-review-vscode — shared runtime state + logging (singleton).
 *
 * Every module requires this file, so they all observe the SAME `state`
 * object and route their logs through the SAME `log` function. This replaces
 * the file-level mutable globals that used to live in extension.js:
 *
 *   insets    — InsetManager (wired lazily in activate())
 *   pending   — uri string -> PendingState
 *   addDec    — green tint decoration type
 *   delDec    — red ghost decoration type
 *   selfEdit  — guards event handlers against our own WorkspaceEdits
 *   statusBar — dsh review status bar item
 *   dshView   — sidebar WebviewView holding the dsh iframe
 *   lensEmitter / lensProvider — CodeLens plumbing (owns nothing mutable)
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vscode = require('vscode')

const state = {
  output: null,
  insets: null,
  pending: new Map(),
  addDec: null,
  delDec: null,
  selfEdit: false,
  statusBar: null,
  dshView: null,
  dshVisible: false,
  dshOwnerAt: 0,
  instanceId: '',
  lastScopeNoticeAt: 0,
}

const DEBUG_LOG = path.join(os.homedir(), '.dsh', 'review', 'extension-debug.log')

function log(...args) {
  const line = new Date().toISOString().slice(11, 19) + ' ' + args.map(String).join(' ')
  if (state.output) state.output.appendLine(line)
  try {
    fs.appendFileSync(DEBUG_LOG, line + '\n')
  } catch { /* ignore */ }
}

module.exports = { state, log }
