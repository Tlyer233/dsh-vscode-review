'use strict'

/**
 * Sync per-workbench pending/*.json → startReview + dock.
 * Watch ~/.dsh/review/shadow/pending/*.json for this window's folders.
 * Snapshots: global ~/.dsh/review/shadow/repo.git
 */

const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')
const wbPaths = require('./workbench.js')
const { entryOwnedByThisWindow } = require('./workbench-match.js')
const { readOwnedPending, upsertRolling, removeEntry } = require('./shadow-pending.js')
const { showAt, readDisk, hashTextBlob, pinRollingBlobs } = require('./shadow-git.js')
const { notifyPendingToDsh, setReviewOpener } = require('./dsh-browser.js')

function startPendingSync(context, host) {
  const log = vscode.window.createOutputChannel('dsh review / pending')
  context.subscriptions.push(log)

  let writing = false
  let timer = null
  /** @type {Map<string, { before: string, after: string }>} */
  const applied = new Map()
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const persistTimers = new Map() // filePath → idle persist
  const PERSIST_IDLE_MS = 300 // rulings coalesce; git stays off the click path

  wbPaths.ensureShadowRoot()
  const root = wbPaths.shadowRoot()
  const pendDir = wbPaths.pendingDir()

  function ownedEntries(list) {
    return (Array.isArray(list) ? list : []).filter(entryOwnedByThisWindow)
  }

  function pushDock(entries) {
    try {
      notifyPendingToDsh(ownedEntries(entries != null ? entries : readOwnedPending()))
    } catch (e) {
      log.appendLine('dock notify failed: ' + (e && e.message || e))
    }
  }

  /**
   * @param {string} filePath
   * @description Drop a queued rolling persist (file finished or replaced).
   */
  function cancelPersist(filePath) {
    const prev = persistTimers.get(filePath) // pending timer if any
    if (prev) clearTimeout(prev) // do not write stale hashes after clear
    persistTimers.delete(filePath) // forget the slot
  }

  /**
   * @param {object} session
   * @description Defer blob persist; live originalText/modifiedText stay canonical.
   */
  function schedulePersist(session) {
    if (!session || !session.meta) return // nothing to pin
    const filePath = session.meta.filePath // debounce key
    cancelPersist(filePath) // restart idle window after each ruling
    persistTimers.set(filePath, setTimeout(() => {
      persistTimers.delete(filePath) // timer fired
      const uri = vscode.Uri.file(filePath) // look up the live session, not the closed-over object
      const live = host.pendingFor(uri) // replaced reviews get a new Map entry
      if (!live || !live.hunks || live.hunks.length === 0) return // finished while waiting
      persistRolling(live).catch((e) => { // background; click path already returned
        log.appendLine('persistRolling git failed: ' + (e && e.message || e))
      })
    }, PERSIST_IDLE_MS))
  }

  /**
   * @param {object} session
   * @returns {Promise<void>}
   * @description Store remaining texts as blobs in before/after (same pending fields).
   */
  async function persistRolling(session) {
    if (!session || !session.meta) return
    writing = true
    try {
      const filePath = session.meta.filePath
      const [before, after] = await Promise.all([
        hashTextBlob(session.core.originalText), // remaining baseline
        hashTextBlob(session.core.modifiedText), // remaining doc
      ])
      await pinRollingBlobs(filePath, before, after) // keep blobs reachable
      applied.set(filePath, { before, after }) // before JSON write so watcher sameRound skips remount
      if (session.meta) {
        session.meta.before = before
        session.meta.after = after
      }
      upsertRolling(filePath, { before, after }, session.meta.workbench) // hashes only
      pushDock()
    } catch (e) {
      log.appendLine('persistRolling git failed: ' + (e && e.message || e))
    } finally {
      setTimeout(() => { writing = false }, 80)
    }
  }

  async function clearPending(filePath, workbench) {
    if (!filePath) return
    cancelPersist(filePath) // do not persist after the last hunk
    writing = true
    try {
      removeEntry(filePath, workbench)
      applied.delete(filePath)
      pushDock()
    } finally {
      setTimeout(() => { writing = false }, 80)
    }
  }

  host.setPersistence({
    onRuling: async (session) => {
      if (!session || !session.meta) return
      if (!session.allowClearPending) return
      if (!session.hunks || session.hunks.length === 0) {
        await clearPending(session.meta.filePath, session.meta.workbench)
      } else {
        schedulePersist(session) // memory already updated; git after idle
      }
    },
    onFinished: async (session) => {
      if (!session || !session.meta) return
      if (!session.allowClearPending) {
        log.appendLine('finish without clear (review never mounted) ' + path.basename(session.meta.filePath))
        return
      }
      await clearPending(session.meta.filePath, session.meta.workbench)
    },
    onAllRuled: async () => {
      // Bulk ruling finished: drop every owned entry (per-hunk onRuling may
      // have only persisted blobs without clearing, and delete entries never
      // had a session at all), then push the converged list to the dock.
      for (const t of persistTimers.values()) clearTimeout(t) // no stale upsert after the wipe
      persistTimers.clear()
      writing = true
      try {
        const entries = readOwnedPending()
        for (const e of entries) {
          if (e && e.filePath) removeEntry(e.filePath, e.workbench)
        }
        pushDock()
      } finally {
        setTimeout(() => { writing = false }, 80)
      }
    },
  })

  /**
   * @param {object} entry
   * @param {{ reveal?: boolean }} [opts] reveal=true only for dock click / user open
   */
  async function applyEntry(entry, opts) {
    if (!entry || !entry.filePath) return
    const reveal = !!(opts && opts.reveal)
    // Deletes have no after blob / disk file — dock-only; do not startReview.
    if (entry.operation === 'delete' || !entry.after) return
    if (!entryOwnedByThisWindow(entry)) {
      log.appendLine(
        'skip foreign workbench entry file=' + path.basename(entry.filePath)
        + ' workbench=' + String(entry.workbench || '(none)'),
      )
      return
    }
    const filePath = entry.filePath
    const wb = entry.workbench
    // File vanished while its workbench volume is still mounted: the review can
    // never mount in an editor. Clear it (same as identical texts) instead of
    // retrying — and popping '无法写入' — on every watcher tick.
    if (!fs.existsSync(filePath)) {
      const wbRoot = wbPaths.canonicalWorkbench(wb)
      if (wbRoot && fs.existsSync(wbRoot)) {
        log.appendLine(
          'skip vanished ' + path.basename(filePath)
          + ' before=' + String(entry.before || '').slice(0, 8)
          + ' after=' + String(entry.after || '').slice(0, 8)
          + ' (file missing on disk; clear pending)',
        )
        await clearPending(filePath, wb)
      }
      return
    }
    const uri = vscode.Uri.file(filePath)
    const key = filePath
    const prev = applied.get(key)
    const sameRound = prev && prev.before === entry.before && prev.after === entry.after

    // Same before/after hashes: session already live. Only dock click may focus it.
    if (sameRound && host.pendingFor(uri)) {
      if (reveal) await vscode.window.showTextDocument(uri, { preview: false })
      return
    }

    let oldText
    let newText
    if (entry.baselineText != null && entry.documentText != null) {
      oldText = String(entry.baselineText)
      newText = String(entry.documentText)
    } else {
      const pair = await Promise.all([
        showAt(wb, entry.before, filePath), // blob id or commit:path
        showAt(wb, entry.after, filePath),
      ])
      oldText = pair[0]
      if (oldText == null) oldText = ''
      newText = pair[1]
      if (newText == null) newText = readDisk(filePath)
    }

    if (oldText === newText) {
      log.appendLine(
        'skip identical ' + path.basename(filePath)
        + ' before=' + String(entry.before || '').slice(0, 8)
        + ' after=' + String(entry.after || '').slice(0, 8)
        + ' oldHead=' + JSON.stringify(oldText.slice(0, 40))
        + ' (clear pending)',
      )
      await clearPending(filePath, wb)
      return
    }

    log.appendLine(
      'review ' + path.basename(filePath)
      + ' workbench=' + String(entry.workbench || '')
      + ' before=' + String(entry.before || '').slice(0, 8)
      + ' after=' + String(entry.after || '').slice(0, 8)
      + ' oldLen=' + oldText.length
      + ' newLen=' + newText.length,
    )
    applied.set(key, { before: entry.before, after: entry.after })
    await host.startReview({
      uri,
      oldText,
      newText,
      reveal,
      meta: {
        filePath,
        before: entry.before,
        after: entry.after,
        workbench: entry.workbench,
      },
    })
  }

  async function syncAll(reason) {
    if (writing) return
    const entries = readOwnedPending()
    const mine = ownedEntries(entries)
    log.appendLine(
      '[' + reason + '] pendingDir=' + pendDir
      + ' entries=' + entries.length
      + ' owned=' + mine.length,
    )
    pushDock(mine)
    const live = new Set(mine.map((e) => e && e.filePath).filter(Boolean))
    for (const key of [...applied.keys()]) {
      if (!live.has(key)) applied.delete(key)
    }
    for (const entry of mine) {
      try {
        await applyEntry(entry)
      } catch (e) {
        log.appendLine('apply failed: ' + (e && e.message || e))
      }
    }
  }

  function schedule(reason) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      syncAll(reason).catch((e) => log.appendLine('sync error ' + e.message))
    }, 80)
  }

  fs.mkdirSync(pendDir, { recursive: true })
  const pattern = new vscode.RelativePattern(vscode.Uri.file(pendDir), '*.json')
  const watcher = vscode.workspace.createFileSystemWatcher(pattern)
  context.subscriptions.push(watcher)
  watcher.onDidCreate(() => schedule('create'))
  watcher.onDidChange(() => schedule('change'))
  watcher.onDidDelete(() => schedule('delete'))
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => schedule('folders')))
  log.appendLine('shadow root = ' + root)
  log.appendLine('watching ' + pendDir + '/*.json')
  log.appendLine('global git = ' + wbPaths.globalGitDir())
  log.appendLine('ownership gate = entry.workbench ∈ this window folders (STRICT)')

  schedule('startup')

  setReviewOpener(async (filePath) => {
    const abs = String(filePath || '')
    if (!abs) return false
    const entry = readOwnedPending().find((e) => e && e.filePath === abs)
    if (!entry || entry.operation === 'delete' || !entry.after) return false
    await applyEntry(entry, { reveal: true })
    return true
  })

  context.subscriptions.push({
    dispose() {
      if (timer) clearTimeout(timer)
      for (const filePath of [...persistTimers.keys()]) cancelPersist(filePath) // drop idle persists
      setReviewOpener(null)
    },
  })
}

module.exports = { startPendingSync, shadowRoot: () => wbPaths.shadowRoot() }
