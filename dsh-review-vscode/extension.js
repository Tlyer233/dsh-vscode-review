'use strict'

const vscode = require('vscode')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { createReviewHost } = require('./lib/session.js')
const { startPendingSync } = require('./lib/pending-sync.js')
const {
  setLog, setupDshBrowser, sendRefsToDsh, sendAnnoDock, state: dshState, setFrameBaseUrl, reloadDshWebview,
  dshComposerHostPort,
} = require('./lib/dsh-browser.js')
const { AnnoDriver } = require('./lib/anno-cdp.js')
const annoHeap = require('./lib/anno-heap.js')
const { restartDsh, restartDshProxy, restartDshBili, restartDshAtUrl, stopDsh, dshPort } = require('./lib/dsh-process.js')
const { startAuthProxy } = require('./lib/dsh-auth-proxy.js')
const { connectDshJobs } = require('./lib/dsh-jobs.js')
const { ensureProposedApi } = require('./lib/enable-insets.js')

function activate(context) {
  const log = vscode.window.createOutputChannel('dsh review / dsh')
  context.subscriptions.push(log)
  setLog((msg) => log.appendLine(String(msg)))
  log.appendLine('activate dsh-review-vscode v' + (function () { try { return require('./package.json').version } catch (e0) { return '?' } })())
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

  // Element annotation → dsh mirror (Comment on Elements). Gated by
  // dshReview.annotationToDsh (default on). The CDP driver injects an
  // event-driven MutationObserver into THIS window's workbench (scoped via the
  // dsh composer webview, so a sibling SSH window is never touched) and mirrors
  // NEW element chips + their comment text into the dsh composer. No polling.
  try {
    const annoOn = vscode.workspace.getConfiguration('dshReview').get('annotationToDsh') !== false
    if (annoOn) {
      const annoDriver = new AnnoDriver({
        log: (msg) => log.appendLine('[anno] ' + msg),
        cdpPort: 9223,
        getDshHostPort: dshComposerHostPort,
        onState: (chips, lines) => { annoWidgetBeaconed(); annoMirrorOnState(chips, lines, log); annoResyncIfOn(chips, lines, log) },
        // (0.1.119) 打开即回 (user's "0.0000000001ms"): the moment Copilot
        // opens, return to dsh — no debounce. Exception: while annoSendSync is
        // reading/deleting (freeze) or ✕ deletes are in flight, keep it open,
        // otherwise the flash-open would be closed before the chips are read.
        onOpened: () => {
          if (!annoFeatureOn()) return
          if (annoFreezeReturn || annoDeletesInFlight > 0) {
            dshState.log('[anno] copilot opened during read/delete — keep open')
            return
          }
          dshState.log('[anno] copilot opened — return NOW (打开即回)')
          annoReturnToDsh = true
          annoReturnIfIdle()
        },
      })
      // Shared with the dsh webview host: dock ✕ (dshAnnoDelete) and consume
      // (dshAnnoConsumed) must land on the REAL CDP click, not a DOM fake.
      dshState.annoDriver = annoDriver
      dshState.logChannel = log
      dshState.annoDeleteChip = (name) => realDeleteChip(String(name || ''))
      dshState.annoDeleteAll = (req) => annoSendSync(req)
      // Sidebar (re)load resync: only when chips are already known (a refresh,
      // not a clean start) — flash copilot so the widget renders + re-beacons.
      dshState.annoResync = () => annoResync()
      dshState.annoHasChips = () => annoCurrentChips.length > 0
      context.subscriptions.push({ dispose: () => annoDriver.stop() })
      void annoDriver.start()
      log.appendLine('annotation mirror enabled (CDP 9223)')
      // Startup: flash Copilot once so the widget renders -> observer beacons
      // -> startup cleanup deletes leftover chips. One-shot, not polling.
      void (async () => {
        // (0.1.115) 设置 card toggle off = feature does not exist: no startup
        // flash, no cleanup — the native Copilot flow stays untouched.
        if (!annoFeatureOn()) { log.appendLine('[anno] startup: annotationToDsh=off — feature silent'); return }
        await new Promise((r) => setTimeout(r, 1500))
        log.appendLine('[anno] startup: flashing copilot to render widget')
        annoReturnToDsh = true
        await flashCopilot()
        await waitForWidgetRendered(2500)
        // Clear input NOW while widget is rendered (before flash-back hides it)
        const clr = await clearCopilotInputVerified(log, 'anno')
        log.appendLine('[anno] startup: input clear=' + clr)
        log.appendLine('[anno] startup: flash done, waiting for beacon')
      })()
    } else {
      log.appendLine('annotation mirror disabled (annotationToDsh=false)')
    }
  } catch (e) {
    log.appendLine('[anno] start failed: ' + String((e && e.message) || e))
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

  // Focus the dsh webview (bring the secondary sidebar to the dsh container and
  // show the view). Previously a no-op (never registered), so "jump back to dsh"
  // silently failed.
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.dshWebview.focus', async () => {
    try { await vscode.commands.executeCommand('workbench.view.dsh') } catch (e) { /* noop */ }
    const v = dshState.dshView
    if (v && typeof v.show === 'function') {
      try { v.show(false) } catch (e) { /* noop */ }
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
 * Element-annotation mirror state (Comment on Elements → dsh).
 *
 * The first beacon records the chips already present in the Copilot chat (they
 * predate the feature and are NOT mirrored — avoids flooding the composer with
 * a dozen stale chips). Subsequent beacons mirror only NEW chips, each paired
 * with its `@<name> <text>` comment line (chip = the element, text = the
 * instruction, per the 0.1.70 dsh client's appendText contract).
 * @param {object[]} chips [{name, aria, hasX}]
 * @param {object[]} lines [{ref, text}]
 * @param {vscode.OutputChannel} log
 */
const annoMirrored = new Set()
let annoInitialRecorded = false
/** Latest full Copilot chip state (from the last beacon) — the dock truth. */
let annoCurrentChips = []
/** One-shot: first beacon after startup clears all leftover Copilot chips. */
let annoStartupCleanup = true
/**
 * Return-to-dsh coordination. Flashing the Copilot panel (for a delete or a
 * resync) hides the dsh view; we must switch back — but ONLY after the state
 * has been captured. A delete's "widget appeared" beacon must NOT trigger the
 * return (the CDP click hasn't landed yet); the return happens after the click
 * succeeds and the fresh state is pulled. `annoDeletesInFlight` gates that.
 */
let annoReturnToDsh = false
let annoDeletesInFlight = 0
let annoReturnTimeout = null
/** Debounce timer for the per-beacon flash-back (annotation-time return to dsh). */
let annoReturnDebounce = null
/** Freeze: suppress flash-back-to-dsh while annoSendSync reads the widget. */
let annoFreezeReturn = false
/** Baseline = leftover chips present at startup (NOT the user's annotations).
 *  The user's idempotency contract is: empty → annotate → send(capture+clear) → empty.
 *  But Copilot's annotation state persists across restarts, so leftovers re-render
 *  even after we delete the visible chips. We must never capture leftovers as if
 *  they were the current round's annotations. Baseline exclusion makes the capture
 *  idempotent against leftovers. */
let annoBaseline = new Set()
let annoPreparedBlock = ''
// (0.1.155) PASSIVE annotation-time capture — the user's rule: 标注时刻原生不动.
// The beacon already reports chips; we only READ (page rebuild; hover only for
// ambiguous names — zero clicks) and write the file, then push the
// {name, comment, file} list to the client so its send path is FULLY
// SYNCHRONOUS like dsh-annotate@0.1.0 (L775-793). Chips untouched; deletion
// stays in the post-send 149 cleanup.
const annoCaptureFiles = new Map()
// (0.1.175) key -> last NON-EMPTY comment text. Beacon 'lines' lag/miss some
// chips (12:23: lines carried only 2 of 5 comments) — persist text per key so
// a comment seen once is never lost to a later beacon that forgot it.
const annoChipTexts = new Map()
const annoCaptureInflight = new Set()
// (0.1.159) reserved files awaiting their send-time hover fill
const annoPendingFullKeys = new Set()
const annoPreparedPostedFor = new Set()
let annoSendBusy = false
let annoLastBlock = ''

/** Answer a waiting intercepted send ASAP (before cleanup). */
/** (0.1.165) progress milestone for the dsh composer ring. */
function annoPostProg(req, stage) {
  if (req === undefined || req === null) return
  try {
    const v = dshState.dshView
    if (v && v.webview) v.webview.postMessage({ type: 'dshAnnoProg', req: req, stage: stage })
  } catch (e2) { /* best effort */ }
}
function annoPostPrepared(req, block) {
  if (req === undefined || req === null) return
  if (annoPreparedPostedFor.has(req)) return
  annoPreparedPostedFor.add(req)
  try {
    const v = dshState.dshView
    if (v && v.webview) v.webview.postMessage({ type: 'dshAnnoPrepared', req: req, block: block || '' })
    dshState.log('[trump] ③ prepared posted (req=' + req + ', ' + (block || '').length + ' chars)')
  } catch (e) { /* best effort */ }
}
let annoDockJsonLast = ''
/** (0.1.116) Last beacon state key — identical beacons never re-arm the flash-back debounce. */
let lastBeaconStateKey = ''
/**
 * (0.1.115) The dsh 设置 card (设置 → 代码审查 → "浏览器元素批注发给 dsh")
 * persists to ~/.dsh/review/shadow/settings.json. Read it AT EVENTS (file read
 * on send / beacon / resync — never a poll). Off = the feature does not exist:
 * no send-sync capture, no Copilot clear, no flash-back to dsh, no startup
 * cleanup flash. Only the VS Code sidebar is affected; Chrome dsh never sends
 * the consumed message in the first place. Missing/corrupt file = default on
 * (matches the schema default in the plugin's index.js).
 * @returns {boolean}
 */
// (0.1.167) dsh settings card: showHoverCard (default ON = native behavior:
// hover card visible during send-read). OFF = hide it for the read window.
function annoHoverCardVisible() {
  // (0.1.181) POLARITY FLIPPED per user ruling "默认不修改 vscode hover 逻辑":
  // the new key hideHoverCard defaults to FALSE = never touch VS Code's own
  // hover rendering. Only when explicitly ON (and only on the hover-fallback
  // path — the heap main path never hovers) does the temporary
  // visibility:hidden trick arm.
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'review', 'shadow', 'settings.json'), 'utf8'))
    return raw.hideHoverCard !== true
  } catch (e) {
    return true
  }
}
function annoFeatureOn() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'review', 'shadow', 'settings.json'), 'utf8'))
    return raw.annotationToDsh !== false
  } catch (e) {
    return true
  }
}
/**
 * Event-driven "widget rendered" waiter. Instead of polling the DOM, we flash
 * Copilot and await a promise that the observer beacon resolves (the beacon
 * fires when the widget renders in the DOM). No polling.
 */
let annoWidgetWaiter = null // { resolve: () => void } | null
/**
 * (0.1.115) One-shot "a beacon carrying chips>0 arrived" waiter — fixes the
 * empty-window read. When the Copilot view reopens, its container renders
 * BEFORE the model restores the chips into it; a getState in that window
 * returns 0 even though the user annotated. The doc-level observer safety
 * net re-beacons when the chips land; we await that event (bounded, no poll).
 */
