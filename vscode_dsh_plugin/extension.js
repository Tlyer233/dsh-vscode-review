'use strict'

/**
 * dsh-review-vscode — inline (Copilot-style) review of dsh AI edits.
 *
 * When the dsh-review plugin journals a write/edit, this extension opens the
 * file and shows the change INLINE: added/replaced lines tinted green, removed
 * lines ghosted red with strikethrough, and every changed region gets
 * ✓ Accept / × Reject CodeLens buttons. Blocks are processed independently:
 * accepting one does not disturb the others (a running before/after state is
 * advanced through the accept/reject transforms).
 *
 * This file is now a thin activation shell. Runtime state lives in
 * lib/runtime.js; rendering in lib/pending.js; hunk rulings in lib/actions.js;
 * store scanning in lib/store.js; and the dsh browser in lib/browser.js.
 */

const vscode = require('vscode')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile, spawn } = require('node:child_process')
const {
  resolveStoreDir, readManifest, listEntries, findEntryForFile,
  beforePathOf, afterPathOf, titleFor, markEntry,
} = require('./lib/journal.js')
const { verifyEntry, revertEntry } = require('./lib/commit.js')
const { state, log } = require('./lib/runtime.js')
const { InsetManager } = require('./lib/insets.js')
const { updateStatusBar, unresolvedFromStore } = require('./lib/store.js')
const {
  setLensEmitter, pendingFor, makePending, cleanupPending, clearEditorDecorations,
  scheduleRefresh, refreshPending, startInlineReview, navHunk, updateReviewModeContext,
  findRestorableEntry, igIn, saveDecisions, saveCore,
} = require('./lib/pending.js')
const { rewriteOps } = require('./lib/review-session.js')
const {
  undoLast, acceptHunk, rejectHunk, batchAcceptAll, batchRejectAll,
} = require('./lib/actions.js')
const { sendTextToDsh, sendRefsToDsh, setupDshBrowser } = require('./lib/browser.js')
const { isDshOwnerWindow, startOwnerHeartbeat, stopOwnerHeartbeat } = require('./lib/owner.js')

/** QuickPick of pending files (store-backed; open renders inline UI). */
async function listPending() {
  const storeDir = resolveStoreDir(vscode.workspace.getConfiguration('dshReview').get('storeDir') || '')
  const entries = unresolvedFromStore(storeDir)
  const items = []
  for (const e of entries) {
    const stats = e.stats || null
    const delta = stats ? '+' + stats.additions + '/-' + stats.deletions : ''
    const st = pendingFor(vscode.Uri.file(e.filePath))
    const hunkCount = st ? st.hunks.length : (stats ? 1 : 0)
    items.push({
      label: path.basename(e.filePath),
      description: delta ? delta + '  ' + hunkCount + ' hunk(s)' : hunkCount + ' hunk(s)',
      detail: e.filePath + (st ? '  (open)' : ''),
      entry: e,
      storeDir,
    })
  }
  if (items.length === 0) {
    vscode.window.showInformationMessage('dsh review: no pending changes')
    return
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: 'dsh review — ' + items.length + ' pending',
    matchOnDetail: true,
    placeHolder: 'Select a file to review inline',
  })
  if (!picked) return
  const uri = vscode.Uri.file(picked.entry.filePath)
  const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString())
  if (ed) {
    await vscode.window.showTextDocument(ed.document)
  } else {
    await startInlineReview(picked.storeDir, picked.entry)
  }
}

const lensEmitter = new vscode.EventEmitter()
setLensEmitter(lensEmitter)
const lensProvider = {
  onDidChangeCodeLenses: lensEmitter.event,
  provideCodeLenses(document) {
    // File-level actions live at the TOP of the document as two CodeLens
    // entries while the file has unreviewed hunks.
    const st = pendingFor(document.uri)
    if (!st || !st.core || !st.hunks || st.hunks.length === 0) return []
    const top = new vscode.Range(0, 0, 0, 0)
    return [
      new vscode.CodeLens(top, { title: '$(check-all) 全部接受', command: 'dshReview.acceptAllTitle' }),
      new vscode.CodeLens(top, { title: '$(discard) 全部撤回', command: 'dshReview.rejectAllTitle' }),
    ]
  },
}

