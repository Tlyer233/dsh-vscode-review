'use strict'

const vscode = require('vscode')
const path = require('node:path')
const { createReviewHost } = require('./lib/session.js')
const { startPendingSync } = require('./lib/pending-sync.js')
const {
  setLog, setupDshBrowser, sendRefsToDsh, state: dshState, setFrameBaseUrl, reloadDshWebview,
} = require('./lib/dsh-browser.js')
const { restartDsh, restartDshProxy, restartDshBili, stopDsh, dshPort } = require('./lib/dsh-process.js')
const { startAuthProxy } = require('./lib/dsh-auth-proxy.js')
const { connectDshJobs } = require('./lib/dsh-jobs.js')
const { startElementContextWatcher } = require('./lib/element-context-watcher.js')
const { startCdpProbe } = require('./lib/cdp-element-source.js')
const { ensureProposedApi } = require('./lib/enable-insets.js')

function activate(context) {
  const log = vscode.window.createOutputChannel('dsh review / dsh')
  context.subscriptions.push(log)
  setLog((msg) => log.appendLine(String(msg)))
  log.appendLine('activate dsh-review-vscode')

  // Surface async pipeline failures (e.g. unhandled promise rejections) in this channel.
  try {
    process.on('unhandledRejection', (reason) => {
      log.appendLine('[dsh] unhandledRejection: ' + String((reason && reason.stack) || reason).slice(0, 300))
    })
  } catch { /* non-node host */ }

  const host = createReviewHost(context)
  startPendingSync(context, host)

  // dsh web now requires a browser session, and the sidebar iframe cannot carry
  // its SameSite=Strict cookie (cross-site vscode-webview parent). Serve the
  // sidebar through a local cookie-injecting proxy instead.
  try {
    const authProxyPort = Number(vscode.workspace.getConfiguration('dshReview').get('authProxyPort')) || 3081
    const authProxy = startAuthProxy({
      listenPort: authProxyPort,
      targetPort: dshPort(),
      log: (msg) => {
        log.appendLine('[auth-proxy] ' + msg)
        if (/^listen failed/.test(msg)) setFrameBaseUrl('')
        if (/^listening on/.test(msg)) {
          setFrameBaseUrl(authProxy.url)
          reloadDshWebview(true)
        }
      },
    })
    context.subscriptions.push({ dispose: () => authProxy.close() })
  } catch (e) {
    log.appendLine('[auth-proxy] start failed: ' + String((e && e.message) || e))
  }

  // Background dsh jobs → read-only VSCode terminals (SSE) + kill by id.
  try {
    const jobsBridge = connectDshJobs({ log: (msg) => log.appendLine('[dsh-jobs] ' + msg) })
    context.subscriptions.push({ dispose: () => jobsBridge.disconnect() })
    context.subscriptions.push(vscode.commands.registerCommand('dshReview.killDshJob', async (idArg) => {
      let id = typeof idArg === 'string' && idArg ? idArg : null
      if (!id) id = jobsBridge.killActive()
      if (!id) id = await vscode.window.showInputBox({ prompt: 'dsh job id to kill', placeHolder: 'e.g. bash-1' })
      if (id) jobsBridge.kill(id)
    }))
  } catch (e) {
    log.appendLine('[dsh-jobs] start failed: ' + String((e && e.message) || e))
  }

  setupDshBrowser(context)

  // TEST: watch Integrated Browser "Add Element to Chat" output file; print location only.
  startElementContextWatcher(context, log)
  startCdpProbe(context, log)

  // Persist enable-proposed-api in user-data argv.json so Dock launches get editorInsets.
  const argvResult = ensureProposedApi(context.extension.id)
  const insetsOn = typeof vscode.window.createWebviewTextEditorInset === 'function'
  log.appendLine(
    'argv.json proposed-api id=' + context.extension.id
    + ' path=' + argvResult.path
    + ' changed=' + argvResult.changed
    + ' insetsOn=' + insetsOn
    + (argvResult.error ? ' err=' + argvResult.error : ''),
  )
  if (!insetsOn) {
    void vscode.window.showWarningMessage(
      '行内大按钮未启用。已写入 ' + argvResult.path
      + ' 。请用「文件 → 退出」关掉 VS Code 再打开（不要只关窗口）。',
    )
  }
  setTimeout(() => {
    const fn = vscode.window.createWebviewTextEditorInset
    if (typeof fn !== 'function') {
      void vscode.window.showErrorMessage(
        'dsh review: editorInsets API missing — red phantom rows will not work',
      )
    }
  }, 0)

  context.subscriptions.push(vscode.commands.registerCommand('dshReview.openDshSidebar', async () => {
    try {
      if (dshState.dshView && dshState.dshVisible) {
        await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar')
      } else {
        await vscode.commands.executeCommand('dshReview.dshWebview.focus')
      }
    } catch (e) {
      log.appendLine('openSidebar failed: ' + (e && e.message || e))
    }
  }))

  context.subscriptions.push(vscode.commands.registerCommand('dshReview.restartDsh', () => restartDsh()))
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.stopDsh', () => stopDsh()))
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.restartDshProxy', () => restartDshProxy()))
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.restartDshBili', () => restartDshBili()))

  context.subscriptions.push(vscode.commands.registerCommand('dshReview.sendSelectionToDsh', () => sendEditorSelectionToDsh(log)))
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.sendTerminalSelectionToDsh', () => sendTerminalSelectionToDsh(log)))

  // Explorer drag into the sidebar webview is suppressed by VS Code itself
  // (webviewElement sets pointer-events none during internal drags — upstream
  // issue #182449), so file refs ride a right-click command instead.
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.sendFileToDsh', async (uri, uris) => {
    let list = Array.isArray(uris) && uris.length > 0 ? uris : (uri ? [uri] : [])
    if (list.length === 0) {
      // Keyboard dispatch inside the explorer omits the menu-injected resource
      // args. Borrow the built-in copyFilePath (it always receives the focused
      // tree item) and read the paths back from the clipboard.
      try {
        await vscode.commands.executeCommand('copyFilePath')
        const text = (await vscode.env.clipboard.readText() || '').trim()
        if (text) list = text.split(/\r?\n/).filter(Boolean).map((p) => vscode.Uri.file(p))
      } catch { /* clipboard unavailable */ }
    }
    if (list.length === 0) {
      log.appendLine('[sendFileToDsh] no selection (no menu args, clipboard empty)')
      return
    }
    const fsx = require('node:fs')
    const refs = list.map((u) => {
      let isDir = false
      try { isDir = fsx.statSync(u.fsPath).isDirectory() } catch { /* keep as file */ }
      return { kind: isDir ? 'folder' : 'file', path: u.fsPath }
    })
    log.appendLine('[sendFileToDsh] n=' + refs.length + ' first=' + refs[0].path)
    const ok = await sendRefsToDsh(refs, refs.map((r) => r.path).join('\n'))
    if (!ok) log.appendLine('[sendFileToDsh] sidebar not ready')
  }))
}

