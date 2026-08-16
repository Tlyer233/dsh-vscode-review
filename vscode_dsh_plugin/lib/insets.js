'use strict'

const vscode = require('vscode')

/**
 * lib/insets.js - Copilot-style phantom rows + per-hunk action bars.
 *
 * Uses the proposed editorInsets API (same mechanism Copilot uses for its
 * edit previews): each hunk gets a small webview mounted just above the
 * changed block. Inside it we render the REMOVED lines as red phantom rows
 * and an Accept/Revert action bar. If the proposed API is unavailable
 * (argv.json enable-proposed-api missing), creation throws and the caller
 * silently keeps the decoration-based fallback.
 *
 * One additional FIXED FOOTER inset is mounted after the last document line
 * with only the file-level buttons: ✓ 全部接受 / ✗ 全部撤回. The footer is
 * independent of the hunk list, so it stays put at the bottom.
 *
 * The proposal: vscode.window.createWebviewTextEditorInset(editor, line, height, options)
 *   - line is 0-based and the inset is rendered AFTER that line (Monaco
 *     view-zone afterLineNumber semantics) -> to sit above afterStart=N we
 *     anchor at N-1; afterStart=0 clamps to 0 (inset sits below line 0).
 */

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
    '  .actions .undo { color: var(--vscode-descriptionForeground, var(--vscode-foreground)); }' +
    '  .actions button:hover { text-decoration: underline; }' +
    '  .label { opacity: 0.7; }' +
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
    '    if (a) a.addEventListener("click", () => vscode.postMessage({ type: "accept" }));' +
    '    if (r) r.addEventListener("click", () => vscode.postMessage({ type: "revert" }));' +
    '  })();' +
    '</script>' +
    '</body></html>'
}

/** Fixed footer: file-level Accept All / Reject All, no hunk index. */
function renderFooterHtml() {
  return '' +
    '<!DOCTYPE html>' +
    '<html><head><meta charset="UTF-8"><style>' +
    '  * { margin: 0; padding: 0; box-sizing: border-box; }' +
    '  html, body { height: 100%; width: 100%; overflow: hidden; background: transparent; }' +
    '  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); }' +
    '  .footer {' +
    '    display: flex; align-items: center; gap: 14px;' +
    '    padding: 2px 8px; line-height: 1.5;' +
    '    background: rgba(128, 128, 128, 0.08);' +
    '    border-top: 1px solid rgba(128, 128, 128, 0.18);' +
    '    color: var(--vscode-descriptionForeground, var(--vscode-foreground));' +
    '  }' +
    '  .footer button { background: transparent; border: none; cursor: pointer; padding: 0; font: inherit; color: inherit; }' +
    '  .footer .accept { color: var(--vscode-charts-green, #2ea043); font-weight: 600; }' +
    '  .footer .revert { color: var(--vscode-errorForeground, #f14c4c); font-weight: 600; }' +
    '  .footer button:hover { text-decoration: underline; }' +
    '  .footer .sep { opacity: 0.3; }' +
    '</style></head><body>' +
    '<div class="footer">' +
    '  <button type="button" class="accept" id="acceptAll">&#10003; 全部接受</button>' +
    '  <span class="sep">|</span>' +
    '  <button type="button" class="revert" id="revertAll">&#8634; 全部撤回</button>' +
    '</div>' +
    '<script>' +
    '  (function () {' +
    '    const vscode = acquireVsCodeApi();' +
    '    const a = document.getElementById("acceptAll");' +
    '    const r = document.getElementById("revertAll");' +
    '    if (a) a.addEventListener("click", () => vscode.postMessage({ type: "acceptAll" }));' +
    '    if (r) r.addEventListener("click", () => vscode.postMessage({ type: "revertAll" }));' +
    '  })();' +
    '</script>' +
    '</body></html>'
}

