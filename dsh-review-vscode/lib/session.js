'use strict'

/**
 * Black box: startReview({ uri, oldText, newText, meta? })
 * Persists mid-review state via setPersistence hooks (pending.json).
 */

const fs = require('node:fs')
const vscode = require('vscode')
const { ReviewCore } = require('./review-core.js')
const { createHunkInsets } = require('./ui/hunk-inset.js')
const { createHunkCodeLenses } = require('./ui/codelens.js')
const { createDecorations } = require('./ui/decorations.js')
const { setHasPendingFile } = require('./ui/title-bar.js')

const log = vscode.window.createOutputChannel('dsh review')

function keyOf(uri) {
  return uri.toString()
}

function editorFor(uri) {
  const k = keyOf(uri)
  return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === k)
}

function documentFor(uri) {
  const k = keyOf(uri)
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === k)
}

function minimalReplace(doc, oldText, newText) {
  const oldLen = String(oldText).length
  const newLen = String(newText).length
  let prefix = 0
  const maxPrefix = Math.min(oldLen, newLen)
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++
  let suffix = 0
  const maxSuffix = Math.min(oldLen - prefix, newLen - prefix)
  while (suffix < maxSuffix && oldText[oldLen - 1 - suffix] === newText[newLen - 1 - suffix]) suffix++
  if (prefix === oldLen && prefix === newLen) return null
  return {
    range: new vscode.Range(doc.positionAt(prefix), doc.positionAt(oldLen - suffix)),
    text: newText.slice(prefix, newLen - suffix),
  }
}