function dshPort() {
  const cfg = vscode.workspace.getConfiguration('dshReview')
  const configured = Number(cfg.get('dshPort'))
  if (Number.isFinite(configured) && configured > 0) return configured
  try {
    const url = new URL(String(cfg.get('webUrl') || 'http://127.0.0.1:3080'))
    return Number(url.port) || 3080
  } catch { return 3080 }
}

function dshCommand() {
  const cfg = vscode.workspace.getConfiguration('dshReview')
  const raw = String(cfg.get('dshCommand') || `node ${os.homedir()}/.local/bin/dsh --profile web`)
  return raw.replace(/\$\{env:HOME\}/g, os.homedir())
}

function stopDshProcess(port) {
  return new Promise((resolve) => {
    execFile('lsof', ['-ti', 'tcp:' + port], { timeout: 5000 }, (err, stdout) => {
      const pids = (stdout || '').trim().split(/\s+/).filter(Boolean)
      if (pids.length === 0) { resolve(0); return }
      let remaining = pids.length
      for (const pid of pids) {
        execFile('kill', ['-9', String(pid)], { timeout: 5000 }, () => {
          remaining -= 1
          if (remaining === 0) resolve(pids.length)
        })
      }
    })
  })
}

function reloadDshWebview(force) {
  if (state.dshView) {
    void state.dshView.webview.postMessage({ type: 'dshReload', force: force === true })
    return true
  }
  return false
}

function scheduleDshReload(delays) {
  for (const delay of delays) {
    setTimeout(() => { reloadDshWebview(true) }, delay)
  }
}