/**
 * Editor selection: chip + path/range or fenced snapshot (client settings).
 * @param {vscode.OutputChannel} log
 */
async function sendEditorSelectionToDsh(log) {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showWarningMessage('dsh: select some text in the editor first')
    return
  }
  const fsPath = editor.document.uri.fsPath
  // A notebook cell is its OWN text document (scheme vscode-notebook-cell,
  // URI = notebookUri#<handle>), so selection lines are already in-cell.
  // TextDocument.notebook is NOT populated by the extension host (API gap),
  // so resolve the cell via the active notebook editor and match by the
  // exact cell document URI.
  const nbEditor = vscode.window.activeNotebookEditor
  const nb = nbEditor ? nbEditor.notebook : undefined
  const startLine = editor.selection.start.line + 1
  const endLine = editor.selection.end.line + 1
  let notebook = false
  let cellStart = 0
  if (nb) {
    const docUri = editor.document.uri.toString()
    const cell = nb.getCells().find((c) => c.document.uri.toString() === docUri)
    if (cell) {
      notebook = true
      cellStart = cell.index + 1
    }
  }
  const lineRange = startLine === endLine ? 'L' + startLine : 'L' + startLine + '~L' + endLine
  const range = notebook ? 'C' + cellStart + ' ' + lineRange : lineRange
  const label = path.basename(fsPath) + ' ' + range
  const start = new vscode.Position(editor.selection.start.line, 0)
  const end = editor.document.lineAt(editor.selection.end.line).range.end
  const content = editor.document.getText(new vscode.Range(start, end))
  // Extension owns the send mode (dsh client-side settings mirror is not
  // reliable for plugin namespaces): pointer = backticked `path L1~L2`.
  const sendMode = String(vscode.workspace.getConfiguration('dshReview').get('snippetSend') || 'pointer')
  const pointer = '`' + fsPath.replace(/`/g, '') + ' ' + range + '`'
  const ref = {
    kind: 'selection',
    path: fsPath,
    notebook,
    cellStart,
    cellEnd: cellStart,
    startLine,
    endLine,
    content,
    label,
    sendMode,
    clipboardText: pointer,
    modelText: pointer,
  }
  log.appendLine('sendSelection: notebook=' + notebook + ' docUri=' + editor.document.uri.toString() + ' cells=' + (nb ? nb.cellCount : 0) + ' range=' + range + ' path=' + fsPath)
  const sent = await sendRefsToDsh([ref], pointer)
  if (!sent) log.appendLine('sendSelection: postMessage failed')
}

/**
 * Terminal selection: chip labeled with the terminal tab name; model gets a fence.
 * @param {vscode.OutputChannel} log
 */
async function sendTerminalSelectionToDsh(log) {
  const text = await readTerminalSelection()
  if (!text) {
    vscode.window.showWarningMessage('dsh: select some text in the terminal first')
    return
  }
  const term = vscode.window.activeTerminal
  const label = (term && term.name) ? String(term.name) : 'Terminal'
  const fenced = '\n```\n' + String(text).replace(/\n$/, '') + '\n```'
  const ref = {
    kind: 'terminal',
    content: text,
    label,
    clipboardText: fenced,
    modelText: fenced,
  }
  const sent = await sendRefsToDsh([ref], fenced)
  if (!sent) log.appendLine('sendTerminalSelection: postMessage failed')
}

/**
 * @returns {Promise<string>}
 * @description Copy terminal selection via the workbench command; restore clipboard.
 */
async function readTerminalSelection() {
  const prev = await vscode.env.clipboard.readText()
  const marker = '\u0000dsh-term-sel'
  try {
    await vscode.env.clipboard.writeText(marker)
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection')
    const text = await vscode.env.clipboard.readText()
    if (!text || text === marker) return ''
    return text
  } catch {
    return ''
  } finally {
    try { await vscode.env.clipboard.writeText(prev) } catch { /* noop */ }
  }
}

function deactivate() { }

module.exports = { activate, deactivate }