function createReviewHost(context) {
  const pending = new Map()
  let selfEdit = false
  let persistence = {}
  const decorations = createDecorations()
  log.appendLine(
    'insets api: package.json enabledApiProposals='
    + JSON.stringify(require('../package.json').enabledApiProposals)
    + ' createWebviewTextEditorInset=' + (typeof vscode.window.createWebviewTextEditorInset),
  )
  const hunkInsets = createHunkInsets({
    onAccept: (uri, hunkIndex) => acceptHunk(uri, hunkIndex),
    onReject: (uri, hunkIndex) => rejectHunk(uri, hunkIndex),
  })
  const getSession = (uri) => pending.get(uri.toString())
  const hunkLenses = createHunkCodeLenses(getSession)
  const refreshTimers = new Map()

  context.subscriptions.push(
    decorations,
    log,
    { dispose: () => hunkInsets.disposeAll() },
    hunkLenses,
  )
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, hunkLenses.provider),
  )

  function setPersistence(hooks) {
    persistence = hooks || {}
  }

  /**
   * Write newText into the open editor. WorkspaceEdit fails for files
   * outside this window's folders; editor.edit still works.
   * @param {vscode.Uri} uri
   * @param {string} newText
   * @param {{ reveal?: boolean }} [opts] reveal=false: do not steal the active editor
   * @returns {Promise<boolean>}
   */
  async function applyDocText(uri, newText, opts) {
    const reveal = !opts || opts.reveal !== false
    let doc = documentFor(uri)
    if (!doc) {
      try {
        doc = await vscode.workspace.openTextDocument(uri)
      } catch (e) {
        log.appendLine('applyDocText open failed: ' + uri.fsPath + ' ' + (e && e.message || e))
        return false
      }
    }
    // Background sync must not steal the active tab (ruling used to hop 1→2→3→4).
    if (!reveal) {
      const oldText = doc.getText()
      if (oldText === newText) return true
      const patch = minimalReplace(doc, oldText, newText)
      if (!patch) return true
      selfEdit = true
      try {
        const visible = editorFor(uri)
        if (visible) {
          const edited = await visible.edit((b) => { b.replace(patch.range, patch.text) })
          if (edited) return true
        }
        const we = new vscode.WorkspaceEdit()
        we.replace(doc.uri, patch.range, patch.text)
        const ok = await vscode.workspace.applyEdit(we)
        if (!ok) log.appendLine('WorkspaceEdit failed (file outside workspace?) ' + uri.fsPath)
        return ok
      } catch (e) {
        log.appendLine('applyDocText error: ' + (e && e.message || e))
        return false
      } finally {
        selfEdit = false
      }
    }
    const editor = await vscode.window.showTextDocument(doc, { preview: false })
    doc = editor.document
    const oldText = doc.getText()
    if (oldText === newText) return true
    const patch = minimalReplace(doc, oldText, newText)
    if (!patch) return true
    selfEdit = true
    try {
      const edited = await editor.edit((b) => { b.replace(patch.range, patch.text) })
      if (edited) return true
      log.appendLine('editor.edit failed, WorkspaceEdit ' + uri.fsPath)
      const we = new vscode.WorkspaceEdit()
      we.replace(doc.uri, patch.range, patch.text)
      const ok = await vscode.workspace.applyEdit(we)
      if (!ok) log.appendLine('WorkspaceEdit failed (file outside workspace?) ' + uri.fsPath)
      return ok
    } catch (e) {
      log.appendLine('applyDocText error: ' + (e && e.message || e))
      return false
    } finally {
      selfEdit = false
    }
  }

  function readDocText(uri) {
    const doc = documentFor(uri)
    if (doc) return doc.getText()
    const editor = editorFor(uri)
    return editor ? editor.document.getText() : null
  }

  async function saveUri(uri) {
    const doc = documentFor(uri)
    if (doc && doc.isDirty) {
      try { await doc.save() } catch (e) {
        log.appendLine('doc.save failed: ' + (e && e.message || e))
      }
      return
    }
    try { await vscode.workspace.save(uri) } catch { /* noop */ }
  }

  async function updateTitleContext() {
    const ed = vscode.window.activeTextEditor
    const session = ed ? pending.get(ed.document.uri.toString()) : null
    const on = !!(session && session.hunks && session.hunks.length > 0)
    await setHasPendingFile(on)
  }

  function clearUi(uri) {
    const k = uri.toString()
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.toString() === k) decorations.clear(ed)
    }
    hunkInsets.clearUri(uri)
    hunkLenses.refresh()
  }

  function finish(uri) {
    const session = pending.get(uri.toString())
    pending.delete(uri.toString())
    clearUi(uri)
    updateTitleContext()
    if (session && typeof persistence.onFinished === 'function') {
      void Promise.resolve(persistence.onFinished(session)).catch(() => { /* noop */ })
    }
  }

  function refresh(uri) {
    const session = pending.get(uri.toString())
    if (!session) return
    const editor = editorFor(uri)
    const docText = readDocText(uri)
    if (docText == null) return
    session.core.modifiedText = docText
    if (session.lastDiffDoc === docText && session.lastDiffOriginal === session.core.originalText && session.hunks) {
      /* reuse */
    } else {
      session.hunks = session.core.hunks()
      session.lastDiffDoc = docText
      session.lastDiffOriginal = session.core.originalText
    }
    if (session.hunks.length === 0) {
      finish(uri)
      return
    }
    if (!editor) return
    const renderSig = session.core.originalText.length + ':' + docText.length + ':' +
      session.hunks.map((h) => h.beforeStart + ',' + h.beforeCount + ',' + h.afterStart + ',' + h.afterCount).join('|')
    const live = hunkInsets.countFor(editor)
    // Skip apply when layout is unchanged and insets are still alive.
    // countFor drops via onDidDispose if the editor hid/closed — then we remount.
    if (session.lastRenderSig === renderSig && live === session.hunks.length && live > 0) {
      session.insetsMounted = live
      decorations.apply(editor, session, live)
      hunkLenses.refresh()
      updateTitleContext()
      return
    }
    const mounted = hunkInsets.apply(editor, session)
    session.insetsMounted = mounted
    session.lastRenderSig = renderSig
    decorations.apply(editor, session, mounted)
    hunkLenses.refresh()
    updateTitleContext()
    const insetLine = 'refresh insets supported=' + hunkInsets.supported
      + ' mounted=' + mounted
      + (mounted === 0 && hunkInsets.lastError ? ' err=' + hunkInsets.lastError() : '')
    if (session.lastInsetsLog !== insetLine) {
      session.lastInsetsLog = insetLine
      log.appendLine(insetLine)
    }
    if (mounted === 0 && hunkInsets.lastError && /CANNOT use API proposal/i.test(hunkInsets.lastError())) {
      if (!session.warnedProposedApi) {
        session.warnedProposedApi = true
        void vscode.window.showWarningMessage(
          'dsh review: editorInsets 未启用（幽灵行/AC·RJ 需要）。请完全退出后再打开（argv.json 已写入 enable-proposed-api）。',
        )
      }
    }
    if (hunkInsets.supported && mounted === 0 && !session.insetRetry) {
      session.insetRetry = true
      setTimeout(() => { if (pending.get(uri.toString())) refresh(uri) }, 250)
    }
  }

  function scheduleRefresh(uri) {
    const key = uri.toString()
    const prev = refreshTimers.get(key)
    if (prev) clearTimeout(prev)
    refreshTimers.set(key, setTimeout(() => {
      refreshTimers.delete(key)
      refresh(uri)
    }, 60))
  }

  async function notifyRuling(uri) {
    const session = pending.get(uri.toString())
    if (session && typeof persistence.onRuling === 'function') {
      await Promise.resolve(persistence.onRuling(session)).catch(() => { /* noop */ })
    }
  }

  /**
   * After a bulk ruling (accept/reject all): wipe every owned pending entry
   * (including delete entries that never had a live session) so the JSON and
   * the dock converge; the dock clears when the pushed list is empty.
   */
  async function allRuledCleanup() {
    if (persistence && typeof persistence.onAllRuled === 'function') {
      await Promise.resolve(persistence.onAllRuled()).catch(() => { /* noop */ })
    }
  }

  /**
   * @param {{ uri: vscode.Uri, oldText: string, newText: string, meta?: object, reveal?: boolean }} opts
   */
  async function startReview(opts) {
    const uri = opts.uri
    const oldText = String(opts.oldText ?? '')
    const newText = String(opts.newText ?? '')
    const reveal = opts.reveal !== false
    log.appendLine('startReview ' + uri.fsPath + ' old=' + oldText.length + ' new=' + newText.length)
    if (oldText === newText) {
      log.appendLine('startReview skipped: identical texts')
      return
    }
    // Replace any in-flight session for this file (chained AI edits).
    if (pending.has(uri.toString())) {
      const prev = pending.get(uri.toString())
      pending.delete(uri.toString())
      clearUi(uri)
      // Do not onFinished/clear pending.json — caller is replacing the review.
      void prev
    }
    const applied = await applyDocText(uri, newText, { reveal })
    if (!applied) {
      // Race guard: pending-sync clears vanished files up front; if the file
      // disappeared between that check and the open, skip quietly (no toast).
      if (!fs.existsSync(uri.fsPath)) {
        log.appendLine('startReview skipped: file vanished ' + uri.fsPath)
        return
      }
      vscode.window.showErrorMessage('my-review: 无法写入当前文件')
      return
    }
    await saveUri(uri)
    pending.set(uri.toString(), {
      uri,
      meta: opts.meta || null,
      // Only clear pending.json after a real review session (hunks shown or user acted).
      allowClearPending: false,
      core: new ReviewCore({ original: oldText, modified: newText }),
      hunks: [],
      lastDiffDoc: null,
      lastDiffOriginal: null,
      lastRenderSig: null,
    })
    refresh(uri)
    const live = pending.get(uri.toString())
    if (live && live.hunks && live.hunks.length > 0) {
      live.allowClearPending = true
      log.appendLine('startReview hunks=' + live.hunks.length)
    } else {
      log.appendLine('startReview aborted: 0 hunks (pending.json kept)')
    }
  }

  async function acceptHunk(uri, hunkIndex) {
    const session = pending.get(uri.toString())
    if (!session) return
    session.allowClearPending = true
    const docText = readDocText(uri)
    if (docText == null) return
    session.core.modifiedText = docText
    if (!session.core.acceptHunk(hunkIndex)) {
      refresh(uri)
      return
    }
    session.lastDiffDoc = null
    await saveUri(uri)
    refresh(uri)
    await notifyRuling(uri)
  }

  async function rejectHunk(uri, hunkIndex) {
    const session = pending.get(uri.toString())
    if (!session) return
    session.allowClearPending = true
    const docText = readDocText(uri)
    if (docText == null) return
    session.core.modifiedText = docText
    const next = ReviewCore.fromJSON(session.core.toJSON())
    if (!next.rejectHunk(hunkIndex)) {
      refresh(uri)
      return
    }
    // reveal:false — inset click must not showTextDocument (disposes the webview; editor.edit then fails).
    const ok = await applyDocText(uri, next.modifiedText, { reveal: false })
    if (!ok) {
      log.appendLine('rejectHunk apply failed index=' + hunkIndex + ' ' + uri.fsPath) // keep core/file as-is
      refresh(uri)
      return
    }
    session.core = next
    session.lastDiffDoc = null
    await saveUri(uri)
    refresh(uri)
    await notifyRuling(uri)
  }

  async function acceptAll(uri) {
    const session = pending.get(uri.toString())
    if (!session) return
    session.allowClearPending = true
    const docText = readDocText(uri)
    if (docText == null) return
    session.core.modifiedText = docText
    session.core.acceptAll()
    session.lastDiffDoc = null
    await saveUri(uri)
    refresh(uri)
    await notifyRuling(uri)
  }

  async function rejectAll(uri) {
    const session = pending.get(uri.toString())
    if (!session) return
    session.allowClearPending = true
    const docText = readDocText(uri)
    if (docText == null) return
    session.core.modifiedText = docText
    const next = ReviewCore.fromJSON(session.core.toJSON())
    next.rejectAll()
    const ok = await applyDocText(uri, next.modifiedText, { reveal: false }) // same as rejectHunk: do not steal focus
    if (!ok) {
      log.appendLine('rejectAll apply failed ' + uri.fsPath)
      refresh(uri)
      return
    }
    session.core = next
    session.lastDiffDoc = null
    await saveUri(uri)
    refresh(uri)
    await notifyRuling(uri)
  }

  function titleBarUri() {
    const ed = vscode.window.activeTextEditor
    if (ed && pending.has(ed.document.uri.toString())) return ed.document.uri
    const vis = vscode.window.visibleTextEditors.find((e) => pending.has(e.document.uri.toString()))
    if (vis) return vis.document.uri
    const first = pending.values().next()
    return first.done ? null : first.value.uri
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('dshReview.acceptHunk', async (arg) => {
      const uri = arg && arg.uri ? vscode.Uri.parse(String(arg.uri)) : null
      if (!uri) return
      const index = arg && Number.isInteger(arg.hunkIndex) ? arg.hunkIndex : 0
      await acceptHunk(uri, index)
    }),
    vscode.commands.registerCommand('dshReview.rejectHunk', async (arg) => {
      const uri = arg && arg.uri ? vscode.Uri.parse(String(arg.uri)) : null
      if (!uri) return
      const index = arg && Number.isInteger(arg.hunkIndex) ? arg.hunkIndex : 0
      await rejectHunk(uri, index)
    }),
    vscode.commands.registerCommand('dshReview.acceptAll', async () => {
      const uri = titleBarUri()
      if (uri) await acceptAll(uri)
    }),
    vscode.commands.registerCommand('dshReview.rejectAll', async () => {
      const uri = titleBarUri()
      if (uri) await rejectAll(uri)
    }),
    // dsh web dock: rule every open review session in this window (sequential).
    vscode.commands.registerCommand('dshReview.acceptAllPending', async () => {
      for (const s of pending.values()) {
        if (!s.done) await acceptAll(s.uri)
      }
      await allRuledCleanup()
    }),
    vscode.commands.registerCommand('dshReview.rejectAllPending', async () => {
      for (const s of pending.values()) {
        if (!s.done) await rejectAll(s.uri)
      }
      await allRuledCleanup()
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (selfEdit) return
      if (!pending.has(e.document.uri.toString())) return
      scheduleRefresh(e.document.uri)
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      updateTitleContext()
      if (ed && pending.has(ed.document.uri.toString())) refresh(ed.document.uri)
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const ed of editors) {
        if (pending.has(ed.document.uri.toString())) refresh(ed.document.uri)
      }
    }),
  )

  return { startReview, setPersistence, pendingFor: getSession }
}

module.exports = { createReviewHost }