function startDshProcess() {
  const logPath = path.join(os.homedir(), '.dsh', 'review', 'dsh-restart.log')
  const child = spawn('/bin/sh', ['-c', dshCommand() + ' >> "' + logPath + '" 2>&1'], {
    cwd: os.homedir(),
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  return child.pid
}

async function restartDsh() {
  const port = dshPort()
  const killed = await stopDshProcess(port)
  await new Promise((resolve) => setTimeout(resolve, killed > 0 ? 700 : 0))
  startDshProcess()
  vscode.window.showInformationMessage('dsh restarted on port ' + port + (killed > 0 ? ' (killed ' + killed + ' old process)' : ''))
  // The iframe may be sitting on a dead connection (black view), where the
  // user cannot press Ctrl+R. Force-reload it after startup, with retries in
  // case the dsh server needs a moment to listen.
  scheduleDshReload([1200, 3000, 6000])
}

async function stopDsh() {
  const port = dshPort()
  const killed = await stopDshProcess(port)
  vscode.window.showInformationMessage(killed > 0 ? 'dsh stopped (port ' + port + ')' : 'dsh is not running (port ' + port + ')')
  setTimeout(() => { reloadDshWebview(true) }, 600)
}

function activate(context) {
  state.output = vscode.window.createOutputChannel('dsh review')
  const storeDir = resolveStoreDir(vscode.workspace.getConfiguration('dshReview').get('storeDir') || '')
  state.instanceId = String(vscode.env.sessionId || (process.pid + '-' + Math.random().toString(36).slice(2)))
  log('storeDir:', storeDir, 'instanceId:', state.instanceId)
  state.insets = new InsetManager({
    onAccept: (hunkIndex, st) => acceptHunk({ uri: st.uri.toString(), changeId: st.changeId, hunkIndex }),
    onRevert: (hunkIndex, st) => rejectHunk({ uri: st.uri.toString(), changeId: st.changeId, hunkIndex }),
    onUndo: (st) => undoLast(st, 'inset'),
    onAcceptAll: async (st) => { try { log('onAcceptAll called'); await batchAcceptAll(st) } catch (e) { log('batchAcceptAll ERROR:', e.message, e.stack) } },
    onRevertAll: async (st) => { try { log('onRevertAll called'); await batchRejectAll(st) } catch (e) { log('batchRejectAll ERROR:', e.message, e.stack) } },
  })
  state.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  state.statusBar.command = 'dshReview.listPending'
  context.subscriptions.push(state.statusBar)

  setupDshBrowser(context, storeDir)

  log('insets (editorInsets proposed API):', state.insets.supported ? 'available' : 'UNAVAILABLE (decoration fallback) — probe: ' + (state.insets.diagnostic || '?'), '\n  extension id: dsn.dsh-review-vscode, argv.json enable-proposed-api set, package.json enabledApiProposals:', JSON.stringify(require('./package.json').enabledApiProposals))
  context.subscriptions.push({ dispose: () => { if (state.insets) state.insets.disposeAll() } })
  if (!fs.existsSync(storeDir)) {
    try { fs.mkdirSync(storeDir, { recursive: true }) } catch (e) { log('cannot create store dir:', e.message) }
  }
  startOwnerHeartbeat(storeDir)
  context.subscriptions.push({ dispose: () => stopOwnerHeartbeat() })

  state.addDec = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(46,160,67,0.15)', isWholeLine: true })
  state.delDec = vscode.window.createTextEditorDecorationType({ isWholeLine: false })
  context.subscriptions.push(state.addDec, state.delDec)
  context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lensProvider))

  const opened = new Set()

  function normalizeFsPath(p) {
    try { return path.resolve(String(p)).replace(/\/+$/, '') || '/' } catch { return String(p) }
  }

  function currentWorkspaceRoots() {
    const roots = new Set()
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const raw = folder.uri.fsPath
      roots.add(normalizeFsPath(raw))
      try { roots.add(normalizeFsPath(fs.realpathSync.native(raw))) } catch { /* noop */ }
    }
    return roots
  }

  // Reverse gate: auto-open only journal entries whose workbenchId matches a
  // folder currently open in THIS VS Code window. Everything else (legacy
  // no-workbenchId entries, /tmp files, other projects) is skipped here and
  // remains available through the browser panels.
  function isEntryInCurrentWorkspace(entry) {
    const wb = entry && entry.workbenchId
    if (typeof wb !== 'string' || !wb) return false
    return currentWorkspaceRoots().has(normalizeFsPath(wb))
  }

  const observe = (id) => {
    if (String(id).endsWith('.decisions') || String(id).endsWith('.ops')) return
    const entry = readManifest(storeDir, id)
    if (opened.has(id)) {
      // Cross-window resolution: another VSCode (or the browser panel) marked
      // this manifest accepted/reverted. This window may still be showing the
      // inline diff for that file — tear the stale review UI down.
      if (entry && entry.filePath && entry.status && entry.status !== 'committed') {
        const uri = vscode.Uri.file(entry.filePath)
        const st = pendingFor(uri)
        // Only clear when THIS window did not complete the review locally.
        // Local AC/RJ sets st.resolved = true and must keep the pending
        // state (and its ops stack) alive so Cmd+Z can restore the whole
        // file. Cross-window verdicts leave st.resolved false here.
        if (st && st.resolved !== true) {
          log('clear stale inline review [' + state.instanceId + ']', entry.id, path.basename(entry.filePath), '->', entry.status)
          clearEditorDecorations(uri)
          cleanupPending(st)
          updateReviewModeContext()
        }
      }
      return
    }
    opened.add(id)
    if (!entry) { log('unreadable manifest', id); return }
    log('new change [' + state.instanceId + ']', entry.tool || '?', entry.operation || '?', entry.filePath || '?')
    if (entry.status === 'reverted') return
    // Reverse workbench gate: this window only auto-opens diffs that belong
    // to one of ITS workspace folders. A sibling window opened on another
    // project must never pop this project's diffs.
    if (!isEntryInCurrentWorkspace(entry)) {
      log('skip auto-open [' + state.instanceId + '] (outside current workbench):', entry.workbenchId || '(none)', entry.filePath || id)
      return
    }
    // Workbench match is the primary ownership gate: only a window whose
    // VS Code workspace contains the entry's workbench may auto-open it.
    // The cross-instance lease is intentionally not consulted here because
    // the user keeps one workspace per VS Code window; requiring the lease
    // caused the correct window to skip when the other window held it.
    if (state.dshView) {
      log('auto-open [' + state.instanceId + ']', entry.filePath || id)
      startInlineReview(storeDir, entry).catch((e) => log('inline review error:', e && e.message || e))
      return
    }
    log('skip auto-open [' + state.instanceId + '] (no dsh sidebar in this window):', entry.filePath || id)
  }

  try {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(storeDir, '*.json'))
    context.subscriptions.push(watcher)
    watcher.onDidCreate((uri) => {
      log('watcher created:', uri.fsPath)
      observe(path.basename(uri.fsPath, '.json'))
    })
    log('watcher armed on', storeDir)
  } catch (e) {
    log('watcher failed:', e && e.message || e)
  }

  const seen = new Set()
  // Prime: register the existing store so history is NOT auto-opened at startup.
  try {
    for (const n of fs.readdirSync(storeDir).filter((x) => x.endsWith('.json'))) {
      seen.add(n.slice(0, -5))
    }
  } catch { /* store dir missing/unreadable */ }
  const poll = () => {
    let names = []
    try { names = fs.readdirSync(storeDir).filter((n) => n.endsWith('.json')) } catch { return }
    for (const st of state.pending.values()) {
      if (st && st.changeId) observe(String(st.changeId))
    }
    for (const n of names) {
      const id = n.slice(0, -5)
      if (!seen.has(id)) { seen.add(id); observe(id) }
    }
  }
  log('poll primed with', seen.size, 'existing change(s)')
  // Startup visibility: badge shows unresolved changes; unlike a forced
  // auto-open (which picks a random file), review state is restored lazily
  // per file — see the onDidOpenTextDocument handler below (Trae behavior:
  // open any file and its pending change markers come back).
  updateStatusBar()
  const unresolved = unresolvedFromStore(storeDir)
  if (unresolved.length > 0) log('unresolved changes at startup:', unresolved.length)
  const timer = setInterval(poll, 3000)
  context.subscriptions.push({ dispose: () => clearInterval(timer) })
  log('poll armed (3000ms)')

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    if (state.selfEdit) return
    const st = pendingFor(e.document.uri)
    if (!st) return
    // Save/dirty-state transitions also fire this event with zero content
    // changes. Treating them as an undo was instantly rewinding every accept.
    if (e.contentChanges.length === 0) {
      log('DTS ignored (0 content changes):', path.basename(e.document.uri.fsPath))
      return
    }
    log('DTS changes:', e.contentChanges.length, path.basename(e.document.uri.fsPath))
    const docText = e.document.getText()
    // Fallback for native undo (works for reject edits): if the document
    // returned to the pre-op text of a top operation, that operation was
    // undone. Drain every matching top op LIFO and rewind the baseline for
    // any accept ops that were part of the same undo.
    let drained = 0
    while (st.ops.length > 0 && st.ops[st.ops.length - 1].preDocText === docText) {
      const op = st.ops.pop()
      drained++
      if (op.preBaselineText !== undefined && st.core) st.core.originalText = op.preBaselineText
      const recs = op.decisions || (op.decision ? [op.decision] : null)
      if (recs && recs.length > 0) {
        st.decisions = st.decisions.filter((g) => !recs.some((ig) => igIn(ig, g)))
        saveDecisions(st)
        if (op.type === 'accept') st.accepted = Math.max(0, st.accepted - recs.length)
      }
      log('UNDO (native) ' + op.type + ': op', op.n, 'rewound baseline')
    }
    if (drained > 0) {
      try { rewriteOps(st.storeDir, st.changeId, st.ops) } catch (err) { log('rewriteOps failed:', err && err.message || err) }
      saveCore(st)
      if (st.resolved) {
        st.resolved = false
        try { markEntry(st.storeDir, st.changeId, { status: 'committed' }) } catch (err) { log('revive markEntry failed:', err && err.message || err) }
      }
      log('undo drained', drained, 'op(s), re-rendering:', path.basename(e.document.uri.fsPath))
      refreshPending(e.document.uri)
    } else {
      log('text changed, re-rendering:', path.basename(e.document.uri.fsPath))
      scheduleRefresh(e.document.uri, 150)
    }
  }))

  // Re-apply the inline UI whenever an editor for a pending uri becomes
  // visible (closing and re-opening a file must restore decorations+insets).
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors((editors) => {
    for (const ed of editors) {
      if (pendingFor(ed.document.uri)) scheduleRefresh(ed.document.uri, 100)
    }
    updateReviewModeContext()
  }))

  // Trae-like restore: opening ANY file whose store entry is still unresolved
  // brings its review markers back, even across restarts (the before snapshot
  // is on disk; the current text is the after side).
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(async (doc) => {
    if (!doc || doc.uri.scheme !== 'file') return
    if (pendingFor(doc.uri)) return
    let entry = findEntryForFile(storeDir, doc.uri.fsPath)
    // Batch verdicts mark the manifest accepted/reverted; revive a resolved
    // entry whose ops stack still holds undoable operations.
    if (!entry) entry = findRestorableEntry(storeDir, doc.uri.fsPath)
    if (!entry) return
    // entry is 'committed' (unresolved): before snapshot = OR, doc = AI output.
    const beforePath = beforePathOf(storeDir, entry.id)
    if (!fs.existsSync(beforePath)) return
    const wasOpened = opened.has(entry.id)
    opened.add(entry.id)
    makePending(doc.uri, entry.id, storeDir, beforePath, afterPathOf(storeDir, entry.id))
    log('restored inline review on open:', entry.id, path.basename(doc.uri.fsPath), wasOpened ? '' : '(new)')
    refreshPending(doc.uri)
  }))

  context.subscriptions.push(vscode.commands.registerCommand('dshReview.listPending', listPending))
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.undoLast', async () => {
    const editor = vscode.window.activeTextEditor
    const st = editor ? pendingFor(editor.document.uri) : null
    await undoLast(st, 'command')
  }))
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.undoReviewAction', async () => {
    const editor = vscode.window.activeTextEditor
    const st = editor ? pendingFor(editor.document.uri) : null
    await undoLast(st, 'keybinding')
  }))
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.openDshSidebar', async () => {
    // Toggle: show/focus the dsh view, or hide the secondary side bar when
    // the dsh webview is currently visible.
    try {
      if (state.dshView && state.dshVisible) {
        await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar')
      } else {
        await vscode.commands.executeCommand('dshReview.dshWebview.focus')
      }
    } catch (e) {
      log('toggleDshSidebar failed:', e && e.message || e)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.restartDsh', restartDsh))
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.stopDsh', stopDsh))
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.sendSelectionToDsh', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showWarningMessage('dsh: select some text in the editor first')
      return
    }
    const startLine = editor.selection.start.line + 1
    const endLine = editor.selection.end.line + 1
    const range = startLine === endLine ? 'L' + startLine : 'L' + startLine + '~L' + endLine
    const fsPath = editor.document.uri.fsPath
    const text = '文件: ' + fsPath + ' ' + range
    const ref = {
      kind: 'selection',
      path: fsPath,
      startLine,
      endLine,
      label: '📄 ' + path.basename(fsPath) + ' ' + range,
      clipboardText: fsPath + ' ' + range,
      modelText: text,
    }
    const sent = await sendRefsToDsh([ref], text)
    if (!sent) log('sendSelectionToDsh: postMessage failed')
  }))
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.acceptAllTitle', async () => {
    const editor = vscode.window.activeTextEditor
    const st = editor ? pendingFor(editor.document.uri) : null
    if (!st || !st.core || st.hunks.length === 0) return
    try { await batchAcceptAll(st) } catch (e) { log('acceptAllTitle ERROR:', e && e.message || e) }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.rejectAllTitle', async () => {
    const editor = vscode.window.activeTextEditor
    const st = editor ? pendingFor(editor.document.uri) : null
    if (!st || !st.core || st.hunks.length === 0) return
    try { await batchRejectAll(st) } catch (e) { log('rejectAllTitle ERROR:', e && e.message || e) }
  }))
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => updateReviewModeContext()))
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.acceptHunk', acceptHunk))
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.rejectHunk', rejectHunk))

  context.subscriptions.push(vscode.commands.registerCommand('dshReview.acceptAll', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    const st = pendingFor(editor.document.uri)
    if (!st || !st.hunks || st.hunks.length === 0) return
    // Each accept re-renders and reshuffles indices — always take index 0
    // until nothing is left.
    const guard = 200
    let n = 0
    while (pendingFor(st.uri) && st.hunks.length > 0 && n < guard) {
      await acceptHunk({ uri: st.uri.toString(), changeId: st.changeId, hunkIndex: 0 })
      n++
    }
    log('accepted all', st.changeId, 'rounds', n)
  }))

  context.subscriptions.push(vscode.commands.registerCommand('dshReview.goToNextHunk', () => navHunk(1)))
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.goToPrevHunk', () => navHunk(-1)))

  context.subscriptions.push(vscode.commands.registerCommand('dshReview.focusEditor', async () => {
    const editor = vscode.window.activeTextEditor
    if (editor && pendingFor(editor.document.uri)) return
    for (const st of state.pending.values()) {
      const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === st.uri.toString())
      if (ed) {
        await vscode.window.showTextDocument(ed.document)
        return
      }
    }
    vscode.window.showInformationMessage('dsh review: no pending inline review open')
  }))

  context.subscriptions.push(vscode.commands.registerCommand('dshReview.showDiff', async (arg) => {
    let entry = null
    if (arg && typeof arg === 'object' && arg.changeId) entry = readManifest(storeDir, arg.changeId)
    else {
      const uri = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri
      if (!uri || uri.scheme !== 'file') { vscode.window.showWarningMessage('dsh review: open a file first (or pass a changeId)'); return }
      entry = findEntryForFile(storeDir, uri.fsPath)
    }
    if (!entry) { vscode.window.showWarningMessage('dsh review: no recorded change to show'); return }
    const res = await openDiff(storeDir, entry)
    if (!res.ok) vscode.window.showWarningMessage('dsh review: ' + res.error)
  }))

  context.subscriptions.push(vscode.commands.registerCommand('dshReview.revert', async (arg) => {
    const uri = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri
    const changeId = arg && typeof arg === 'object' && arg.changeId
    let entry = null
    if (changeId) entry = readManifest(storeDir, changeId)
    else if (uri && uri.scheme === 'file') entry = findEntryForFile(storeDir, uri.fsPath)
    if (!entry) {
      vscode.window.showWarningMessage('dsh review: no recorded change to revert')
      return
    }
    const confirm = await vscode.window.showWarningMessage(
      'Revert ' + entry.filePath + '?', { modal: true, detail: 'Restore the pre-change snapshot content (no git).' },
      'Revert')
    if (confirm !== 'Revert') return
    const res = await revertEntry({ fsx: vscodeFsAdapter(), entry, beforeBytes: beforeBytesOf(storeDir, entry) })
    if (res.ok) {
      markEntry(storeDir, entry.id, { status: 'reverted', revertedAt: new Date().toISOString() })
      vscode.window.showInformationMessage('dsh review: ' + res.message)
      if (uri) { const st = pendingFor(uri); if (st) { cleanupPending(st); clearEditorDecorations(uri) } }
      lensEmitter.fire()
      log('reverted', entry.id, res.action)
    } else {
      vscode.window.showErrorMessage('dsh review: ' + res.error)
    }
  }))

  context.subscriptions.push(vscode.commands.registerCommand('dshReview.status', async () => {
    const entries = listEntries(storeDir)
    log('--- dsh review: ' + entries.length + ' change(s) ---')
    const fsx = vscodeFsAdapter()
    for (const e of entries) {
      const verified = await verifyEntry({ fsx, entry: e, afterBytes: afterBytesOf(storeDir, e) })
      log((verified === 'match' ? '✓ ' : verified === 'reverted' ? '↩ ' : verified === 'drifted' ? '⚠ ' : '· ') +
        e.at + ' ' + (e.tool || '?') + ' ' + (e.filePath || '?') + ' [' + verified + ']')
    }
    log('---')
    if (entries.length === 0) vscode.window.showInformationMessage('dsh review: no changes recorded yet')
  }))

  // Scan editors already open at activation (VS Code restores tabs before
  // our onDidOpenTextDocument listener is registered, missing the event)
  // — proactive restore so already-open files show their markers.
  setTimeout(() => {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme !== 'file') continue
      if (pendingFor(ed.document.uri)) continue
      try {
        let entry = findEntryForFile(storeDir, ed.document.uri.fsPath)
        if (!entry) entry = findRestorableEntry(storeDir, ed.document.uri.fsPath)
        if (!entry) continue
        const beforePath = beforePathOf(storeDir, entry.id)
        if (!fs.existsSync(beforePath)) continue
        makePending(ed.document.uri, entry.id, storeDir, beforePath, afterPathOf(storeDir, entry.id))
        opened.add(entry.id)
        log('restored inline review on scan:', entry.id, path.basename(ed.document.uri.fsPath))
        refreshPending(ed.document.uri)
      } catch (e) {
        log('scan restore error:', e && e.message || e)
      }
    }
  }, 800)

  log('dsh-review-vscode activated')
}

