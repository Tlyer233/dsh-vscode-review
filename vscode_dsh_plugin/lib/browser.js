'use strict'

/**
 * dsh-review-vscode — sidebar dsh webview + vscode:// URI handler.
 *
 * Owns the full-height iframe around the dsh web UI, the message bridge
 * (dshInsertText/dshPasteText -> iframe; dshCopyText/dshPasteRequest ->
 * vscode.postMessage; dshReload -> reloadFrame), and the URI handler that
 * opens pending files as text so image/binary files still get inline review.
 */

const vscode = require('vscode')
const fs = require('node:fs')
const path = require('node:path')
const { state, log } = require('./runtime.js')
const { findEntryForFile } = require('./journal.js')
const { pendingFor, refreshPending, startInlineReview } = require('./pending.js')
const { markDshActive } = require('./owner.js')
const { runBatchVerdict } = require('./actions.js')

/** Sidebar webview: full-height iframe around the dsh web UI. */
function dshWebviewHtml(url) {
  const u = String(url || 'http://127.0.0.1:3080')
  const safe = u.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return '' +
    '<!DOCTYPE html>' +
    '<html><head><meta charset="UTF-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; frame-src ' + safe + '; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">' +
    '<style>' +
    'html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; display: flex; flex-direction: column; }' +
    'iframe { display: block; flex: 1; width: 100%; border: 0; }' +
    '</style></head>' +
    '<body>' +
    '<iframe id="dsh-frame" src="' + safe + (u.indexOf('?') >= 0 ? '&' : '?') + '_dshVscode=' + Date.now() + '" allow="clipboard-read; clipboard-write"></iframe>' +
    '<script>' +
    '  var vscode = acquireVsCodeApi();' +
    '  var frame = document.getElementById("dsh-frame");' +
    '  function reloadFrame(force) {' +
    '    try {' +
    '      if (force && frame) {' +
    '        var src = frame.src;' +
    '        frame.src = src + (src.indexOf("?") >= 0 ? "&" : "?") + "_dshReload=" + Date.now();' +
    '      } else if (frame && frame.contentWindow) {' +
    '        frame.contentWindow.location.reload();' +
    '      }' +
    '    } catch (e) {' +
    '      if (frame) frame.src = frame.src;' +
    '    }' +
    '  }' +
    '  document.addEventListener("keydown", function (event) {' +
    '    var mod = event.metaKey || event.ctrlKey;' +
    '    var key = String(event.key || "").toLowerCase();' +
    '    if (mod && !event.altKey && key === "r") {' +
    '      event.preventDefault();' +
    '      reloadFrame(!!event.shiftKey);' +
    '    }' +
    '  });' +
    '  var lastActiveAt = 0;' +
    '  function reportDshActive() {' +
    '    var now = Date.now();' +
    '    if (now - lastActiveAt < 3000) return;' +
    '    lastActiveAt = now;' +
    '    vscode.postMessage({ type: "dshViewActive" });' +
    '  }' +
    '  window.addEventListener("focus", reportDshActive);' +
    '  document.addEventListener("pointerdown", reportDshActive, true);' +
    '  document.addEventListener("keydown", reportDshActive, true);' +
    '  window.addEventListener("message", function (event) {' +
    '    var msg = event.data;' +
    '    if (!msg) return;' +
    '    if (msg.type === "dshBridgeHello") {' +
    '      if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: "dshBridgeAck" }, "*");' +
    '      vscode.postMessage({ type: "dshBridgeHello" });' +
    '    } else if (msg.type === "dshInsertText" || msg.type === "dshInsertRefs" || msg.type === "dshPasteText" || msg.type === "dshSetScope") {' +
    '      if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, "*");' +
    '    } else if (msg.type === "dshViewActive" || msg.type === "dshOpenExternal" || msg.type === "dshScopeViolation" || msg.type === "dshScopeMissing" || msg.type === "dshCopyText" || msg.type === "dshPasteRequest" || msg.type === "dshDropProbe" || msg.type === "dshDropResult" || msg.type === "dshInsertResult" || msg.type === "dshPipelineProbe") {' +
    '      vscode.postMessage(msg);' +
    '    } else if (msg.type === "dshReload") {' +
    '      reloadFrame(!!msg.force);' +
    '    }' +
    '  });' +
    '</script>' +
    '</body>' +
    '</html>'
}

/** Send text into the dsh sidebar iframe (the dsh client inserts at cursor). */
async function sendTextToDsh(text) {
  const payload = String(text ?? '')
  if (payload === '') return false
  if (!state.dshView) {
    try { await vscode.commands.executeCommand('dshReview.dshWebview.focus') } catch { /* not visible yet */ }
  }
  if (!state.dshView) {
    vscode.window.showWarningMessage('dsh review: open the dsh sidebar first')
    return false
  }
  try {
    return await state.dshView.webview.postMessage({ type: 'dshInsertText', text: payload })
  } catch (e) {
    log('sendTextToDsh failed:', e && e.message || e)
    return false
  }
}