let annoChipsWaiter = null // { resolve: (got: boolean) => void } | null
function annoChipsBeaconed(count) {
  if (annoChipsWaiter && count > 0) { annoChipsWaiter.resolve(true); annoChipsWaiter = null }
}
async function waitForChipBeacon(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { annoChipsWaiter = null; resolve(false) }, ms)
    annoChipsWaiter = { resolve: (v) => { clearTimeout(timer); resolve(v) } }
  })
}
function annoReturnIfIdle() {
  if (annoFreezeReturn) return // annoSendSync is reading the widget; keep it open
  if (annoReturnTimeout) { clearTimeout(annoReturnTimeout); annoReturnTimeout = null }
  if (!annoReturnToDsh || annoDeletesInFlight > 0) return
  annoReturnToDsh = false
  dshState.log('[anno] return-to-dsh: dshView=' + (dshState.dshView ? 'yes' : 'NO') + ' deletesInFlight=' + annoDeletesInFlight)
  // Switch the secondary sidebar back to the dsh container. `dshView.show(true)`
  // (reveal=true) ACTIVATES the dsh container and shows the view — this is the
  // reliable mechanism. `workbench.view.dsh` is NOT registered in this VS Code
  // build (it throws "command not found"), so it is only a best-effort fallback
  // with the error suppressed (no more log spam).
  const v = dshState.dshView
  if (v && typeof v.show === 'function') {
    try { v.show(true) } catch (e) { dshState.log('[anno] dshView.show failed: ' + String(e)) }
  }
  vscode.commands.executeCommand('workbench.view.dsh').catch(() => { /* not registered; show(true) handled it */ })
  // (0.1.148) hand focus back to the dsh composer — chat.open had stolen it.
  // The client exposes window.__dshrFocusComposer; we poke it via postMessage,
  // once right away and once after the show animation settles.
  const postFocus = () => {
    try {
      const v = dshState.dshView
      if (v && v.webview) v.webview.postMessage({ type: 'dshAnnoFocus' })
    } catch (e) { /* best effort */ }
  }
  postFocus()
  setTimeout(postFocus, 350)
  // (0.1.149) CDP DIRECT PATH: the dsh web app is its own CDP page target
  // (http://127.0.0.1:<port>/...). The client has exported
  // window.__dshrFocusComposer for ages, so we can call it WITHOUT relying on
  // the postMessage channel or a client update. Fire-and-forget.
  const cdpFocus = () => {
    void (async () => {
      const http = require('node:http')
      const WebSocket = require('ws')
      const port = Number(process.env.DSH_CDP_PORT || 9223)
      const targets = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:' + port + '/json', (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } }) }).on('error', reject)
      })
      const base = String(vscode.workspace.getConfiguration('dshReview').get('webviewUrl') || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      const cand = targets.filter((x) => (x.type === 'page' || x.type === 'iframe') && /127\.0\.0\.1:308\d|localhost:308\d/.test(x.url || '') && !/workspace|editor/.test(x.title || ''))
      const pick = cand[0]
      if (!pick) return
      const ws = new WebSocket(pick.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); setTimeout(() => reject(new Error('to')), 1500) })
      await new Promise((resolve) => {
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.__dshrFocusComposer ? (window.__dshrFocusComposer(), "ok") : "no-export"', returnByValue: true } }))
        const h = (d) => { const m = JSON.parse(d.toString()); if (m.id === 1) { ws.off('message', h); resolve() } }
        ws.on('message', h); setTimeout(resolve, 1200)
      })
      try { ws.close() } catch (e) {}
    })().catch(() => { /* best effort */ })
  }
  cdpFocus()
  setTimeout(cdpFocus, 400)
  dshState.log('[anno] returned to dsh view (focus handed back)')
}

/**
 * Debounced flash-back to dsh for the per-beacon (annotation-time) return.
 * Each beacon resets the timer; the view returns to dsh only after `delayMs`
 * with no new annotation. This keeps the Copilot widget visible while the user
 * is actively annotating (fixing the "can't annotate" race) while still
 * auto-returning to dsh once they are done. A re-annotation resets the timer,
 * so a whole batch of annotations is captured before the return.
 */
function scheduleReturnToDsh(delayMs) {
  if (annoFreezeReturn) return // annoSendSync is reading the widget; keep it open
  if (!annoFeatureOn()) return // (0.1.115) toggle off = no flash-back, feature silent
  if (annoReturnDebounce) { clearTimeout(annoReturnDebounce); annoReturnDebounce = null }
  annoReturnDebounce = setTimeout(() => {
    annoReturnDebounce = null
    if (annoDeletesInFlight > 0) return // a delete's finally handles the return
    annoReturnToDsh = true
    annoReturnIfIdle()
  }, delayMs)
}

/** Pull the live Copilot chip+line state via CDP and mirror it (dock + inline). */
async function annoPullState() {
  const driver = dshState.annoDriver
  if (!driver) return
  if (!(await copilotWidgetRendered())) return
  const raw = await driver.eval('window.__dshAnnoWb && window.__dshAnnoWb.getState()')
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw)
      annoMirrorOnState(parsed.chips || [], parsed.lines || [], dshState.logChannel)
    } catch (e) { /* ignore malformed */ }
  }
}

/**
 * Event-driven wait for the chat widget to render in the DOM (triggered by a
 * flash, resolved by the observer beacon — NOT a poll). If the beacon never
 * fires (e.g. the widget was destroyed), a one-shot timeout resolves as a
 * fallback. @returns {Promise<boolean>} true when the widget is rendered
 */
async function waitForWidgetRendered(timeoutMs) {
  if (await copilotWidgetRendered()) return true // already rendered
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok) => { if (!settled) { settled = true; annoWidgetWaiter = null; resolve(ok) } }
    annoWidgetWaiter = { resolve: () => finish(true) }
    setTimeout(() => finish(false), timeoutMs) // one-shot fallback, not a poll
  })
}
/** Called by the observer beacon (onState) to resolve the widget waiter. */
function annoWidgetBeaconed() {
  if (annoWidgetWaiter) { annoWidgetWaiter.resolve(); annoWidgetWaiter = null }
}
/**
 * Flash the Copilot panel open (user-accepted "闪一下"): the chat widget only
 * exists in the DOM while the Copilot view is rendered, so any CDP read/delete
 * of chips needs it visible. Tries known view commands in order.
 * @returns {Promise<string|null>} the command that worked, or null
 */
async function flashCopilot() {
  const candidates = [
    'workbench.action.chat.open',
    'workbench.view.sessions.chat',
    'workbench.action.chat.openNewSessionSidebar.copilotcli',
  ]
  for (const cmd of candidates) {
    try {
      await vscode.commands.executeCommand(cmd)
      dshState.log('[anno] flash copilot: ' + cmd + ' ok')
      return cmd
    } catch (e) {
      dshState.log('[anno] flash copilot: ' + cmd + ' failed: ' + String((e && e.message) || e))
    }
  }
  return null
}

/** Whether the Copilot chat widget is currently rendered in the workbench DOM. */
async function copilotWidgetRendered() {
  const driver = dshState.annoDriver
  if (!driver) return false
  const v = await driver.eval('!!document.querySelector(".chat-attachments-container")')
  return v === true
}

/**
 * Sidebar (re)load resync: the fresh dsh client has an empty dock. If the chat
 * widget is rendered, pull its state directly and mirror it; otherwise flash
 * the Copilot panel once — the observer beacons the fresh state when the
 * widget appears. Event-driven, no polling.
 */
async function annoResync() {
  const driver = dshState.annoDriver
  if (!driver) return
  // The fresh client has an empty composer + empty dock: every known chip must
  // be fully re-mirrored (dock + inline), so drop the bookkeeping and let the
  // next state (pulled below, or beaconed after the flash) re-insert all.
  annoMirrored.clear()
  annoInitialRecorded = true
  if (await copilotWidgetRendered()) {
    await annoPullState()
    return
  }
  dshState.log('[anno] resync: widget not rendered -> flashing copilot')
  annoReturnToDsh = true
  await flashCopilot()
}

/**
 * Real deletion of ONE Copilot element chip: a genuine CDP click on the chip's
 * ✕ (fires Copilot's own _onDidDelete -> attachmentModel.delete -> the native
 * pin is removed and the remaining pins renumber). Bounded, attempt-triggered
 * retries (never a poll). When the chat widget is not rendered (user is in the
 * dsh sidebar), the FIRST no-container failure flashes the Copilot panel and
 * waits (bounded) for the widget to render before retrying. On success it pulls
 * the fresh state (dock + inline sync) and returns to dsh.
 * @param {string} name element name, e.g. "div#count"
 * @returns {Promise<string>} the last deleteChip result
 */
async function realDeleteChip(name) {
  annoDeletesInFlight++
  try {
    return await realDeleteChipInner(name)
  } finally {
    annoDeletesInFlight--
    // Do NOT return to dsh here — the Copilot UI is still updating (the chip
    // is being removed). The observer beacon (which fires after the UI update)
    // triggers the return via annoReturnIfIdle in annoMirrorOnState. If the
    // beacon doesn't fire (widget destroyed), a one-shot timeout below returns.
    if (annoReturnToDsh && annoDeletesInFlight === 0) {
      clearTimeout(annoReturnTimeout)
      annoReturnTimeout = setTimeout(() => annoReturnIfIdle(), 1500)
    }
  }
}
async function realDeleteChipInner(name, attempt, flashed) {
  attempt = attempt || 0
  const driver = dshState.annoDriver
  if (!driver) return 'no-driver'
  let res = 'no-cdp'
  try { res = await driver.deleteChip(name) } catch (e) { res = 'error:' + String((e && e.message) || e) }
  dshState.log('[anno] real delete: ' + name + ' -> ' + res + (attempt ? ' (retry ' + attempt + ')' : ''))
  if (String(res).indexOf('clicked:') === 0) {
    // Chip is gone in Copilot. Do NOT pull state here — the Copilot UI is in a
    // transitional state (the chip is being removed), so getState() returns a
    // stale/transitional state (e.g. 0 chips), which would make the extension
    // post dshRemoveReference for ALL chips. Instead, rely on the observer
    // beacon (which fires after the UI update) to sync the dock + inline. The
    // return-to-dsh is triggered by that beacon (annoReturnIfIdle in
    // annoMirrorOnState).
    annoReturnToDsh = true
    return res
  }
  if (String(res).indexOf('not-found:') === 0) return res
  if (attempt < 4) {
    if (String(res).indexOf('no-container') === 0 && !flashed) {
      dshState.log('[anno] widget not rendered -> flashing copilot before retry')
      annoReturnToDsh = true
      await flashCopilot()
      flashed = true
      await waitForWidgetRendered(2500)
    }
    await new Promise((r) => setTimeout(r, 150))
    return realDeleteChipInner(name, attempt + 1, flashed)
  }
  return res
}
/** Clear the Copilot chat input (Monaco editor) via CDP keyboard events. */
async function clearCopilotInput() {
  const driver = dshState.annoDriver
  if (!driver || !driver.cdp) return 'no-driver'
  try {
    // (0.1.127) PRIMARY clear: in-page execCommand on the focused editor.
    const exec = await driver.eval(`(function () {
      var ed = document.querySelector('.interactive-input-editor');
      if (!ed) return 'no-editor';
      var ta = ed.querySelector('textarea');
      if (ta) { ta.focus(); } else { ed.focus(); }
      var before = ed.querySelectorAll('.view-line').length;
      var ok = false;
      try { ok = document.execCommand('selectAll', false, null); } catch (e) { ok = false; }
      if (!ok) { try { if (ta) ta.select(); } catch (e) {} }
      try { document.execCommand('delete', false, null); } catch (e) { return 'exec-fail:' + e.message; }
      var after = ed.querySelectorAll('.view-line').length;
      return 'cleared:exec ' + before + '->' + after;
    })()`)
    // (0.1.127) Keyboard backstop.
    await driver.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
    await driver.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
    await driver.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await driver.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    // (0.1.128) MODEL-level backstop: both DOM paths above failed against the
    // 3 zombie draft lines (exec 3->3, keys ignored — 08:37 round). The
    // official chat.open command with { query, isPartialQuery:true } runs
    // chatWidget.setInput(query) (verified in vscode chatActions.ts source),
    // replacing the InputModel content directly — the zombie lines die in the
    // MODEL, so no reopen-restore can resurrect them. One space is the payload;
    // a final Backspace attempt removes even that.
    const still = await driver.eval(`(function () {
      var ed = document.querySelector('.interactive-input-editor');
      if (!ed) return 'gone';
      var ls = ed.querySelectorAll('.view-line');
      var t = ''; for (var i = 0; i < ls.length; i++) t += (ls[i].textContent || '').trim();
      return t ? 'lines:' + ls.length : 'empty';
    })()`)
    let viaCmd = ''
    if (still && String(still).indexOf('lines:') === 0) {
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: ' ', isPartialQuery: true })
        await driver.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
        await driver.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
        viaCmd = ' +setInput'
      } catch (e) { viaCmd = ' +setInput-fail:' + String(e && e.message || e).slice(0, 60) }
    }
    return String(exec || 'cleared') + viaCmd + ' check:' + String(still)
  } catch (e) { return 'err:' + String(e) }
}
/**
 * (0.1.122) Clear + ONE bounded verification pass: read the rendered editor
 * lines; if anything survived, clear once more and re-check. Event/settle
 * based (single 150ms settle), never a poll. Used by BOTH input-clear sites:
 * ① dsh send (annoSendSync) and ② VS Code reload (startup block) — both are
 * gated on the dsh 设置 toggle (annotationToDsh) being ON.
 * @param {vscode.OutputChannel} log
 * @param {string} tag
 * @returns {Promise<string>}
 */