class InsetManager {
  constructor(handlers) {
    this.handlers = handlers || {}
    this.insetsByEditor = new Map() // hunk insets only
    // The gate (if any) fires at call time inside applyToEditor, whose
    // try/catch flips supported=false on the first throw. Here we only check
    // the property surface so we never trigger side effects during probing.
    let probe = null
    try {
      if (typeof vscode !== 'undefined' && typeof vscode.window !== 'undefined') {
        const f = vscode.window.createWebviewTextEditorInset
        if (typeof f === 'function') {
          probe = 'callable'
        } else {
          probe = 'no-property (window has createWebviewPanel: ' + (typeof vscode.window.createWebviewPanel === 'function') + ')'
        }
      } else {
        probe = 'no-vscode-namespace'
      }
    } catch (e) {
      probe = 'probe-error: ' + (e && e.message ? e.message : String(e))
    }
    this.diagnostic = probe
    this.supported = probe === 'callable'
  }

  /**
   * Rebuild all hunk insets + the fixed bottom footer. Returns the number of
   * HUNK insets mounted (not counting the footer).
   */
  applyToEditor(editor, state, hunkIndexes) {
    this.disposeForEditor(this.key(editor))
    if (!this.supported) return 0

    const created = []
    const ordered = [...hunkIndexes].sort((x, y) => x - y)
    for (let pos = 0; pos < ordered.length; pos++) {
      const hunkIndex = ordered[pos]
      const h = state.hunks[hunkIndex]
      if (!h) continue
      const removedLines = removedLineTexts(state.beforeText, h)
      const line = Math.max(0, h.afterStart - 1)
      const height = removedLines.length + 1
      let inset
      try {
        inset = vscode.window.createWebviewTextEditorInset(editor, line, height, { enableScripts: true })
      } catch (err) {
        // Transient failure (editor closing, etc.) — skip the hunk but keep
        // support so the next refresh can retry; note it for diagnostics.
        this.diagnostic = 'create-failed: ' + (err && err.message ? err.message : String(err))
        continue
      }
      inset.webview.html = renderHunkHtml(removedLines, pos + 1, ordered.length)
      inset.webview.onDidReceiveMessage((msg) => {
        if (msg && msg.type === 'accept') this.handlers.onAccept && this.handlers.onAccept(hunkIndex, state)
        else if (msg && msg.type === 'revert') this.handlers.onRevert && this.handlers.onRevert(hunkIndex, state)
      })
      inset.onDidDispose(() => {
        const list = this.insetsByEditor.get(this.key(editor))
        if (!list) return
        const idx = list.indexOf(inset)
        if (idx >= 0) list.splice(idx, 1)
      })
      created.push(inset)
    }

    if (created.length > 0) this.insetsByEditor.set(this.key(editor), created)
    return created.length
  }

  /** Number of HUNK insets currently mounted for this editor. */
  countForEditor(editor) {
    const list = this.insetsByEditor.get(this.key(editor))
    return list ? list.length : 0
  }

  clearEditor(editor) {
    this.disposeForEditor(this.key(editor))
  }

  disposeAll() {
    const keys = [...this.insetsByEditor.keys()]
    for (const key of keys) this.disposeForEditor(key)
  }

  disposeForEditor(key) {
    const list = this.insetsByEditor.get(key)
    if (!list) return
    this.insetsByEditor.delete(key)
    const snapshot = list.slice()
    for (const inset of snapshot) { try { inset.dispose() } catch (e) { /* noop */ } }
  }

  key(editor) {
    // uri only — viewColumn changes when the user drags tabs, which would
    // orphan old insets into clickable-but-stale "ghost" buttons.
    return editor.document.uri.toString()
  }
}

function removedLineTexts(beforeText, h) {
  if (beforeText === null || h.beforeCount === 0) return []
  const b = String(beforeText).split(/\r?\n/)
  if (b.length > 0 && b[b.length - 1] === '') b.pop()
  return b.slice(h.beforeStart, h.beforeStart + h.beforeCount)
}

module.exports = { InsetManager, removedLineTexts }