/** Send structured references; dsh mints native chips, fallbackText keeps the old path. */
async function sendRefsToDsh(refs, fallbackText) {
  if (!Array.isArray(refs) || refs.length === 0) return sendTextToDsh(fallbackText)
  if (!state.dshView) {
    try { await vscode.commands.executeCommand('dshReview.dshWebview.focus') } catch { /* not visible yet */ }
  }
  if (!state.dshView) {
    vscode.window.showWarningMessage('dsh review: open the dsh sidebar first')
    return false
  }
  try {
    return await state.dshView.webview.postMessage({
      type: 'dshInsertRefs',
      refs,
      fallbackText: String(fallbackText ?? ''),
    })
  } catch (e) {
    log('sendRefsToDsh failed:', e && e.message || e)
    return false
  }
}

/**
 * Open a file as a TEXT document and attach its pending review. Used by the
 * vscode:// URI handler so files that normally open in an image/binary
 * viewer (e.g. .svg) still get the inline AC/RJ diff.
 */
async function openPendingFile(storeDir, filePath) {
  const abs = path.resolve(String(filePath || ''))
  const entry = findEntryForFile(storeDir, abs)
  if (!entry) {
    log('uri open: no committed entry for', abs)
    vscode.window.showWarningMessage('dsh review: no pending change for ' + path.basename(abs))
    return false
  }
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs))
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false })
    if (pendingFor(doc.uri)) {
      refreshPending(doc.uri)
    } else {
      await startInlineReview(storeDir, entry)
    }
    return true
  } catch (e) {
    log('uri open failed:', abs, e && e.message || e)
    return false
  }
}

/**
 * The workbench whitelist this VS Code window imposes on the embedded dsh:
 * realpath + raw fsPath of every workspace folder. The dsh client pulls the
 * session back to one of these paths whenever the server pushes it into a
 * different workbench; other dsh UI (settings/search/picker/plugins) is never
 * filtered. An empty list (no folder open) disables the watchdog entirely.
 */
function scopePaths() {
  const folders = vscode.workspace.workspaceFolders || []
  const paths = []
  const rawPaths = []
  for (const folder of folders) {
    const raw = folder.uri.fsPath
    rawPaths.push(raw)
    try { paths.push(fs.realpathSync.native(raw)) } catch { paths.push(raw) }
  }
  return { paths, rawPaths }
}

function postScope(view) {
  if (!view) return
  const scope = scopePaths()
  void view.webview.postMessage({ type: 'dshSetScope', paths: scope.paths, rawPaths: scope.rawPaths })
}

/**
 * Register the sidebar webview provider + URI handler in activate().
 */