async function clearCopilotInputVerified(log, tag) {
  const driver = dshState.annoDriver
  const readInput = '(function(){var ed=document.querySelector(".interactive-input-editor");if(!ed)return "no-editor";var out="";var ls=ed.querySelectorAll(".view-line");for(var i=0;i<ls.length;i++){var t=(ls[i].textContent||"").trim();if(t)out+=t+" | ";}return out;})()'
  let r = await clearCopilotInput()
  let txt = driver ? await driver.eval(readInput) : 'no-driver'
  if (typeof txt === 'string' && txt && txt !== 'no-editor') {
    await new Promise((s) => setTimeout(s, 150))
    r = await clearCopilotInput()
    txt = await driver.eval(readInput)
  }
  log.appendLine('[' + tag + '] input clear=' + r + ' verify=' + (txt === '' ? 'EMPTY' : JSON.stringify(String(txt).slice(0, 120))))
  return r
}

/**
 * The OFFICIAL Copilot clear: 'workbench.action.chat.newChat' (Ctrl+L) runs
 * widget.setInput('') which resets the session's InputModel — the text lines AND
 * the element attachment chips. Keyboard/DOM clearing only wipes the rendered
 * editor; the InputModel re-populates it on re-render (the leftover bug). This
 * command clears the persistent state, so the widget comes back truly empty.
 * Must run while the chat widget is focused/visible (lastFocusedWidget).
 */
async function clearCopilotSession() {
  try {
    await vscode.commands.executeCommand('workbench.action.chat.newChat')
    return 'newChat ok'
  } catch (e) {
    return 'newChat failed: ' + String((e && e.message) || e)
  }
}
/**
 * Consume ALL: the dsh draft was sent or manually cleared -> real-click every
 * remaining Copilot annotation chip away. Idempotent: the list is snapshotted
 * and cleared up front, so a double consume is a no-op.
 * @returns {Promise<number>} how many chips were targeted
 */
async function realDeleteAllChips() {
  const names = annoCurrentChips.map((c) => c.name)
  annoCurrentChips = []
  if (!names.length) return 0
  await Promise.all(names.map((n) => realDeleteChip(n)))
  return names.length
}

/**
 * Send-time sync: when the user sends a message in dsh, flash Copilot once,
 * capture ALL chips + comment lines, print with [trump], then clear all chips.
 * Strict order: ① capture → ② clear → ③ (user sends normally, no insertion yet).
 * Idempotent: empty → annotate → capture+clear → empty; next round.
 */
/**
 * (0.1.115) Diagnostic demanded by the user: when a read comes back empty,
 * dump the actual Copilot widget DOM (bounded one-shot CDP eval, never a
 * poll) so the log shows what is REALLY on screen at that instant.
 * @param {object} driver
 * @param {vscode.OutputChannel} log
 */
async function dumpCopilotDom(driver, log) {
  try {
    const html = await driver.eval(
      '(() => {' +
      '  const c = document.querySelectorAll(".chat-attached-context-attachment");' +
      '  const arias = []; for (var i = 0; i < c.length; i++) arias.push(c[i].getAttribute("aria-label") || "(none)");' +
      '  const p = document.querySelector(".interactive-input-part");' +
      '  return JSON.stringify({' +
      '    container: !!document.querySelector(".chat-attachments-container"),' +
      '    inputPart: !!p,' +
      '    attachments: c.length,' +
      '    arias: arias,' +
      '    html: p ? p.outerHTML.slice(0, 4000) : "(no .interactive-input-part)"' +
      '  });' +
      '})()')
    log.appendLine('[trump] DOM dump >>> ' + String(html).slice(0, 4600))
  } catch (e) {
    log.appendLine('[trump] DOM dump failed: ' + String(e))
  }
}

/**
 * (0.1.126) ① Read each element chip's full context via SYNTHETIC hover —
 * and click NOTHING at all.
 *
 * Hard rules (user's screenshots as evidence):
 *  - Clicking the CHIP opens "Attached Element Context from Integrated
 *    Browser" as an UNSAVED Untitled-1 editor — absolutely forbidden
 *    (closing it triggers a save prompt).
 *  - Clicking "Show More..." INSIDE the hover opens the SAME editor (the
 *    08:20 round proved it: ctx text:"" + the Untitled tab) — so we do NOT
 *    click it either. We read the hover textContent as rendered (every
 *    section; the CSS block ends at the literal "Show More..." marker).
 *  - Input.dispatchMouseEvent moves the PHYSICAL cursor (native popups can
 *    appear at the pointer) — forbidden. Pure JS dispatchEvent
 *    (pointerover/mouseover/mousemove) opens the delayed-hover with zero
 *    real mouse movement. Verified live 08:24: 697 chars for span#mv-temp.
 * Chips are targeted by INDEX (duplicate names — two "div" chips — broke the
 * old aria-equality lookup with <<no-chip>>).
 * @returns {Promise<Array<{name: string, text: string}>>}
 */
