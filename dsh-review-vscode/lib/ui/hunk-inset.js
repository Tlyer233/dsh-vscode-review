'use strict'

/**
 * Per-hunk inset: red phantom (deleted) lines + 接受 i/n / 撤回 i/n.
 * Disable this module in the host if you do not want per-hunk buttons.
 *
 * Insets are reused across rulings: createWebviewTextEditorInset is a full
 * webview, so dispose+recreate of every hunk is what made accept/reject jank.
 * line is readonly on the API — a hunk whose editor line moved (reject below
 * the edit) cannot be moved and must be recreated; accept typically reuses all
 * remaining webviews and only postMessage-updates 接受 i/n.
 */

const vscode = require('vscode')
const { removedLinesForHunk } = require('../inline-diff.js')

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderHunkHtml(removedLines, index, total) {
  const removedHtml = removedLines.length > 0
    ? '<pre class="removed">' + removedLines.map(function (l) { return escapeHtml(l) }).join('\n') + '</pre>'
    : ''
  return '' +
    '<!DOCTYPE html>' +
    '<html><head><meta charset="UTF-8"><style>' +
    '  * { margin: 0; padding: 0; box-sizing: border-box; }' +
    '  html, body { height: 100%; width: 100%; overflow: hidden; background: transparent; }' +
    '  body {' +
    '    font-family: var(--vscode-editor-font-family);' +
    '    font-size: var(--vscode-editor-font-size);' +
    '    font-weight: var(--vscode-editor-font-weight);' +
    '    color: var(--vscode-editor-foreground);' +
    '  }' +
    '  .removed {' +
    '    margin: 0; padding: 1px 0 0 0;' +
    '    background-color: rgba(248, 81, 73, 0.16);' +
    '    color: rgb(248, 81, 73);' +
    '    line-height: 1.4;' +
    '    white-space: pre;' +
    '    overflow: hidden;' +
    '  }' +
    '  .actions {' +
    '    display: flex; align-items: center; gap: 16px;' +
    '    padding: 1px 8px; line-height: 1.4;' +
    '    font-family: var(--vscode-font-family);' +
    '    font-size: 12px;' +
    '    color: var(--vscode-descriptionForeground, var(--vscode-foreground));' +
    '    background-color: rgba(128, 128, 128, 0.06);' +
    '  }' +
    '  .actions button { background: transparent; border: none; cursor: pointer; padding: 0; font: inherit; color: inherit; }' +
    '  .actions .accept { color: var(--vscode-charts-green, #2ea043); font-weight: 600; }' +
    '  .actions .revert { color: var(--vscode-errorForeground, #f14c4c); font-weight: 600; }' +
    '  .actions button:hover { text-decoration: underline; }' +
    '</style></head><body>' +
    removedHtml +
    '<div class="actions">' +
    '  <button type="button" class="accept" id="accept">&#10003; 接受 ' + index + '/' + total + '</button>' +
    '  <button type="button" class="revert" id="revert">&#8634; 撤回 ' + index + '/' + total + '</button>' +
    '</div>' +
    '<script>' +
    '  (function () {' +
    '    const vscode = acquireVsCodeApi();' +
    '    const a = document.getElementById("accept");' +
    '    const r = document.getElementById("revert");' +
    '    if (a) a.addEventListener("click", function () { vscode.postMessage({ type: "accept" }); });' +
    '    if (r) r.addEventListener("click", function () { vscode.postMessage({ type: "revert" }); });' +
    '    window.addEventListener("message", function (e) {' +
    '      const d = e.data;' +
    '      if (!d || d.type !== "meta") return;' +
    '      if (a) a.textContent = "\\u2713 接受 " + d.index + "/" + d.total;' +
    '      if (r) r.textContent = "\\u21BA 撤回 " + d.index + "/" + d.total;' +
    '    });' +
    '    window.addEventListener("wheel", function (e) {' +
    '      e.preventDefault();' +
    '      vscode.postMessage({ type: "wheel", deltaY: e.deltaY, deltaMode: e.deltaMode });' +
    '    }, { passive: false });' +
    '  })();' +
    '</script>' +
    '</body></html>'
}

