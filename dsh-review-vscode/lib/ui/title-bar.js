'use strict'

/**
 * Tab-bar file-level Accept / Reject icons (editor/title).
 * Shown when context key `dshReview.hasPendingFile` is true.
 */

const vscode = require('vscode')

async function setHasPendingFile(value) {
  await vscode.commands.executeCommand('setContext', 'dshReview.hasPendingFile', !!value)
}

module.exports = { setHasPendingFile }