async function copilotChipFullContexts(onlyIdx) {
  const log = dshState.logChannel
  const driver = dshState.annoDriver
  if (!driver || !driver.cdp) return []
  const listRaw = await driver.eval(
    '(() => { var out = []; var chips = document.querySelectorAll(".chat-attached-context-attachment");' +
    ' for (var i = 0; i < chips.length; i++) { var a = chips[i].getAttribute("aria-label") || "";' +
    ' if (a.indexOf("Attached element,") !== 0) continue;' +
    ' out.push({ name: a.slice(18, a.length - 9) }); }' +
    ' return JSON.stringify(out); })()')
  let chips = []
  try { chips = JSON.parse(String(listRaw || '[]')) } catch (e) { return [] }
  const out = []
  // chrome-remote-interface resolves the RESULT payload directly; raw ws
  // scripts see {id,result:{result:...}}. Accept both (the 0.1.124/125
  // "<<no-value>>" mystery was exactly this nesting mismatch).
  const unwrap = (r) => (r && r.result && r.result.result ? r.result : r)
  // (0.1.167) gated by dsh settings showHoverCard (default true = do not
  // touch anything; the card shows natively). Only when OFF we arm the
  // hidden-card observer for the read window.
  // (0.1.166) USER-APPROVED EXCEPTION: the synthetic hover still FIRES the
  // Copilot hover card — we now HIDE it visually (visibility:hidden keeps the
  // DOM rendered & readable, our poll only checks display/offsetParent).
  // A MutationObserver arms for the read window only and is disconnected in
  // the finally; every node we tag is un-tagged the same way. No stylesheet
  // or rule of Copilot's is touched — only inline styles on the transient
  // hover nodes, removed afterwards.
  if (!annoHoverCardVisible()) await driver.eval(
    '(() => { window.__dshrHideHoverFix = window.__dshrHideHoverFix || function () {' +
    ' var all = document.querySelectorAll(".context-view,.monaco-hover,[role=tooltip]");' +
    ' for (var i = 0; i < all.length; i++) { var h = all[i];' +
    ' if (h.getAttribute("data-dshr-hidden") !== "1") { h.setAttribute("data-dshr-hidden", "1"); h.style.visibility = "hidden"; } } };' +
    ' if (!window.__dshrHoverHide) { window.__dshrHoverHide = new MutationObserver(window.__dshrHideHoverFix);' +
    ' window.__dshrHoverHide.observe(document.body, { childList: true, subtree: true }); }' +
    ' window.__dshrHideHoverFix(); return "armed"; })()')
  try {
  for (let idx = 0; idx < chips.length; idx++) {
    const chip = chips[idx]
    // (0.1.139) onlyIdx: chips already page-rebuilt skip the hover entirely
    // (null placeholder keeps the array aligned by INDEX with the DOM order).
    if (Array.isArray(onlyIdx) && onlyIdx.indexOf(idx) === -1) { out.push({ name: chip.name, text: null }); continue }
    try {
      const hoverIn = (dy) =>
        '(() => { var chips = document.querySelectorAll(".chat-attached-context-attachment");' +
        ' var el = null, n = 0; for (var i = 0; i < chips.length; i++) {' +
        ' if ((chips[i].getAttribute("aria-label") || "").indexOf("Attached element,") === 0) { if (n === ' + idx + ') { el = chips[i]; break; } n++; } }' +
        ' if (!el) return "no-chip";' +
        ' var r = el.getBoundingClientRect();' +
        ' var o = { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + r.height / 2 + (' + dy + '), view: window, buttons: 0 };' +
        ' el.dispatchEvent(new PointerEvent("pointerover", Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true }, o)));' +
        ' el.dispatchEvent(new MouseEvent("mouseover", o));' +
        ' el.dispatchEvent(new MouseEvent("mousemove", o));' +
        ' return "hovered"; })()'
      const hov = await driver.eval(hoverIn(0))
      if (hov !== 'hovered') { out.push({ name: chip.name, text: '<<' + String(hov) + '>>' }); continue }
      // (0.1.138) BACK to 0.1.135's proven timing: the micro-move must be
      // dispatched from the EXTENSION HOST (its sleep is immune to renderer
      // load), not from an in-page setTimeout — 0.1.136/137 both timed out
      // 3/3 chips at 09:14/09:15 because the busy workbench delayed the
      // in-page timer and the hover never armed. Only kept wins: 80ms poll
      // granularity and skipping the dismiss after the LAST chip.
      await new Promise((r) => setTimeout(r, 400))
      await driver.eval(hoverIn(-1))
      const expr = 'new Promise((resolve) => {' +
        ' var NAME = ' + JSON.stringify(chip.name) + ';' +
        ' var vis = function () { var all = document.querySelectorAll(".context-view,.monaco-hover,[role=tooltip]"); var best = null;' +
        ' for (var i = 0; i < all.length; i++) { var h = all[i]; var cs = getComputedStyle(h);' +
        ' if (cs.display === "none" || !h.offsetParent) continue; var t = (h.textContent || "").trim();' +
        // (0.1.129) must be the ELEMENT hover — other context-views (generic
        // "Structured browser element context…" blurbs) also pop; the 08:41
        // round captured one of those for span#mv-temp. Require section markers.
        ' if (!/KEY COMPUTED STYLES|POSITION & SIZE|INNER TEXT|HTML PATH/.test(t)) continue;' +
        ' if (t.length > 30 && (!best || t.length > best.textContent.length)) best = h; } return best; };' +
        ' var t0 = Date.now(); var lastLen = -1; var stableAt = 0;' +
        ' var step = function () { var h = vis();' +
        ' if (h) { var SHOT = null; try { var im = h.querySelector("img");' +
        ' if (im && (im.naturalWidth || im.width)) { var cv = document.createElement("canvas");' +
        ' cv.width = im.naturalWidth || im.width; cv.height = im.naturalHeight || im.height;' +
        ' cv.getContext("2d").drawImage(im, 0, 0); SHOT = cv.toDataURL("image/png").slice(22); } } catch (e6) {}' +
        ' var txt = (h.textContent || "").slice(0, 12000);' +
        // (0.1.172) the card renders PROGRESSIVELY: first-hit reads returned a
        // ~900B fragment (user: 裸tag抓的不全, vs 14KB page file). Now wait for
        // the LAST section (INNER TEXT) AND a 240ms length-stable settle,
        // bounded at 2.5s, then take the finished card.
        ' if (!h.getAttribute("data-dshr-scrolled")) { h.setAttribute("data-dshr-scrolled", "1");' +
        ' try { h.scrollTop = h.scrollHeight; var kids = h.querySelectorAll("*");' +
        ' for (var q = 0; q < kids.length; q++) { try { kids[q].scrollTop = kids[q].scrollHeight; } catch (e7) {} } } catch (e8) {}' +
        ' lastLen = -1; setTimeout(step, 120); return; }' +
        ' var done = txt.indexOf("INNER TEXT") !== -1;' +
        ' if (done && txt.length === lastLen && Date.now() - stableAt > 240) { resolve(JSON.stringify({ name: NAME, text: txt, shot: SHOT })); return; }' +
        ' if (txt.length !== lastLen) { lastLen = txt.length; stableAt = Date.now(); }' +
        ' if (Date.now() - t0 > 4000) { resolve(JSON.stringify({ name: NAME, text: txt, shot: SHOT, partial: !done })); return; } }' +
        ' setTimeout(step, 80); };' +
        ' step(); })'
      let r = await driver.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      // (0.1.146) one bounded retry: monaco's delayed-hover occasionally
      // exceeds 1.5s while the panel tab is being switched under freeze
      // (09:35 round: 2/3 timeouts, 3rd chip fine). Re-hover + re-wait once;
      // still nothing -> report the timeout honestly in the file.
      const timedOut = (res) => { const q = unwrap(res); const v = q && q.result ? q.result.value : null; return typeof v === 'string' && v.indexOf('timeout') !== -1 }
      if (timedOut(r)) {
        await driver.eval(hoverIn(0))
        await new Promise((rz) => setTimeout(rz, 300))
        await driver.eval(hoverIn(-1))
        r = await driver.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
        log.appendLine('[trump] hover retry @' + chip.name + (timedOut(r) ? ' -> still timeout' : ' -> ok'))
      }
      const rr = unwrap(r)
      if (rr && rr.exceptionDetails) {
        out.push({ name: chip.name, text: '<<eval-error: ' + String((rr.exceptionDetails.exception && rr.exceptionDetails.exception.description) || rr.exceptionDetails.message || '?').slice(0, 160) + '>>' })
      } else {
        const val = rr && rr.result ? rr.result.value : null
        let parsed = null
        try { parsed = JSON.parse(String(val)) } catch (e) { /* ignore */ }
        out.push(parsed || { name: chip.name, text: '<<no-value: ' + JSON.stringify(rr).slice(0, 200) + '>>' })
      }
      // dismiss the hover (synthetic mouseout — still no click) before the next chip
      if (idx < chips.length - 1) {
        await driver.eval(
          '(() => { var chips = document.querySelectorAll(".chat-attached-context-attachment");' +
          ' var el = null, n = 0; for (var i = 0; i < chips.length; i++) {' +
          ' if ((chips[i].getAttribute("aria-label") || "").indexOf("Attached element,") === 0) { if (n === ' + idx + ') { el = chips[i]; break; } n++; } }' +
          ' if (!el) return "gone"; var r = el.getBoundingClientRect();' +
          ' var o = { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + r.height / 2, view: window, buttons: 0 };' +
          ' el.dispatchEvent(new PointerEvent("pointerout", Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true }, o)));' +
          ' el.dispatchEvent(new MouseEvent("mouseout", o));' +
          ' return "out"; })()')
        await new Promise((r) => setTimeout(r, 60))
      }
    } catch (e) {
      out.push({ name: chip.name, text: '<<exception: ' + String(e).slice(0, 120) + '>>' })
    }
  }
  } finally {
    await driver.eval(
      '(() => { if (window.__dshrHoverHide) { window.__dshrHoverHide.disconnect(); delete window.__dshrHoverHide; }' +
      ' var all = document.querySelectorAll("[data-dshr-hidden]");' +
      ' for (var i = 0; i < all.length; i++) { all[i].style.visibility = ""; all[i].removeAttribute("data-dshr-hidden"); }' +
      ' delete window.__dshrHideHoverFix; return "cleared"; })()').catch(() => {})
  }
  return out
}

/** Deterministic per-occurrence key for a chip (duplicate bare tags). */
function annoChipKeys(chips) {
  const counts = new Map()
  return chips.map((c) => {
    // (0.1.173) identity = name + occurrence ONLY. Comment text joins and
    // LEFT the key when edited (12:21 round: placeholder written under
    // 'span||1', send saw 'span|idea|1' -> fill loop never fired).
    const base = c.name
    const n = (counts.get(base) || 0) + 1
    counts.set(base, n)
    return base + '|' + n
  })
}

/** Write one annotation file; returns the absolute path (or null). */
/**
 * (0.1.178) Heap-Bridge send path (user ruling: read the MAP, never the
 * hover projection). lib/anno-heap.js finds the live attachment entries in
 * the workbench heap; here we pair them with the DOM chips (exact name incl.
 * #id segment; bare tag matches only id-less elements; newest entry id wins)
 * and write the file with the entry's FULL official value + screenshot bytes.
 * Screenshot ATTACHMENTS (kind:'image', "Browser Screenshot"/"Area") are a
 * freebie of the same scan and land as extra files listed in the block.
 */
function annoHeapOn() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'review', 'shadow', 'settings.json'), 'utf8'))
    return raw.annoHeapBridge !== false
  } catch (e) { return true }
}
let annoHeapShots = [] // attachment screenshot files collected this send
function annoHeapElLine(E) {
  const l = String(E.value || '').split('\n').find((x) => x.indexOf('Element:') === 0) || ''
  return l.slice(9).trim()
}
function annoHeapPick(name, entries, used) {
  const nm = String(name || '').trim()
  const hash = nm.indexOf('#')
  const tag = hash === -1 ? nm : nm.slice(0, hash)
  const idPart = hash === -1 ? null : nm.slice(hash + 1).split(/[.\s]/)[0]
  let best = null
  for (const E of entries) {
    if (!E || used.has(E.id)) continue
    const el = annoHeapElLine(E)
    if (el.split(/[#.\s]/)[0] !== tag) continue
    const elHash = el.indexOf('#')
    if (idPart) { if (elHash === -1 || el.slice(elHash + 1).split(/[.\s]/)[0] !== idPart) continue }
    else if (elHash !== -1) continue
    if (!best || String(E.id) > String(best.id)) best = E
  }
  return best
}
function annoWriteHeapFile(i, name, comment, E, keepPath) {
  const log = dshState.logChannel
  try {
    const dir = path.join(os.tmpdir(), 'dsh-trump')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const safe = String(name).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40)
    const f = keepPath || path.join(dir, stamp + '-' + (i + 1) + '-' + safe + '.txt')
    let imgRef = ''
    if (E.img) {
      const ext = String(E.mime || '').indexOf('png') !== -1 ? '.png' : '.jpg'
      const ip = f.replace(/\.txt$/, '') + ext
      fs.writeFileSync(ip, Buffer.from(E.img, 'base64'))
      imgRef = '## SCREENSHOT (pick-time, ' + (E.imgLen || 0) + 'B)\n文件: ' + ip + '\n\n'
    }
    const head = '# element: ' + (E.fullName || E.name || name) +
      '\n# comment: ' + (comment || '') +
      '\n# time: ' + new Date().toString() +
      '\n# entry id: ' + (E.id || '') +
      '\n# via: dsh-review (heap-bridge, no hover)\n\n' + imgRef
    fs.writeFileSync(f, head + E.value + '\n')
    log.appendLine('[trump] heap file: ' + f + ' (' + String(E.value).length + 'B value' + (E.img ? ', img ' + E.imgLen + 'B' : '') + ')')
    return f
  } catch (e) { log.appendLine('[trump] heap file write failed: ' + String(e).slice(0, 100)); return null }
}
async function annoHeapCaptureNow() {
  const log = dshState.logChannel
  let prefer = ''
  try { prefer = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] && vscode.workspace.workspaceFolders[0].name) || '' } catch (e) { /* noop */ }
  return annoHeap.capture({ preferTitle: prefer, log })
}
function annoHeapPairFill(chips, keysSend, data) {
  const log = dshState.logChannel
  const used = new Set()
  annoHeapShots = []
  const out = chips.map((c, i) => {
    const E = annoHeapPick(c.name, data.entries, used)
    if (!E) return { name: c.name, text: null, source: 'heap-miss', file: annoCaptureFiles.get(keysSend[i]) || null, shot: null }
    used.add(E.id)
    const keep = annoCaptureFiles.get(keysSend[i]) || null
    const f = annoWriteHeapFile(i, c.name, (chips[i] && chips[i].text) || '', E, keep)
    if (f) { annoCaptureFiles.set(keysSend[i], f); annoPendingFullKeys.delete(keysSend[i]) }
    return { name: c.name, text: E.value, source: 'heap', file: f, shot: null }
  })
  const dir = path.join(os.tmpdir(), 'dsh-trump')
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) { /* noop */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  // (0.1.182) each attachment appears MULTIPLE times in the heap (input model
  // + session copies); some copies carry 0 bytes. Keep only the BEST copy per
  // attachment NAME (max byte length, non-zero) and write it once — the old
  // naive loop let a 0-byte twin overwrite the real 163KB screenshot.
  const best = new Map()
  for (const I of data.images || []) {
    if (!I || !I.len || !I.b) continue
    const key = String(I.name || 'image')
    const prev = best.get(key)
    if (!prev || I.len > prev.len) best.set(key, I)
  }
  for (const [key, I] of best) {
    try {
      const safe = key.replace(/[^a-zA-Z0-9_ -]+/g, '_').replace(/\s+/g, '_').slice(0, 40)
      const ext = String(I.mime || '').indexOf('png') !== -1 ? '.png' : '.jpg'
      const p = path.join(dir, stamp + '-shot-' + safe + ext)
      fs.writeFileSync(p, Buffer.from(I.b, 'base64'))
      annoHeapShots.push(p)
      log.appendLine('[trump] heap shot: ' + p + ' (' + I.len + 'B)')
    } catch (e) { log.appendLine('[trump] heap shot failed: ' + String(e).slice(0, 90)) }
  }
  log.appendLine('[trump] heap paired: ' + out.filter((x) => x.source === 'heap').length + '/' + chips.length + ' chip(s), ' + annoHeapShots.length + ' attachment shot(s)')
  return out
}