/**
 * @param {string[]} removedLines
 * @param {number} line
 * @param {number} height
 * @returns {string}
 * @description Identity of one ghost block. Same key → reuse the webview.
 */
function ghostKey(removedLines, line, height) {
  return String(line) + '\0' + String(height) + '\0' + removedLines.join('\n')
}

/**
 * @param {vscode.TextEditor} editor
 * @returns {number}
 * @description Pixel line height from editor settings (0 = auto, <8 = multiplier).
 */
function estimateLineHeight(editor) {
  const cfg = vscode.workspace.getConfiguration('editor', editor.document)
  const fontSize = Number(cfg.get('fontSize')) || 14
  const raw = Number(cfg.get('lineHeight')) || 0
  if (raw === 0) return Math.round(fontSize * 1.5)
  if (raw < 8) return Math.max(1, Math.round(fontSize * raw))
  return raw
}

/** leftover pixel deltas so trackpad wheel maps to whole lines */
const wheelRemain = new Map()

/**
 * @param {vscode.Uri} uri
 * @param {{ deltaY?: number, deltaMode?: number }} msg
 * @description Forward inset wheel to the owning editor (webview eats the event).
 */
function scrollOwningEditor(uri, msg) {
  const uriStr = uri.toString()
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uriStr)
  if (!editor) return
  const deltaY = Number(msg && msg.deltaY) || 0
  const deltaMode = Number(msg && msg.deltaMode) || 0
  if (deltaY === 0) return
  let lines = 0
  if (deltaMode === 1) {
    lines = deltaY > 0 ? Math.ceil(deltaY) : Math.floor(deltaY)
  } else if (deltaMode === 2) {
    const vis = editor.visibleRanges[0]
    const page = vis ? Math.max(1, vis.end.line - vis.start.line) : 20
    lines = deltaY > 0 ? page : -page
  } else {
    const lh = estimateLineHeight(editor)
    const next = (wheelRemain.get(uriStr) || 0) + deltaY
    lines = next > 0 ? Math.floor(next / lh) : Math.ceil(next / lh)
    wheelRemain.set(uriStr, next - lines * lh)
  }
  if (!lines) return
  const active = vscode.window.activeTextEditor
  if (active && active.document.uri.toString() === uriStr) {
    void vscode.commands.executeCommand('editorScroll', {
      to: lines > 0 ? 'down' : 'up',
      by: 'line',
      value: Math.abs(lines),
      revealCursor: false,
    })
    return
  }
  const vis = editor.visibleRanges[0]
  if (!vis) return
  const last = Math.max(0, editor.document.lineCount - 1)
  const top = Math.min(last, Math.max(0, vis.start.line + lines))
  editor.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop)
}