async function openDiff(storeDir, entry) {
  const beforePath = beforePathOf(storeDir, entry.id)
  const realPath = entry.filePath
  try {
    if (!fs.existsSync(realPath)) return { ok: false, error: 'real file missing: ' + realPath }
    if (!fs.existsSync(beforePath)) {
      if (entry.operation === 'create') fs.writeFileSync(beforePath, '')
      else return { ok: false, error: 'no before snapshot for ' + entry.id }
    }
    await vscode.commands.executeCommand('vscode.diff',
      vscode.Uri.file(beforePath), vscode.Uri.file(realPath), titleFor(entry))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e && e.message || String(e) }
  }
}

function beforeBytesOf(storeDir, entry) {
  try { return fs.readFileSync(beforePathOf(storeDir, entry.id)) } catch { return null }
}
function afterBytesOf(storeDir, entry) {
  try { return fs.readFileSync(afterPathOf(storeDir, entry.id)) } catch { return null }
}
function vscodeFsAdapter() {
  return {
    readFile: async (p) => { try { return await vscode.workspace.fs.readFile(vscode.Uri.file(p)) } catch { return null } },
    writeFile: async (p, buf) => { await vscode.workspace.fs.writeFile(vscode.Uri.file(p), buf) },
    deleteFile: async (p) => { await vscode.workspace.fs.delete(vscode.Uri.file(p)) },
    exists: async (p) => { try { await vscode.workspace.fs.stat(vscode.Uri.file(p)); return true } catch { return false } },
  }
}

function deactivate() {}

module.exports = { activate, deactivate }