function annoWriteFile(i, name, comment, text, via) {
  const log = dshState.logChannel
  try {
    const dir = path.join(os.tmpdir(), 'dsh-trump')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const safe = String(name).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40)
    const f = path.join(dir, stamp + '-' + (i + 1) + '-' + safe + '.txt')
    const head = '# element: ' + name +
      '\n# comment: ' + (comment || '') +
      '\n# time: ' + new Date().toString() +
      '\n# via: dsh-review (' + (via || 'send') + ')\n\n'
    fs.writeFileSync(f, head + (text == null ? '(no context captured)' : text))
    log.appendLine('[trump] file: ' + f)
    return f
  } catch (e) { log.appendLine('[trump] file write failed: ' + String(e).slice(0, 100)); return null }
}

/**
 * (0.1.168) FULL element context — all 7 Copilot hover-card blocks, page-side:
 * SCREENSHOT (png via CDP clip) / URL / ELEMENT / ATTRIBUTES / INNER TEXT /
 * POSITION & SIZE / KEY COMPUTED STYLES (full resolved, no Show-More cap) /
 * MATCHED RULES / VARIABLES / HTML PATH.
 * Locator: {sel} for unique ids; {tag, rect:{t,l,w,h}} for bare tags located
 * through the hover card's POSITION & SIZE (rect equality, ±1.5px).
 */
const FULL_CTX_BUILDER = (loc) =>
  '(() => {' +
  ' var L = ' + JSON.stringify(loc) + ';' +
  ' var node = null;' +
  ' if (L.sel) { try { node = document.querySelector(L.sel); } catch (e0) {} }' +
  ' else if (L.rect) { var cands = Array.prototype.slice.call(document.querySelectorAll(L.tag || "*"));' +
  ' for (var i2 = 0; i2 < cands.length; i2++) { var el = cands[i2]; var r0 = el.getBoundingClientRect();' +
  ' if (Math.abs(r0.top - L.rect.t) < 1.5 && Math.abs(r0.left - L.rect.l) < 1.5 && Math.abs(r0.width - L.rect.w) < 1.5 && Math.abs(r0.height - L.rect.h) < 1.5) { node = el; break; } } }' +
  ' if (!node) return JSON.stringify({ err: "node-not-found" });' +
  ' var cs = getComputedStyle(node); var styles = []; var vars = [];' +
  ' for (var k = 0; k < cs.length; k++) { var pr = cs[k]; var pv = cs.getPropertyValue(pr).trim();' +
  ' if (pr.indexOf("--") === 0) { if (pv) vars.push(pr + ": " + pv); } else styles.push(pr + ": " + pv); }' +
  ' var attrs = []; for (var a = 0; a < node.attributes.length; a++) attrs.push(node.attributes[a].name + ": " + node.attributes[a].value);' +
  ' var rules = []; try { var sheets = document.styleSheets;' +
  ' for (var s2 = 0; s2 < sheets.length && rules.length < 150; s2++) { var rr; try { rr = sheets[s2].cssRules; } catch (e3) { continue; } if (!rr) continue;' +
  ' for (var c2 = 0; c2 < rr.length; c2++) { var ru = rr[c2]; if (ru.selectorText) { try { if (node.matches(ru.selectorText)) rules.push(ru.selectorText + " { " + ru.style.cssText + " }"); } catch (e4) {} } } } } catch (e5) {}' +
  ' var pathArr = []; var cur = node;' +
  ' while (cur && cur.tagName && pathArr.length < 30) { var nm = cur.tagName.toLowerCase();' +
  ' if (cur.id) nm += "#" + cur.id; else if (cur.className && typeof cur.className === "string" && cur.className.trim()) nm += "." + cur.className.trim().split(/\\s+/).join(".");' +
  ' pathArr.unshift(nm); cur = cur.parentElement; }' +
  ' var r3 = node.getBoundingClientRect();' +
  ' return JSON.stringify({ url: location.href,' +
  ' outer: (node.outerHTML || "").slice(0, 6000),' +
  ' attrs: attrs.join("\\n"),' +
  ' inner: (node.innerText || node.textContent || "").trim().slice(0, 3000),' +
  ' top: Math.round(r3.top), left: Math.round(r3.left), width: Math.round(r3.width), height: Math.round(r3.height),' +
  ' vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,' +
  ' styles: styles.join("\\n"), vars: vars.join("\\n"), rules: rules.join("\\n"),' +
  ' path: pathArr.join(" > ") });' +
  '})()'

/** (0.1.170) THE full-context target = the ANNOTATED PAGE (NInfer), exactly
 *  like rebuildContextFromPage: fresh ws to the first http page target that is
 *  NOT the dsh webapp. The annoDriver is the Copilot WORKBENCH page — where
 *  #ms-gpu and the recorded rects simply do not exist (12:13 full-diag). */
async function annoPageTargets() {
  const http = require('node:http')
  const port = Number(process.env.DSH_CDP_PORT || 9223)
  const targets = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + port + '/json', (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
  return targets.filter((x) => (x.type === 'page' || x.type === 'iframe') && /^https?:/.test(x.url || '') && !/127\.0\.0\.1:308\d/.test(x.url || ''))
}
async function annoPageEval(expression) {
  const WebSocket = require('ws')
  try {
    const pages = await annoPageTargets()
    if (!pages.length) return null
    const ws = await new Promise((resolve, reject) => { const s = new WebSocket(pages[0].webSocketDebuggerUrl); s.on('open', () => resolve(s)); s.on('error', reject) })
    const val = await new Promise((resolve) => {
      const onData = (raw) => { const m = JSON.parse(raw.toString()); if (m.id === 1) { ws.off('message', onData); resolve(m.result && m.result.result ? m.result.result.value : null) } }
      ws.on('message', onData)
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
      setTimeout(() => { ws.off('message', onData); resolve(null) }, 4000)
    })
    try { ws.close() } catch (e) { /* noop */ }
    return val
  } catch (e) { return null }
}
async function annoPageShot(clip) {
  const WebSocket = require('ws')
  try {
    const pages = await annoPageTargets()
    if (!pages.length) return null
    const ws = await new Promise((resolve, reject) => { const s = new WebSocket(pages[0].webSocketDebuggerUrl); s.on('open', () => resolve(s)); s.on('error', reject) })
    const data = await new Promise((resolve) => {
      let enabled = false
      const onData = (raw) => {
        const m = JSON.parse(raw.toString())
        if (m.id === 1) { enabled = true; ws.send(JSON.stringify({ id: 2, method: 'Page.captureScreenshot', params: { format: 'png', clip: Object.assign({ scale: 1 }, clip) } })) }
        else if (m.id === 2) { ws.off('message', onData); resolve((m.result && m.result.data) || null) }
      }
      ws.on('message', onData)
      ws.send(JSON.stringify({ id: 1, method: 'Page.enable', params: {} }))
      setTimeout(() => { ws.off('message', onData); resolve(null) }, 4000)
      void enabled
    })
    try { ws.close() } catch (e) { /* noop */ }
    return data
  } catch (e) { return null }
}

async function annoElementFullData(loc) {
  const log = dshState.logChannel
  try {
    const raw = await annoPageEval(FULL_CTX_BUILDER(loc))
    if (raw === null || raw === undefined) { log.appendLine('[trump] full-diag: eval null for ' + JSON.stringify(loc).slice(0, 90)); return null }
    let data = null
    try { data = typeof raw === 'object' ? raw : JSON.parse(String(raw)) }
    catch (err) { log.appendLine('[trump] full-diag: parse failed for ' + JSON.stringify(loc).slice(0, 90) + ' raw=' + String(raw).slice(0, 140)); return null }
    if (!data || data.err) { log.appendLine('[trump] full-diag: ' + JSON.stringify(loc).slice(0, 90) + ' -> ' + String(data && data.err || 'no-data').slice(0, 60)); return null }
    return data
  } catch (err) { log.appendLine('[trump] full-diag: eval threw ' + String(err).slice(0, 120)); return null }
}

function annoFormatFull(data, pngPath) {
  return '## SCREENSHOT\n' + (pngPath ? '文件: ' + pngPath : '(未取到)') +
    '\n\n## URL\n' + data.url +
    '\n\n## ELEMENT (Outer HTML)\n' + data.outer +
    '\n\n## ATTRIBUTES\n' + (data.attrs || '(无)') +
    '\n\n## INNER TEXT\n' + (data.inner || '(空)') +
    '\n\n## POSITION & SIZE\ntop: ' + data.top + 'px | left: ' + data.left + 'px | width: ' + data.width + 'px | height: ' + data.height + 'px\nviewport: ' + data.vw + 'x' + data.vh + ' @ dpr ' + data.dpr +
    '\n\n## MATCHED CSS RULES\n' + (data.rules || '(无匹配)') +
    '\n\n## HTML PATH\n' + data.path
}

/** Write full-context file (+ sibling png when shot succeeds). keepPath =
 *  overwrite an ALREADY-published reserved path (message paths stay valid). */
async function annoWriteFull(i, name, comment, data, via, keepPath) {
  const log = dshState.logChannel
  try {
    let base
    if (keepPath) base = keepPath.replace(/\.txt$/, '')
    else {
      const dir = path.join(os.tmpdir(), 'dsh-trump')
      fs.mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const safe = String(name).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40)
      base = path.join(dir, stamp + '-' + (i + 1) + '-' + safe)
    }
    let png = ''
    try {
      const b64 = await annoPageShot({ x: Math.max(0, data.left - 8), y: Math.max(0, data.top - 8), width: Math.max(1, data.width + 16), height: Math.max(1, data.height + 16) })
      if (b64) { fs.writeFileSync(base + '.png', Buffer.from(b64, 'base64')); png = base + '.png' }
    } catch (e) { log.appendLine('[trump] shot failed @' + name + ': ' + String(e).slice(0, 80)) }
    const f = base + '.txt'
    const head = '# element: ' + name +
      '\n# comment: ' + (comment || '') +
      '\n# time: ' + new Date().toString() +
      '\n# via: dsh-review (' + (via || 'send') + ')\n\n'
    fs.writeFileSync(f, head + annoFormatFull(data, png))
    log.appendLine('[trump] full: ' + f + (png ? ' + png' : ' (no png)'))
    return f
  } catch (e) { log.appendLine('[trump] full write failed: ' + String(e).slice(0, 90)); return null }
}

/** (0.1.177) THE one and only hover-card -> file writer: strip the retired
 *  KEY COMPUTED STYLES chunk, save the card's SCREENSHOT img as a sibling
 *  .png when present, reference it on top. keepPath overwrites an existing
 *  (reserved) path so published message paths never rot. */
