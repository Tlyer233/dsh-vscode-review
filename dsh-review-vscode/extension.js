'use strict'

const vscode = require('vscode')
const path = require('node:path')
const { createReviewHost } = require('./lib/session.js')
const { startPendingSync } = require('./lib/pending-sync.js')
const {
  setLog, setupDshBrowser, sendRefsToDsh, state: dshState, setFrameBaseUrl, reloadDshWebview,
} = require('./lib/dsh-browser.js')
const { restartDsh, restartDshProxy, restartDshBili, restartDshAtUrl, stopDsh, dshPort } = require('./lib/dsh-process.js')
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
  // Interface-bound proxy serving the sidebar through a direct URL that
  // `dshReview.setDshUrl` pinned (webviewUrl host is a real network IP).
  let directProxy = null

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

  // A direct URL pinned by `dshReview.setDshUrl` (host is a real interface IP,
  // proxy on port+2) has to be re-served after every extension-host restart.
  try {
    const dconf = vscode.workspace.getConfiguration('dshReview')
    const wv = String(dconf.get('webviewUrl') || '').trim()
    const wu = String(dconf.get('webUrl') || '').trim()
    if (wv && wu) {
      const vw = new URL(wv)
      const tw = new URL(wu)
      const lh = vw.hostname
      if (/^\d+\.\d+\.\d+\.\d+$/.test(lh) && lh !== '127.0.0.1' && Number(vw.port)) {
        directProxy = startAuthProxy({
          listenHost: lh, listenPort: Number(vw.port),
          targetHost: tw.hostname, targetPort: Number(tw.port) || 80,
          log: (msg) => log.appendLine('[direct-proxy] ' + msg),
        })
        context.subscriptions.push({ dispose: () => { try { directProxy && directProxy.close() } catch { /* noop */ } } })
        setFrameBaseUrl('')
      }
    }
  } catch (e) {
    log.appendLine('[direct-proxy] start failed: ' + String((e && e.message) || e))
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
  // Neither side feature may abort activate(): in 0.1.26 a bad module export threw
  // in here, activate() died before registering commands, and EVERY dsh command
  // answered "not found" (whole sidebar dead). Keep them isolated.
  // 0.1.34: native-comment receiver. VS Code's own comment box is unreachable from
  // CDP, so tools/patch_comment_hook.py adds a beacon inside the shipped bundles that
  // POSTs each comment here; the payload goes through the same md-file + chip pipeline.
  const startNativeComment = (ctx, lg) => {
    const on = (() => {
      try { return !!vscode.workspace.getConfiguration('dshReview.browserComment').get('nativeBridge', false) } catch { return false }
    })()
    if (!on) { lg.appendLine('[native-comment] 已停用（dshReview.browserComment.nativeBridge=false，0.1.39 起默认关）'); return }
    require('./lib/native-comment-server')({ context: ctx, log: lg })
  }
  // 0.1.40: the 'cdp' module auto-clicks chat element chips (its old element->source
  // trick). Clicking a chip OPENS its document, which is exactly the
  // "Attached Element Context from Integrated · Untitled-1" tab the user keeps hitting
  // — native Copilot never clicks it, so native never opens it. Off by default now;
  // dshReview.elementContext.clickChips=true brings it back.
  let clickChips = false
  try { clickChips = !!vscode.workspace.getConfiguration('dshReview.elementContext').get('clickChips', false) } catch { /* noop */ }
  const sideFeatures = [['element-context', startElementContextWatcher], ['native-comment', startNativeComment]]
  if (clickChips) sideFeatures.push(['cdp', startCdpProbe])
  else log.appendLine('[cdp] 已停用（0.1.40 默认关：点 chip 会打开附件文档 / 引出保存面板；要开设置 dshReview.elementContext.clickChips）')
  for (const [name, fn] of sideFeatures) {
    try {
      fn(context, log)
    } catch (e) {
      log.appendLine('[' + name + '] start failed: ' + String((e && e.message) || e))
    }
  }

  // 0.1.26: Integrated-browser element comments. Shift+Enter inside VS Code's
  // in-page comment box sends {element chip + comment text} into the dsh
  // composer; Enter stays VS Code's (still goes to Copilot). The module owns the
  // dshReview.browserComment.sendToDsh switch and re-reads it every scan, so
  // turning it off stops all CDP work without restarting VS Code.
  try {
    const { startBrowserComment } = require('./lib/browser-comment.js')
    const bridge = require('./lib/element-bridge.js')
    startBrowserComment({
      context,
      log: { appendLine: (m) => log.appendLine(String(m)) },
      onComment: (p) => {
        void bridge.deliverBrowserComment(p).then((r) => {
          if (r && r.ok === false) log.appendLine('[browser-comment] deliver failed: ' + r.why)
        })
      },
    })
  } catch (e) {
    log.appendLine('[browser-comment] start failed: ' + String((e && e.message) || e))
  }

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

  // Point the sidebar at an explicit dsh URL (host:port). A literal non-loopback
  // IPv4 (e.g. a Tailscale address) makes dsh bind that interface with
  // `dsh web --host`, and a cookie-injecting proxy is bound to the same
  // interface on port+2, so the Mac-side webview reaches everything directly —
  // no VS Code tunnel, no SSH forward. A loopback host restores the standard
  // auto-resolved proxy mode.
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.setDshUrl', async () => {
    const conf = vscode.workspace.getConfiguration('dshReview')
    const current = String(conf.get('webviewUrl') || conf.get('webUrl') || '')
    let picked = await vscode.window.showInputBox({
      title: 'dsh: 侧栏 dsh 网址（输入后重启该地址的 dsh）',
      prompt: '例 100.85.98.34:3080（直连）或 3080（本机回环）；留空回车取消',
      value: current,
      ignoreFocusOut: true,
    })
    picked = String(picked || '').trim()
    if (!picked) return
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(picked)) picked = 'http://' + picked
    let u
    try { u = new URL(picked) } catch {
      vscode.window.showErrorMessage('dshReview: 无效网址 ' + picked)
      return
    }
    const host = u.hostname
    const port = Number(u.port) || 3080
    const target = u.protocol + '//' + host + ':' + String(port)
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
    const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host)
    if (directProxy) { try { directProxy.close() } catch { /* noop */ } directProxy = null }
    try {
      await conf.update('webUrl', target, vscode.ConfigurationTarget.Machine)
      await conf.update('webviewUrl', (!loopback && isIp) ? 'http://' + host + ':' + String(port + 2) : '', vscode.ConfigurationTarget.Machine)
    } catch (e) {
      log.appendLine('setDshUrl settings update failed: ' + (e && e.message || e))
    }
    await restartDshAtUrl(target)
    if (!loopback && isIp) {
      try {
        directProxy = startAuthProxy({
          listenHost: host, listenPort: port + 2,
          targetHost: host, targetPort: port,
          log: (msg) => log.appendLine('[direct-proxy] ' + msg),
        })
        context.subscriptions.push({ dispose: () => { try { directProxy && directProxy.close() } catch { /* noop */ } } })
        // The restart's reload happened before the proxy was up; redo it now.
        reloadDshWebview(true)
      } catch (e) {
        log.appendLine('setDshUrl direct proxy failed: ' + (e && e.message || e))
        vscode.window.showErrorMessage('dshReview: 直连代理启动失败 ' + String((e && e.message) || e))
      }
    }
  }))

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
