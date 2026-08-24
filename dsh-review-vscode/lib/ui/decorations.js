'use strict'

/**
 * Green added-line tint, plus a one-line red deletion label when insets fail.
 * Real phantom rows come from editorInsets (see hunk-inset.js).
 */

const vscode = require('vscode')
const { removedLinesForHunk } = require('../inline-diff.js')

function createDecorations() {
  const addDec = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(46,160,67,0.15)',
    isWholeLine: true,
  })
  const delDec = vscode.window.createTextEditorDecorationType({
    isWholeLine: false,
  })

  function addRanges(session) {
    const out = []
    for (const h of session.hunks || []) {
      if (h.afterCount > 0) out.push(new vscode.Range(h.afterStart, 0, h.afterStart + h.afterCount, 0))
    }
    return out
  }

  function delTargets(session) {
    const out = []
    const lines = String(session.core.modifiedText || '').split(/\r?\n/)
    for (const h of session.hunks || []) {
      if (h.beforeCount === 0) continue
      const removed = removedLinesForHunk(session.core.originalText, h)
      if (removed.length === 0) continue
      const maxLine = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
      let anchor
      if (h.afterStart < maxLine) {
        anchor = new vscode.Range(h.afterStart, 0, h.afterStart, 0)
      } else {
        const last = Math.max(0, maxLine - 1)
        anchor = new vscode.Range(last, (lines[last] || '').length, last, (lines[last] || '').length)
      }
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
          },
        },
      })
    }
    return out
  }

  return {
    apply(editor, session, insetsMounted) {
      editor.setDecorations(addDec, addRanges(session))
      const useFallback = !(Number(insetsMounted) > 0)
      editor.setDecorations(delDec, useFallback ? delTargets(session) : [])
    },
    clear(editor) {
      editor.setDecorations(addDec, [])
      editor.setDecorations(delDec, [])
    },
    dispose() {
      addDec.dispose()
      delDec.dispose()
    },
  }
}

module.exports = { createDecorations }