function createHunkInsets(handlers) {
  /** @type {Map<string, object[]>} rec: { inset, key, slot, disposed } */
  const insetsByUri = new Map()
  const createFn = vscode.window.createWebviewTextEditorInset
  const supported = typeof createFn === 'function'
  let lastError = ''

  function key(editor) {
    return editor.document.uri.toString()
  }

  /**
   * @param {string} uriString
   * @description Drop every inset for this document (review finished / replaced).
   */
  function disposeFor(uriString) {
    const list = insetsByUri.get(uriString)
    insetsByUri.delete(uriString)
    if (!list) return
    for (const rec of list) {
      rec.disposed = true
      try { rec.inset.dispose() } catch { /* noop */ }
    }
  }

  /**
   * @param {import('vscode').TextEditor} editor
   * @param {object} session
   * @param {object} desired
   * @param {string} uriKey
   * @returns {object | null}
   * @description Create one webview inset; click uses a mutable slot.hunkIndex.
   */
  function createOne(editor, session, desired, uriKey) {
    let inset
    try {
      inset = vscode.window.createWebviewTextEditorInset(editor, desired.line, desired.height, { enableScripts: true })
    } catch (e) {
      lastError = (e && e.message) || String(e)
      return null
    }
    const slot = { hunkIndex: desired.hunkIndex }
    inset.webview.html = renderHunkHtml(desired.removedLines, desired.hunkIndex + 1, desired.total)
    inset.webview.onDidReceiveMessage((msg) => {
      if (msg && msg.type === 'accept') handlers.onAccept(session.uri, slot.hunkIndex)
      else if (msg && msg.type === 'revert') {
        // rejectHunk is async; swallow so a failed apply does not surface as an unhandled rejection
        void Promise.resolve(handlers.onReject(session.uri, slot.hunkIndex)).catch(() => { /* applyDocText logs */ })
      }
      else if (msg && msg.type === 'wheel') scrollOwningEditor(session.uri, msg)
    })
    const rec = { inset, key: desired.key, slot, disposed: false }
    inset.onDidDispose(() => {
      rec.disposed = true
      const list = insetsByUri.get(uriKey)
      if (!list) return
      const i = list.indexOf(rec)
      if (i >= 0) list.splice(i, 1)
      if (list.length === 0) insetsByUri.delete(uriKey)
    })
    return rec
  }

  /**
   * @param {object} rec
   * @param {object} desired
   * @description Keep the webview; refresh 接受 i/n and the click index.
   */
  function reuseOne(rec, desired) {
    rec.key = desired.key
    rec.slot.hunkIndex = desired.hunkIndex
    try {
      rec.inset.webview.postMessage({ type: 'meta', index: desired.hunkIndex + 1, total: desired.total })
    } catch { /* webview not ready */ }
  }

  return {
    supported,
    countFor(editor) {
      const list = insetsByUri.get(key(editor))
      if (!list) return 0
      let n = 0
      for (const rec of list) {
        if (!rec.disposed) n++
      }
      return n
    },
    clear(editor) {
      disposeFor(key(editor))
    },
    clearUri(uri) {
      disposeFor(uri.toString())
    },
    disposeAll() {
      for (const k of [...insetsByUri.keys()]) disposeFor(k)
    },
    lastError() { return lastError },
    /**
     * @param {import('vscode').TextEditor} editor
     * @param {object} session
     * @returns {number} live inset count
     * @description Reuse webviews whose ghost line+height+text still match.
     */
    apply(editor, session) {
      lastError = ''
      if (!supported) {
        lastError = 'createWebviewTextEditorInset missing (proposed API editorInsets)'
        return 0
      }
      const hunks = session.hunks || []
      const uriKey = key(editor)
      const desired = []
      for (let i = 0; i < hunks.length; i++) {
        const h = hunks[i]
        const removedLines = removedLinesForHunk(session.core.originalText, h)
        const line = Math.max(0, h.afterStart - 1)
        const height = Math.max(1, removedLines.length + 1)
        desired.push({
          line,
          height,
          removedLines,
          hunkIndex: i,
          total: hunks.length,
          key: ghostKey(removedLines, line, height),
        })
      }

      const prev = (insetsByUri.get(uriKey) || []).filter((rec) => !rec.disposed)
      const used = new Set()
      const next = []

      for (const d of desired) {
        let hit = -1
        for (let j = 0; j < prev.length; j++) {
          if (used.has(j)) continue
          if (prev[j].key === d.key) {
            hit = j
            break
          }
        }
        if (hit < 0) continue
        used.add(hit)
        reuseOne(prev[hit], d)
        next.push(prev[hit])
      }

      for (let j = 0; j < prev.length; j++) {
        if (used.has(j)) continue
        prev[j].disposed = true
        try { prev[j].inset.dispose() } catch { /* noop */ }
      }

      insetsByUri.set(uriKey, next)

      for (const d of desired) {
        let already = false
        for (const rec of next) {
          if (rec.key === d.key && !rec.disposed) {
            already = true
            break
          }
        }
        if (already) continue
        const rec = createOne(editor, session, d, uriKey)
        if (rec) next.push(rec)
      }

      if (next.length === 0) insetsByUri.delete(uriKey)
      else insetsByUri.set(uriKey, next)
      return next.length
    },
  }
}

module.exports = { createHunkInsets }