async function annoWriteCardFile(i, name, comment, t, shot, keepPath) {
  const log = dshState.logChannel
  try {
    let base
    if (keepPath) base = keepPath.replace(/\.txt$/, '')
    else {
      const dir = path.join(os.tmpdir(), 'dsh-trump')
      fs.mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const safe = String(name).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40)
      base = path.join(dir, stamp + '-' + (i + 1) + '-' + safe)
    }
    let pngRef = ''
    if (shot) {
      try {
        fs.writeFileSync(base + '.png', Buffer.from(String(shot), 'base64'))
        pngRef = '## SCREENSHOT\n文件: ' + base + '.png\n\n'
        log.appendLine('[trump] card shot: ' + base + '.png')
      } catch (err) { log.appendLine('[trump] card shot failed: ' + String(err).slice(0, 80)) }
    }
    const t2 = String(t).replace(/KEY COMPUTED STYLES[\s\S]*?HTML PATH/, '(computed styles omitted) HTML PATH')
    log.appendLine('[trump] card text: ' + String(t).length + ' chars (INNER TEXT: ' + (String(t).indexOf('INNER TEXT') !== -1 ? 'y' : 'n') + ')')
    const f = base + '.txt'
    const head = '# element: ' + name +
      '\n# comment: ' + (comment || '') +
      '\n# time: ' + new Date().toString() +
      '\n# via: dsh-review (hover-card)\n\n'
    fs.writeFileSync(f, head + pngRef + t2)
    return f
  } catch (err) { log.appendLine('[trump] card write failed: ' + String(err).slice(0, 90)); return null }
}

/** hover-card text -> rect locator (POSITION & SIZE block, whitespace-collapsed). */
function annoHoverLoc(text) {
  try {
    const t = String(text)
    const tag = /ELEMENT\s*<\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(t)
    const pos = /top:\s*([\d.]+)px\s*left:\s*([\d.]+)px\s*width:\s*([\d.]+)px\s*height:\s*([\d.]+)px/.exec(t)
    if (!pos) return null
    return { tag: tag ? tag[1].toLowerCase() : '*', rect: { t: +pos[1], l: +pos[2], w: +pos[3], h: +pos[4] } }
  } catch (e) { return null }
}
function annoIdSel(name) {
  const m = /#([A-Za-z0-9_:-]+)/.exec(String(name))
  return m ? '#' + m[1] : null
}

/** Push the {name, comment, file} dock list = dsh-annotate's local pending mirror. */
function annoPushDockList() {
  const log = dshState.logChannel
  try {
    const keys = annoChipKeys(annoCurrentChips)
    const dock = annoCurrentChips.map((c, i) => ({ key: keys[i], name: c.name, text: c.text || '', file: annoCaptureFiles.get(keys[i]) || null }))
    const j = JSON.stringify(dock)
    if (j !== annoDockJsonLast) { annoDockJsonLast = j; void sendAnnoDock(dock) }
  } catch (e) { log.appendLine('[anno] dock push failed: ' + String(e).slice(0, 100)) }
}

/**
 * (0.1.179) TOGGLE-RESYNC: the feature-on gate in annoMirrorOnState skips
 * reservations while annotationToDsh is off; re-enabling the toggle produced
 * NO new beacon (Copilot state unchanged) -> the dsh dock stayed chips=0 and
 * sends bypassed the whole capture ("我标注了, copilot有, 但没带上"). Fix: the
 * beacon handler calls this on EVERY state message (deduped inside); once the
 * feature is on it re-runs the reservation for all current chips.
 */
let annoResyncDone = ''
function annoResyncIfOn(chips, lines, log) {
  if (!annoFeatureOn()) { annoResyncDone = ''; return }
  if (!dshState.annoDriver) return
  const keys = annoChipKeys(chips)
  const sig = keys.join('|')
  if (sig === annoResyncDone) return
  annoResyncDone = sig
  for (let i = 0; i < chips.length; i++) {
    const k = keys[i]
    if (!annoCaptureFiles.has(k)) {
      log.appendLine('[anno] resync: feature re-enabled — reserving chip #' + (i + 1) + ' @' + chips[i].name)
      void annoQuietCapture(chips[i], i, k)
    }
  }
  annoPushDockList()
}


async function annoQuietCapture(chip, idx, key) {
  const log = dshState.logChannel
  // (0.1.176) USER RULING — UNIFY ON THE HOVER CARD: at annotation time we
  // only RESERVE the file path (zero reads, zero panel touches). EVERY chip —
  // ids included — gets its full content at SEND time from its hover card
  // (最准, one uniform source); page-side full read survives only as the
  // FALLBACK when a card capture fails for an id-bearing chip.
  const f = annoWriteFile(idx, chip.name, chip.text || '', '(全文待补:发送时 hover 卡片补入本文件)', 'reserved')
  if (f) {
    annoCaptureFiles.set(key, f)
    annoPendingFullKeys.add(key)
    annoPushDockList()
  }
  log.appendLine('[anno] quiet capture @' + chip.name + ' [reserved] -> ' + f)
}

/**
 * (0.1.131) Page-side FULL context rebuild — the hover panel is a SUMMARY
 * (no URL / no Outer HTML body / CSS truncated at "Show More..."). The full
 * "Attached Element Context" is rebuilt here from the live browser page via a
 * one-shot CDP connection to the integrated-browser tab: URL, HTML Path,
 * Outer HTML, CSS (own rules + inherited rules + resolved values + CSS
 * variables). Only runs for chips whose name resolves to a UNIQUE element
 * (tag#id, or a unique bare tag). Zero hover, zero clicks, milliseconds.
 * @param {Array<{name: string}>} chips
 * @param {string} pageHostPort e.g. "10.99.0.106:8005" (from the chip's page)
 * @returns {Promise<Array<{name: string, rebuilt: string|null}>>}
 */