function setupDshBrowser(context, storeDir) {
  // dsh sidebar webview: the whole dsh web UI inside VS Code's side bar.
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('dshReview.dshWebview', {
    resolveWebviewView(view) {
      const url = String(vscode.workspace.getConfiguration('dshReview').get('webUrl') || 'http://127.0.0.1:3080')
      view.webview.options = { enableScripts: true }
      view.title = 'dsh'
      view.description = url
      view.webview.html = dshWebviewHtml(url)
      view.webview.onDidReceiveMessage((msg) => {
        if (!msg) return
        if (msg.type === 'dshBridgeHello') {
          // The dsh page inside the iframe said hello -> dsh is alive in
          // THIS VS Code window. Refresh the ownership activity stamp used
          // by the auto-open gate (lib/owner.js).
          state.dshOwnerAt = Date.now()
          log('dsh bridge hello [' + state.instanceId + ']: this window is a dsh host')
          postScope(view)
          return
        }
        if (msg.type === 'dshViewActive') {
          // Real user activity inside the dsh UI (pointer/keyboard/focus).
          // Bump the activity stamp and attempt an ownership claim, so the
          // lease follows the window the user is actually talking to.
          markDshActive(storeDir)
          return
        }
        if (msg.type === 'dshOpenExternal') {
          try {
            const url = String(msg.url || '')
            const parsed = vscode.Uri.parse(url)
            if (parsed.scheme === 'http' || parsed.scheme === 'https') {
              void vscode.env.openExternal(parsed)
            }
          } catch (e) {
            log('dshOpenExternal failed:', e && e.message || e)
          }
          return
        }
        if (msg.type === 'dshScopeViolation') {
          const now = Date.now()
          if (now - (state.lastScopeNoticeAt || 0) > 2500) {
            state.lastScopeNoticeAt = now
            void vscode.window.showInformationMessage('只能查看当前工作区')
          }
          return
        }
        if (msg.type === 'dshScopeMissing') {
          const now = Date.now()
          if (now - (state.lastScopeNoticeAt || 0) > 4000) {
            state.lastScopeNoticeAt = now
            void vscode.window.showWarningMessage('该窗口绑定的工作区尚未在 dsh 中创建，已返回 dsh 首页')
          }
          return
        }
        if (msg.type === 'dshCopyText' && typeof msg.text === 'string') {
          void vscode.env.clipboard.writeText(msg.text)
        } else if (msg.type === 'dshPasteRequest') {
          vscode.env.clipboard.readText().then((text) => {
            void view.webview.postMessage({ type: 'dshPasteText', text: String(text ?? '') })
          }, () => { /* clipboard empty/unreadable */ })
        } else if (msg.type === 'dshPipelineProbe') {
          log('PIPELINE PROBE inputHub=' + String(!!msg.inputHub) + ' refSource=' + String(!!msg.refSource))
        } else if (msg.type === 'dshInsertResult') {
          log('INSERT RESULT', msg.source || '?', 'mode=' + (msg.mode || '?'), 'count=' + (msg.count || 0), 'reason=' + String(msg.reason || ''))
        } else if (msg.type === 'dshDropResult') {
          log('DROP RESULT: inserted', msg.count || 0, 'file path(s), first:', msg.first || '')
        } else if (msg.type === 'dshDropProbe') {
          const p = msg.payload || {}
          const types = Array.isArray(p.types) ? p.types.join(',') : ''
          const files = Array.isArray(p.files) ? p.files.join(',') : ''
          const items = Array.isArray(p.items) ? p.items.join(',') : ''
          log('DROP PROBE', p.phase || '?',
            '| types=[' + types + ']',
            '| files=[' + files + ']',
            '| items=[' + items + ']',
            '| uri=' + JSON.stringify(p.uriList || ''),
            '| internal=' + JSON.stringify(p.internalList || ''),
            '| plain=' + JSON.stringify(p.plain || ''))
          if (p.phase === 'drop') {
            const detail = 'types=[' + types + '] files=[' + files + '] items=[' + items + '] uri=' + String(p.uriList || '').slice(0, 120)
            void vscode.window.showInformationMessage('dsh drop probe (drop): ' + detail)
          }
        }
      })
      state.dshView = view
      state.dshVisible = !!view.visible
      state.dshOwnerAt = Date.now()
      postScope(view)
      view.onDidChangeVisibility(() => {
        state.dshVisible = !!view.visible
        if (view.visible) state.dshOwnerAt = Date.now()
      })
      view.onDidDispose(() => {
        if (state.dshView === view) {
          state.dshView = null
          state.dshVisible = false
        }
      })
    },
  }, { webviewOptions: { retainContextWhenHidden: true } }))

  // Keep the whitelist fresh when the user adds/removes workspace folders.
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (state.dshView) postScope(state.dshView)
  }))

  // vscode:// handler: the dsh web panel opens pending files through here so
  // non-text editors (svg images, previews) still get forced text + review.
  context.subscriptions.push(vscode.window.registerUriHandler({
    handleUri(uri) {
      try {
        log('URI:', uri.toString())
        if (uri.path !== '/review' && uri.path !== '/review/') return
        const params = new URLSearchParams(uri.query)
        const action = params.get('action')
        if (action === 'acceptAll' || action === 'rejectAll') {
          let files = []
          const batch = params.get('batch')
          if (batch) {
            try {
              const obj = JSON.parse(Buffer.from(batch, 'base64url').toString('utf8'))
              if (obj && Array.isArray(obj.files)) files = obj.files
            } catch (e) { log('batch query parse failed:', e && e.message || e) }
          }
          if (files.length === 0) files = params.getAll('file')
          files = files.map((f) => String(f || '')).filter(Boolean)
          if (files.length === 0) return
          void runBatchVerdict(storeDir, files, action).then((results) => {
            const ok = results.filter((r) => r.ok).length
            const label = action === 'acceptAll' ? 'accepted' : 'rejected'
            void vscode.window.showInformationMessage('dsh review: ' + label + ' ' + ok + '/' + results.length + ' file(s)')
          })
          return
        }
        const file = params.get('file')
        if (file) void openPendingFile(storeDir, file)
      } catch (e) {
        log('URI handler failed:', e && e.message || e)
      }
    },
  }))
}

module.exports = { dshWebviewHtml, sendTextToDsh, sendRefsToDsh, openPendingFile, setupDshBrowser }
