'use strict'

/**
 * Fallback when editorInsets is unavailable: one 接受/撤回 pair per hunk.
 * File-level CodeLens (全部接受/全部撤回 at line 0) was removed on purpose.
 */

const vscode = require('vscode')

function createHunkCodeLenses(getSession) {
  const emitter = new vscode.EventEmitter()
  const provider = {
    onDidChangeCodeLenses: emitter.event,
    provideCodeLenses(document) {
      const session = getSession(document.uri)
      if (!session || !session.hunks || session.hunks.length === 0) return []
      if (Number(session.insetsMounted) > 0) return []
      const total = session.hunks.length
      const lenses = []
      for (let i = 0; i < total; i++) {
        const h = session.hunks[i]
        const line = Math.max(0, h.afterStart)
        const range = new vscode.Range(line, 0, line, 0)
        const uri = document.uri.toString()
        lenses.push(new vscode.CodeLens(range, {
          title: '$(check) 接受 ' + (i + 1) + '/' + total,
          command: 'dshReview.acceptHunk',
          arguments: [{ uri, hunkIndex: i }],
        }))
        lenses.push(new vscode.CodeLens(range, {
          title: '$(discard) 撤回 ' + (i + 1) + '/' + total,
          command: 'dshReview.rejectHunk',
          arguments: [{ uri, hunkIndex: i }],
        }))
      }
      return lenses
    },
  }
  return {
    provider,
    refresh() { emitter.fire() },
    dispose() { emitter.dispose() },
  }
}

module.exports = { createHunkCodeLenses }