async function rebuildContextFromPage(chips, log) {
  const port = Number(process.env.DSH_CDP_PORT || 9223)
  const http = require('node:http')
  const WebSocket = require('ws')
  const targets = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + port + '/json', (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
  const pages = targets.filter((x) => (x.type === 'page' || x.type === 'iframe') && /^https?:/.test(x.url || ''))
  if (!pages.length) { log.appendLine('[trump] rebuild: no http page target'); return [] }
  const byHost = new Map(pages.map((p) => [(() => { try { return new URL(p.url).host } catch (e) { return '' } })(), p]))
  const results = []
  const connCache = new Map()
  async function evalOn(host, expression) {
    let ws = connCache.get(host)
    if (!ws || ws.readyState !== 1) {
      const t = byHost.get(host)
      if (!t) return null
      ws = await new Promise((resolve, reject) => {
        const s = new WebSocket(t.webSocketDebuggerUrl)
        s.on('open', () => resolve(s)); s.on('error', reject)
      })
      connCache.set(host, ws)
    }
    return await new Promise((resolve) => {
      const msgId = 1
      const onData = (raw) => {
        const m = JSON.parse(raw.toString())
        if (m.id === msgId) { ws.off('message', onData); resolve(m.result && m.result.result ? m.result.result.value : null) }
      }
      ws.on('message', onData)
      ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
      setTimeout(() => { ws.off('message', onData); resolve(null) }, 4000)
    })
  }
  for (const chip of chips) {
    const rebuilt = await evalOnChip(byHost, chip, evalOn, log)
    results.push({ name: chip.name, rebuilt })
  }
  for (const ws of connCache.values()) { try { ws.close() } catch (e) {} }
  return results
}

async function evalOnChip(byHost, chip, evalOn, log) {
  const m = /^(?:([a-zA-Z][a-zA-Z0-9]*)#)?([a-zA-Z][a-zA-Z0-9-]*)/.exec(chip.name)
  if (!m) return null
  const tag = m[1] || ''
  const idOrClass = m[2]
  const isId = chip.name.indexOf('#') !== -1
  const sel = isId ? (tag ? tag.toLowerCase() : '') + '#' + idOrClass : (chip.name.indexOf('.') !== -1 ? tag.toLowerCase() + '.' + idOrClass : tag.toLowerCase() || idOrClass)
  const expr = '(() => { var el = document.querySelector(' + JSON.stringify(sel) + '); if (!el) return "NF"; if (document.querySelectorAll(' + JSON.stringify(sel) + ').length !== 1) return "AMBIG";' +
    ' var path = []; var n = el; while (n && n.nodeType === 1) { path.unshift(n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (n.className && typeof n.className === "string" ? "." + n.className.trim().split(/\\s+/).join(".") : "")); n = n.parentElement; if (path.length > 20) break; }' +
    ' var resolved = {}; var cs = getComputedStyle(el); var PROPS = ["box-sizing","color","cursor","display","font-size","font-weight","height","line-height","margin-top","width"]; PROPS.forEach(function (p) { resolved[p] = cs.getPropertyValue(p) });' +
    ' var vars = {}; for (var i = 0; i < cs.length; i++) { var p2 = cs[i]; if (p2.indexOf("--") === 0) { var v = cs.getPropertyValue(p2).trim(); if (v) vars[p2] = v } }' +
    ' var own = []; var inherited = [];' +
    ' var sheets = document.styleSheets; for (var s = 0; s < sheets.length; s++) { var rules; try { rules = sheets[s].cssRules } catch (e) { continue }' +
    ' var walk = function (rs, media) { for (var r = 0; r < rs.length; r++) { var rule = rs[r]; if (rule.type === 1 && rule.selectorText) { var sels = rule.selectorText.split(","); for (var q = 0; q < sels.length; q++) { try { if (el.matches(sels[q].trim())) { own.push((media ? "@media " + media + " " : "") + sels[q].trim() + " { " + rule.style.cssText + " }"); break } } catch (e) {} } } else if (rule.type === 4 || rule.type === 10) { walk(rule.cssRules, rule.conditionText || ("@" + rule.media.mediaText)) } } }; walk(rules, ""); }' +
    ' for (var an = el.parentElement; an && an.nodeType === 1; an = an.parentElement) { for (var s2 = 0; s2 < sheets.length; s2++) { var rules2; try { rules2 = sheets[s2].cssRules } catch (e) { continue }' +
    ' for (var r2 = 0; r2 < rules2.length; r2++) { var rule2 = rules2[r2]; if (rule2.type === 1 && rule2.selectorText && rule2.style && rule2.style.length) { try { if (an.matches(rule2.selectorText)) { inherited.push("/* Inherited " + an.tagName.toLowerCase() + (an.id ? "#" + an.id : "") + " */ " + rule2.selectorText + " { " + rule2.style.cssText + " }") } } catch (e) {} } } } }' +
    ' var outer = el.outerHTML.length > 4000 ? el.outerHTML.slice(0, 4000) + "…" : el.outerHTML;' +
    ' var r6 = el.getBoundingClientRect();' +
    ' return JSON.stringify({ url: location.href, path: path.join(" > "), outer: outer, own: own.slice(0, 40), inherited: inherited.slice(0, 40), resolved: resolved, vars: vars, dims: { top: Math.round(r6.top), left: Math.round(r6.left), width: Math.round(r6.width), height: Math.round(r6.height) } }); })()'
  const raw = await evalOn((() => { for (const host of byHost.keys()) return host })(), expr)
  if (!raw || raw === 'NF' || raw === 'AMBIG') return null
  try {
    const d = JSON.parse(raw)
    const lines = []
    lines.push('Attached Element Context (rebuilt page-side by dsh-review)')
    lines.push('')
    lines.push('Element: ' + chip.name)
    lines.push('')
    lines.push('URL: ' + d.url)
    lines.push('')
    lines.push('HTML Path: ' + d.path)
    lines.push('')
    lines.push('Outer HTML:')
    lines.push('```html')
    lines.push(d.outer)
    lines.push('```')
    lines.push('')
    lines.push('Dimensions:')
    lines.push('- top: ' + d.dims.top + 'px - left: ' + d.dims.left + 'px - width: ' + d.dims.width + 'px - height: ' + d.dims.height + 'px')
    lines.push('')
    lines.push('CSS:')
    lines.push('```css')
    d.own.forEach((r) => lines.push(r))
    d.inherited.forEach((r) => lines.push(r))
    lines.push('')
    lines.push('/* Resolved values */')
    Object.keys(d.resolved).forEach((p) => lines.push(p + ': ' + d.resolved[p] + ';'))
    lines.push('')
    lines.push('/* CSS variables */')
    Object.keys(d.vars).forEach((v) => lines.push(v + ': ' + d.vars[v] + ';'))
    lines.push('```')
    return lines.join('\n')
  } catch (e) { return null }
}

async function annoSendSync(req) {
  if (annoSendBusy) {
    // A read is already running for this send — do NOT double-drive the widget
    // and do NOT answer with a stale block; the running read will post for req.
    log.appendLine('[anno] send req ' + req + ' during busy — answered plain')
    annoPostPrepared(req, '') // (0.1.180) requester MUST get an answer — silence here froze the composer 75s
    return
  }
  annoSendBusy = true
  const log = dshState.logChannel
  const driver = dshState.annoDriver
  if (!driver) { // (0.1.180) answer + clear busy on EVERY exit
    annoSendBusy = false
    annoPostPrepared(req, '')
    return
  }
  // (0.1.115) Toggle off = feature does not exist: no capture, no clear, no
  // flash-back. The consume message itself only arrives when the client's own
  // gate passes, but the extension re-checks here (event-time file read) so the
  // sidebar behaves identically even if an older client still posts it.
  if (!annoFeatureOn()) {
    log.appendLine('[anno] consumed ignored: annotationToDsh=off (feature silent)')
    annoSendBusy = false // (0.1.180) no busy leak
    annoPostPrepared(req, '')
    return
  }
  // (0.1.148) NO-ANNOTATION = NO-FLASH. annoCurrentChips is fed by the render
  // beacon the moment an annotation is created (and the annotation flow always
  // renders the widget at least once), and 'widget-gone' never clears it. If
  // it is empty here, Copilot holds nothing for us — a plain dsh send (or a
  // stop-button click that the composer heuristics mistook for send) must not
  // flash the panel at all. Fixes the user's "空发送/暂停也闪 copilot".
  if (!annoCurrentChips.length) {
    log.appendLine('[anno] consumed: no Copilot annotations pending — stay quiet (no flash)')
    annoPostPrepared(req, '')
    annoSendBusy = false // (0.1.180) THE leak: answered but stayed busy -> every later send hit "during busy" and hung 75s with zero annotations (user: "没标注直接卡死")
    return
  }
  // Freeze the flash-back-to-dsh: a beacon fired by the flash below would
  // otherwise hide the widget before we read it (the capture-0-chips bug).
  annoFreezeReturn = true
  try {
    // (0.1.120) 0s 发送闪回: the reopen path reads straight from the FLASH
    // BEACON payload — annoMirrorOnState fills annoCurrentChips synchronously
    // when the DOM mutates, so no fixed 120ms settle and no extra eval.
    // Copilot stays visible only for the render + the ✕ clicks.
    annoReturnToDsh = true
    let chips = [] // [{name, text}]
    if (!(await copilotWidgetRendered())) {
      await flashCopilot()
      await waitForWidgetRendered(2500)
      chips = annoCurrentChips.map((c) => ({ name: c.name, text: c.text || '' }))
    } else {
      const raw = await driver.eval('window.__dshAnnoWb && window.__dshAnnoWb.getState()')
      let parsed = null
      try { parsed = (typeof raw === 'string' && raw) ? JSON.parse(raw) : null } catch (e) { parsed = null }
      if (!parsed) {
        log.appendLine('[trump] no state (widget not rendered or no observer)')
        await dumpCopilotDom(driver, log)
        annoPostPrepared(req, '')
        return
      }
      const lineByRef = new Map()
      for (const l of parsed.lines || []) lineByRef.set(l.ref, l.text)
      chips = (parsed.chips || []).map((c) => ({ name: c.name, text: lineByRef.get(c.name) || '' }))
      annoCurrentChips = chips.slice()
    }
    // (0.1.115) Empty-window guard (kept, bounded): the render beacon can beat
    // the model restore; wait for a beacon that ACTUALLY carries chips.
    if (!chips.length) {
      log.appendLine('[trump] read 0 chips — waiting (≤1.2s) for the chip-restore beacon')
      const got = await waitForChipBeacon(1200)
      if (got && annoCurrentChips.length) {
        chips = annoCurrentChips.map((c) => ({ name: c.name, text: c.text || '' }))
        log.appendLine('[trump] late beacon carried ' + chips.length + ' chip(s) — captured from beacon')
      }
      if (!chips.length) await dumpCopilotDom(driver, log)
    }
    // Idempotency: capture ONLY chips created this round (not the persistent
    // leftovers in the baseline). Leftovers are still deleted below to keep the
    // state clean, but they are never reported as the user's annotations.
    const capture = chips.filter((c) => !annoBaseline.has(c.name))
    // ① Print captured content (this round's annotations only)
    log.appendLine('[trump] captured ' + capture.length + ' chip(s):' +
      (chips.length !== capture.length ? ' (excluded ' + (chips.length - capture.length) + ' leftover(s))' : ''))
    for (const c of capture) {
      log.appendLine('[trump]   @' + c.name + ' ' + (c.text || ''))
    }
    // (0.1.123) ①b FULL context per chip (hover tooltip, Show More expanded)
    // — grabbed NOW because the ✕ pass below destroys the chip DOM. Still
    // debug output only ([trump]); ③ insertion into the dsh draft comes later.
    // (0.1.131) FIRST try silent page-side rebuild (URL + Outer HTML + full
    // CSS; no hover at all). Only chips it cannot resolve unambiguously fall
    // back to the synthetic hover (tooltip summary).
    const keysSend = annoChipKeys(chips)
    // (0.1.178) PRIMARY PATH = Heap-Bridge: read the attachment entries from
    // the workbench heap (map, not projection). Hover chain kept as fallback.
    let ctxs2 = null
    if (annoHeapOn()) {
      annoPostProg(req, 1) // heap snapshot starting
      try {
        const heapData = await annoHeapCaptureNow()
        ctxs2 = annoHeapPairFill(chips, keysSend, heapData)
        annoPostProg(req, 2)
      } catch (e) {
        log.appendLine('[anno][heap] bridge unavailable (' + String(e).slice(0, 130) + ') — hover-card fallback')
        ctxs2 = null
      }
    }
    if (!ctxs2) {
    let rebuilt = []
    // (0.1.176) unified hover-card source: NO page rebuild; every chip goes
    // through copilotChipFullContexts (CDP synthetic hover, no clicks).
    rebuilt = chips.map((c) => ({ name: c.name, rebuilt: null }))
    const needIdx = chips.map((c, i) => ((rebuilt[i] && rebuilt[i].rebuilt) || (annoCaptureFiles.has(keysSend[i]) && !annoPendingFullKeys.has(keysSend[i]))) ? -1 : i).filter((i) => i >= 0)
    let ctxs = []
    annoPostProg(req, 1) // hover/capture starting
    if (needIdx.length) { ctxs = await copilotChipFullContexts(needIdx); annoPostProg(req, 2) /* captures done */ }
    else { log.appendLine('[trump] ctx: 0 hover needed (all rebuilt page-side)'); annoPostProg(req, 2) }
    // (0.1.139) merge BY INDEX — the 0.1.131 name-equality find() gave every
    // same-named chip the FIRST capture (09:16 round: 3 different badges all
    // written as "Unloaded"). ctxs is DOM-order-aligned with chips by construction.
    const merged = chips.map((c, i) => {
      const filePre = annoCaptureFiles.get(keysSend[i]) || null
      const t = (rebuilt[i] && rebuilt[i].rebuilt) || (ctxs[i] && ctxs[i].text) || (filePre ? '(reserved: see file)' : null)
      const src = (rebuilt[i] && rebuilt[i].rebuilt) ? 'page' : (ctxs[i] && ctxs[i].text ? 'hover' : (filePre ? 'quiet' : 'none'))
      const held = annoChipTexts.get(keysSend[i])
      if (!c.text && held) c.text = held // late beacon forgot the comment
      return { name: c.name, text: t, source: src, file: filePre, shot: (ctxs[i] && ctxs[i].shot) || null }
    })
    ctxs2 = merged
    // (0.1.159) fill reserved placeholder files with the real hover/page text
    // NOW — while the panel is still open (freeze window).
    for (let fi = 0; fi < ctxs2.length; fi++) {
      const cx = ctxs2[fi]
      const k = keysSend[fi]
      // (0.1.173) any reserved/placeholder file paired with a fresh hover
      // capture gets overwritten — do NOT gate on the pending flag alone.
      if (!cx.file) continue
      if (cx.source !== 'hover' && !annoPendingFullKeys.has(k)) continue
      let t = cx.text
      const bad = !t || String(t).indexOf('<<') === 0 || String(t).indexOf('(captured') !== -1 || String(t).indexOf('(reserved') !== -1
      if (bad) {
        // card failed for this chip — id chips fall back to the page read,
        // anything else keeps the placeholder and says so honestly.
        const sel2 = annoIdSel(cx.name)
        let wroteFb = null
        if (sel2) {
          const d2 = await annoElementFullData({ sel: sel2 })
          if (d2) wroteFb = await annoWriteFull(fi, cx.name, (chips[fi] && chips[fi].text) || '', d2, 'page-fallback', cx.file)
        }
        if (wroteFb) { annoPendingFullKeys.delete(k); log.appendLine('[trump] fallback filled: ' + wroteFb) }
        continue
      }
      try {
        const wroteCard = await annoWriteCardFile(fi, cx.name, (chips[fi] && chips[fi].text) || '', t, cx.shot, cx.file)
        annoPendingFullKeys.delete(k)
        log.appendLine('[trump] reserved filled: ' + (wroteCard || cx.file))
      } catch (e) { log.appendLine('[trump] reserved fill failed: ' + String(e).slice(0, 90)) }
    }
    } // (0.1.178) end hover-fallback branch (heap branch already filled files)
    log.appendLine('[trump] ctx: ' + ctxs2.length + ' full context(s) (' + ctxs2.filter((x) => x.source === 'page').length + ' page-rebuilt, ' + ctxs2.filter((x) => x.source === 'hover').length + ' hover)')
    for (const cx of ctxs2) {
      log.appendLine('[trump] ctx @' + cx.name + ' [' + cx.source + '] >>> ' + (cx.text === null ? '(no capture)' : cx.text.replace(/\n+/g, ' ⏎ ')))
    }
    // (0.1.130) send → FILE, automatically — one file per annotation (the
    // user must not have to ask me to hand-write them afterwards).
    // /tmp/dsh-trump/<stamp>-<i>-<element>.txt, path echoed to the log as
    // `[trump] file:` so a grep finds the deliverable instantly.
    try {
      const dir = path.join(os.tmpdir(), 'dsh-trump')
      fs.mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      for (let si = 0; si < ctxs2.length; si++) {
        const cx = ctxs2[si]
        if (cx.file) continue // (0.1.155) annotation-time file reused as-is (heap path fills cx.file too)
        // (0.1.173) id chips whose annotation-time FULL write failed get a
        // second chance at send time (still before the message goes).
        let fullF = null
        const sel2 = annoIdSel(cx.name)
        if (sel2) {
          const d2 = await annoElementFullData({ sel: sel2 })
          if (d2) fullF = await annoWriteFull(si, cx.name, (chips[si] && chips[si].text) || '', d2, 'page')
        }
        if (!fullF && cx.source === 'hover' && cx.text) fullF = await annoWriteCardFile(si, cx.name, (chips[si] && chips[si].text) || '', cx.text, cx.shot, null)
        cx.file = fullF || annoWriteFile(si, cx.name, (chips[si] && chips[si].text) || '', cx.text, cx.source || 'send')
        if (cx.file) annoCaptureFiles.set(keysSend[si], cx.file)
      }
    } catch (e) { log.appendLine('[trump] file dir failed: ' + String(e).slice(0, 100)) }
    annoPostProg(req, 3) // reserved files filled
    // (0.1.160) THE ORDER THE USER DEMANDED: hover/fill COMPLETE -> answer the
    // intercepted send (client submits draft+block now) -> only THEN the ✕/input
    // cleanup runs in the remainder of the freeze window.
    try {
      const capIdx = []
      chips.forEach((c, i) => { if (!annoBaseline.has(c.name)) capIdx.push(i) })
      const lines = ['以下是我对浏览器元素的标注(全文见各文件):', '']
      capIdx.forEach((i, n) => {
        const cx = ctxs2[i] || {}
        lines.push((n + 1) + '. @' + cx.name + '  注释: ' + ((chips[i] && chips[i].text) || '(无)'))
        lines.push('   全文文件: ' + (cx.file || (annoWriteFile(i, cx.name, (chips[i] && chips[i].text) || '', cx.text, 'send') || '(写盘失败)')))
      })
      if (annoHeapShots && annoHeapShots.length) {
        lines.push('')
        lines.push('浏览器截图附件(随本次标注捕获):')
        for (const sp of annoHeapShots) lines.push('   截图文件: ' + sp)
      }
      annoPreparedBlock = capIdx.length ? lines.join('\n') : ''
      annoLastBlock = annoPreparedBlock
      log.appendLine('[trump] ③ block ready pre-cleanup (' + capIdx.length + ' rows)')
    } catch (e) { log.appendLine('[trump] ③ block build failed: ' + String(e).slice(0, 100)) }
    annoPostPrepared(req, annoPreparedBlock)
    // ② Clear: ✕-click EVERY chip (the ONLY send-path step that legitimately
    // needs Copilot visible). realDeleteChip removes chip + @line + page pin
    // from Copilot's persistent store.
    annoCurrentChips = chips.slice()
    const deleted = await realDeleteAllChips()
    log.appendLine('[trump] clear: ✕-deleted ' + deleted + ' chip(s)')
    if (deleted > 0) { annoCaptureFiles.clear(); annoPendingFullKeys.clear(); annoChipTexts.clear(); annoPushDockList() } // (0.1.155) fresh slate
    // (0.1.121) Clear the INPUT TEXT too — root cause of "后续只能标注1个".
    // VS Code's newChat has a known draft-carryover bug (fixed upstream only
    // in commit 6babfd1, Feb 2026 — after this 1.144 build): stale "@ref"
    // lines survive into the next session, and Copilot DEDUPES a new element
    // annotation against an existing line with the same name, so annotating
    // such an element silently no-ops. User verified by hand: Cmd+A + Delete
    // in the input → multi-annotation works again. Official commands cannot
    // clear it (chat.open's setInput('') is falsy-skipped; clearInputHistory
    // clears history only), so keyboard-simulate via CDP. ~50ms, inside the
    // freeze window, before the view return.
    const clrIn = await clearCopilotInputVerified(log, 'trump')
    log.appendLine('[trump] clear: input=' + clrIn)
    // (0.1.120) Back to dsh IMMEDIATELY. newChat + the late-chips guard run in
    // the BACKGROUND: newChat may re-show Copilot for a beat, and the
    // "opened — return NOW" beacon pushes it back instantly; the guard
    // re-flashes (own freeze) only if late chips actually surface.
    annoFreezeReturn = false
    annoReturnToDsh = true
    annoReturnIfIdle()
    void (async () => {
      try {
        const clr = await clearCopilotSession()
        log.appendLine('[trump] clear: ' + clr + ' (background)')
        const late = await waitForChipBeacon(1000)
        if (!late) return
        const rawL = await driver.eval('window.__dshAnnoWb && window.__dshAnnoWb.getState()')
        let cL = []
        try { const pL = JSON.parse(rawL); cL = pL.chips || [] } catch (e) { /* ignore */ }
        if (!cL.length) return
        annoFreezeReturn = true
        if (!(await copilotWidgetRendered())) {
          annoReturnToDsh = true
          await flashCopilot()
          await waitForWidgetRendered(2500)
        }
        annoCurrentChips = cL.map((c) => ({ name: c.name, text: '' }))
        const d3 = await realDeleteAllChips()
        log.appendLine('[trump] late-chips guard: ' + cL.length + ' chip(s) reappeared -> ✕-deleted ' + d3)
      } catch (e) { /* ignore */ } finally {
        annoFreezeReturn = false
        annoReturnToDsh = true
        annoReturnIfIdle()
      }
    })()
    log.appendLine('[trump] done (view back now; session cleanup backgrounded)')
  } finally {
    if (req !== undefined && req !== null) annoPostPrepared(req, annoPreparedBlock || '') // never hang the client
    annoSendBusy = false
    annoChipsWaiter = null // one-shot waiters must not outlive the send
    // Unfreeze and flash back to dsh (the "闪一下" completes).
    annoFreezeReturn = false
    annoReturnToDsh = true
    annoReturnIfIdle()
  }
}
function annoMirrorOnState(chips, lines, log) {
  // (0.1.116) Only REAL state changes may touch the view: identical beacons
  // (Monaco repaints) used to reset the 2.5s flash-back debounce forever, so
  // after opening Copilot the view never returned to dsh. Dedupe here too —
  // the observer already dedupes, this is the belt.
  const stateKey = chips.map((c) => c.name).join(',') + '|' + lines.map((l) => l.ref + ':' + l.text).join(',')
  const changed = stateKey !== lastBeaconStateKey
  lastBeaconStateKey = stateKey
  if (changed) {
    log.appendLine('[anno] beacon chips=[' + chips.map((c) => c.name).join(',') + '] lines=[' + lines.map((l) => l.ref).join(',') + ']')
  }
  annoChipsBeaconed(chips.length) // (0.1.115) resolve empty-window waiters
  // (0.1.155) passive capture of freshly-seen non-baseline chips (read-only;
  // chip untouched), then push the dock list for the client's sync compose.
  if (annoFeatureOn() && dshState.annoDriver) {
    try {
      const keysX = annoChipKeys(annoCurrentChips)
      annoCurrentChips.forEach((c, i) => { if (c.text) annoChipTexts.set(keysX[i], c.text) })
      for (let i = 0; i < annoCurrentChips.length; i++) {
        const k = keysX[i]
        const c = annoCurrentChips[i]
        if (annoBaseline.has(c.name)) continue
        if (annoCaptureFiles.has(k) || annoCaptureInflight.has(k)) continue
        annoCaptureInflight.add(k)
        void annoQuietCapture(c, i, k)
          .catch((e) => dshState.log.appendLine('[anno] quiet capture failed @' + c.name + ': ' + String(e).slice(0, 90)))
          .finally(() => annoCaptureInflight.delete(k))
      }
      annoPushDockList()
    } catch (e) { /* non-fatal */ }
  }
  // Track chip state for send-time sync (no real-time insertion into dsh).
  annoCurrentChips = chips.map((c) => {
    const lineByRefT = new Map()
    for (const l of lines) lineByRefT.set(l.ref, l.text)
    return { name: c.name, text: lineByRefT.has(c.name) ? lineByRefT.get(c.name) : '' }
  })
  // (0.1.115) Toggle off = feature does not exist: no startup cleanup flash,
  // no flash-back. Beacon logging + chip tracking only (diagnostics).
  if (!annoFeatureOn()) { annoStartupCleanup = false; return }
  const lineByRef = new Map()
  for (const l of lines) lineByRef.set(l.ref, l.text)
  // One-shot startup cleanup: first beacon after VS Code start/reload clears
  // leftover Copilot chips AND the input box (@name text lines persist across
  // restarts even though chips do not).
  if (annoStartupCleanup) {
    annoStartupCleanup = false
    log.appendLine('[anno] startup cleanup: chips=' + chips.length + ' lines=' + lines.length)
    const names = chips.map((c) => c.name)
    annoCurrentChips = []
    void (async () => {
      const driver = dshState.annoDriver
      // Freeze the flash-back while we work on the widget (else it hides mid-read).
      annoFreezeReturn = true
      try {
        if (!(await copilotWidgetRendered())) {
          annoReturnToDsh = true
          await flashCopilot()
          await waitForWidgetRendered(2500)
        }
        // Primary clear: ✕-click every leftover chip (realDeleteChip removes the
        // annotation from Copilot's persistent store + its page pin). newChat
        // alone does NOT clear page-level element annotations (they re-render),
        // so the ✕ click is the reliable clear.
        annoCurrentChips = chips.map((c) => ({ name: c.name, text: lineByRef.get(c.name) || '' }))
        const deleted = await realDeleteAllChips()
        log.appendLine('[anno] startup clear: ✕-deleted ' + deleted + ' chip(s)')
        // Belt-and-suspenders: also reset the session input (removes any input
        // text a ✕ click might not have) for a clean starting session.
        const clr = await clearCopilotSession()
        log.appendLine('[anno] startup clear: ' + clr)
        // Verify the widget is now empty.
        await new Promise((r) => setTimeout(r, 250))
        if (await copilotWidgetRendered() && driver) {
          const raw2 = await driver.eval('window.__dshAnnoWb && window.__dshAnnoWb.getState()')
          if (typeof raw2 === 'string' && raw2) {
            try {
              const p2 = JSON.parse(raw2)
              annoBaseline = new Set((p2.chips || []).map((c) => c.name))
              log.appendLine('[anno] startup verify: chips=' + (p2.chips || []).length + ' lines=' + (p2.lines || []).length)
            } catch (e) { /* ignore */ }
          }
        }
        log.appendLine('[anno] startup cleanup done (baseline=' + [...annoBaseline].join(',') + ')')
      } finally {
        annoFreezeReturn = false
        annoReturnIfIdle()
      }
    })()
    return
  }
  // (0.1.115) annoCurrentChips already refreshed at beacon entry (top).
  // (0.1.114) Debounced flash-back to dsh. The old IMMEDIATE per-beacon
  // `annoReturnIfIdle()` hid the Copilot widget mid-annotation (a race that
  // dropped the user's in-progress annotation — the "sometimes can't annotate"
  // bug). Now we wait 2.5s after the LAST annotation before returning to dsh:
  // a batch of annotations is captured in one view, then the view auto-returns.
  // The send (annoSendSync) and delete (realDeleteChip) paths still flash back
  // immediately (the "flash" the user accepts). (0.1.116) Only when this beacon
  // carried a REAL change — identical repaint beacons must not postpone the
  // return forever.
  if (changed) scheduleReturnToDsh(2500)
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
