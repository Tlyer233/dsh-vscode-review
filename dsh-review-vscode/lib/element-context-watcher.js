'use strict'

/**
 * v12 — element-context watcher: save-to-tmp close (no-prompt by construction).
 *
 * v12 (user-proposed "曲线救国"):
 *  - closeElementDoc: doc.save(<tmp file>) FIRST (public API, no dialog,
 *    turns the untitled doc into a clean file doc) -> closeActiveEditor
 *    (silent: nothing to save) -> fs.unlink(tmp). CDP "Don't Save" clicker
 *    stays as fallback if save fails.
 *  - onDocOpen ignores the tmp file (its own save echo would double-send).
 *  - stale tmp file removed on activation.
 *  - jsonl fallback send (v11) + fast doc path unchanged.
 */

const vscode = require('vscode')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { sendRefsToDsh } = require('./dsh-browser')
const bridge = require('./element-bridge')

const TAG = '[element-context]'
const NAME_PREFIX = 'Attached Element Context'
const MARKER = 'Attached Element Context'
const BAR = '='.repeat(68)
const VERSION = 'v12'
const TMP_FILE = path.join(os.tmpdir(), 'dsh-element-context.txt')
const TMP_URI = vscode.Uri.file(TMP_FILE).toString()

function cfg(key, def) {
  try {
    const v = vscode.workspace.getConfiguration('dshReview.elementContext').get(key)
    return v === undefined ? def : v
  } catch { return def }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function safeLen(doc) {
  try { return doc.getText().length } catch { return -1 }
}

function parseNameUrl(text) {
  const nameM = String(text).match(/^Element:\s*(.+)\s*$/m)
  const urlM = String(text).match(/^URL:\s*(\S+)\s*$/m)
  return {
    name: nameM ? nameM[1].trim() : 'element',
    url: urlM ? urlM[1].trim() : '',
  }
}

function startElementContextWatcher(context, log) {
  const stamp = () => new Date().toISOString()
  let seq = 0

  // remove stale tmp file from a crashed previous run
  try {
    if (fs.existsSync(TMP_FILE)) {
      fs.unlinkSync(TMP_FILE)
      log.appendLine(TAG + ' 清理残留 tmp 文件: ' + TMP_FILE)
    }
  } catch { /* noop */ }

  function toast(msg) {
    try { void vscode.window.showInformationMessage(msg, { modal: false }) } catch { /* noop */ }
  }

  function intercept(source, meta, content) {
    seq += 1
    const text = String(content == null ? '' : content)
    log.appendLine(BAR)
    log.appendLine(TAG + ' >>> 拦截 #' + seq + ' <<<  时间 ' + stamp())
    log.appendLine(TAG + ' 来源: ' + source)
    for (const m of meta) log.appendLine(TAG + ' ' + m)
    log.appendLine(TAG + ' 内容 (' + text.length + ' 字符):')
    for (const line of text.split('\n')) log.appendLine(TAG + '   | ' + line)
    log.appendLine(BAR)
    toast('[dsh] 拦截到浏览器元素上下文 #' + seq + ' — ' + source)
  }

  // ---------- shared capture state ----------
  const seenAtt = new Set()
  const docCaptures = [] // {name, ts} — captures already sent (any path)

  function markCapture(name) {
    docCaptures.push({ name, ts: Date.now() })
    while (docCaptures.length > 30) docCaptures.shift()
  }
  function alreadySent(name) {
    return docCaptures.some((c) => c.name === name && Date.now() - c.ts < 180000)
  }

  // ---------- send pipeline (shared by doc path and jsonl fallback) ----------
  async function sendElementToDsh(name, url, text, imageData) {
    const ref = {
      kind: 'element',
      path: url || name,
      content: text,
      label: 'element: ' + name,
      clipboardText: text,
      modelText: text,
    }
    if (imageData && imageData.$base64) {
      ref.imageData = imageData
      log.appendLine(TAG + ' -> image attached (' + imageData.$base64.length + ' b64 chars)')
    }
    const ok = await sendRefsToDsh([ref], text)
    log.appendLine(TAG + ' -> sent to dsh: ' + ok + (ok ? '' : ' (dsh 侧栏是否打开?)'))
    if (cfg('focusDshAfterCapture', true)) {
      setTimeout(() => {
        vscode.commands.executeCommand('dshReview.dshWebview.focus').catch(() => { /* noop */ })
      }, 200)
    }
    return ok
  }

  // ---------- A) chatSessions jsonl: fs-watcher only (event-driven, no poll) ----------
  function attachmentsOf(line) {
    let o
    try { o = JSON.parse(line) } catch { return null }
    if (o.kind === 0 && o.v && o.v.inputState && Array.isArray(o.v.inputState.attachments)) {
      return o.v.inputState.attachments
    }
    if (o.kind === 1 && Array.isArray(o.k) && o.k[0] === 'inputState' && o.k[1] === 'attachments' && Array.isArray(o.v)) {
      return o.v
    }
    return null
  }

  function scanSessionFile(file, source, silent) {
    let raw
    try { raw = fs.readFileSync(file, 'utf8') } catch { return }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const atts = attachmentsOf(line)
      if (!atts) continue
      for (const a of atts) {
        if (!a || a.kind !== 'element' || !a.id || seenAtt.has(a.id)) continue
        seenAtt.add(a.id)
        if (silent) continue
        const selAt = new Date(parseInt(String(a.id).split('-')[1], 10) || 0).toISOString()
        if (alreadySent(a.name)) {
          log.appendLine(TAG + ' · jsonl dup of earlier send, skip: ' + a.name)
          continue
        }
        const nu = parseNameUrl(a.value)
        intercept(source, [
          '会话文件: ' + file,
          '附件 id: ' + a.id,
          '附件名: ' + a.name,
          '选中时间: ' + selAt,
          '元素截图: ' + (a.imageData && a.imageData.$base64 ? '有 (' + a.imageMimeType + ')' : '无'),
        ], a.value)
        markCapture(a.name)
        void (async () => {
          const img = cfg('image', false) && a.imageData && a.imageData.$base64
            ? { $base64: a.imageData.$base64, $mimeType: a.imageMimeType || 'image/png' }
            : null
          await sendElementToDsh(a.name, nu.url, String(a.value || ''), img)
        })()
      }
    }
  }

  let sessDir = null
  if (context.storageUri) {
    sessDir = path.join(path.dirname(context.storageUri.fsPath), 'chatSessions')
  }
  function scanAllSessions(source, silent) {
    if (!sessDir) return
    let files = []
    try { files = fs.readdirSync(sessDir).filter((f) => f.endsWith('.jsonl')) } catch { return }
    for (const f of files) scanSessionFile(path.join(sessDir, f), source, silent)
  }

  if (sessDir) {
    log.appendLine(TAG + ' A: session dir = ' + sessDir + ' (from context.storageUri)')
    scanAllSessions('PRE-EXISTING', true)
    log.appendLine(TAG + ' A: pre-scan known attachments = ' + seenAtt.size + ' (已静默标记)')
    const sessWatcher = vscode.workspace.createFileSystemWatcher(sessDir + '/*.jsonl')
    context.subscriptions.push(sessWatcher)
    const onSess = (kind) => (uri) => {
      log.appendLine(TAG + ' · raw-' + kind + ' ' + uri.fsPath)
      scanAllSessions('jsonl 延迟落盘(零操作, 兜底发送) [' + kind + ']', false)
    }
    sessWatcher.onDidCreate(onSess('create'), undefined, context.subscriptions)
    sessWatcher.onDidChange(onSess('change'), undefined, context.subscriptions)
    log.appendLine(TAG + ' A: armed (fs-watcher only, 无轮询, 兜底发送已启用)')
  } else {
    log.appendLine(TAG + ' A: SKIPPED — context.storageUri undefined (no workspace open?)')
  }

  context.subscriptions.push(vscode.commands.registerCommand('dshReview.elementStorageProbe', () => {
    log.appendLine(TAG + ' probe: sessDir=' + (sessDir || 'none'))
    scanAllSessions('PROBE 手动探测', false)
    log.appendLine(TAG + ' probe: known attachments total = ' + seenAtt.size)
  }))

  // ---------- B) doc open + content marker → fast path ----------

  /**
   * Close the temp tab WITHOUT any prompt, by construction:
   * save untitled -> fixed tmp file (public API, no dialog) -> doc becomes a
   * clean file doc -> closeActiveEditor (silent) -> unlink tmp.
   * CDP "Don't Save" clicker remains as fallback if the save fails.
   */
  function closeElementDoc(doc) {
    void (async () => {
      const isOurs = (d) => !!(d && (d === doc || d.uri.toString() === TMP_URI))
      const isActive = () => {
        const ae = vscode.window.activeTextEditor
        return !!(ae && isOurs(ae.document))
      }
      if (!isActive()) {
        log.appendLine(TAG + ' close: skip — element doc 不是活动编辑器(安全)')
        return
      }
      let saved = false
      try {
        saved = !!(await doc.save(vscode.Uri.file(TMP_FILE)))
      } catch (e) {
        log.appendLine(TAG + ' close: save-to-tmp 失败: ' + ((e && e.message) || e))
      }
      log.appendLine(TAG + ' close: save-to-tmp=' + saved + ' file=' + TMP_FILE)
      await sleep(300)
      let dismissResult = null
      if (isActive()) {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
      }
      if (!saved) {
        for (let i = 0; i < 3; i++) {
          await sleep(700)
          dismissResult = await bridge.dismissPrompt()
          log.appendLine(TAG + ' close: dismiss attempt ' + (i + 1) + ' -> ' + JSON.stringify(dismissResult))
          if (!vscode.workspace.textDocuments.some(isOurs)) break
          if (dismissResult && String(dismissResult.value || '').startsWith('skip-not-ours')) break
        }
      }
      await sleep(300)
      const stillOpen = vscode.workspace.textDocuments.some(isOurs)
      if (saved) {
        try { fs.unlinkSync(TMP_FILE) } catch { /* activation cleanup will catch it */ }
      }
      log.appendLine(TAG + ' close: ' + (stillOpen
        ? 'tab 仍在 — 需要手动关 (saved=' + saved + ', dismiss=' + JSON.stringify(dismissResult) + ')'
        : saved ? 'tab 已关闭(存 tmp → 关 → 删 tmp, 机制上无弹框)' : 'tab 已关闭(无弹框)'))
    })()
  }

  function handleElementDoc(doc, text) {
    const nu = parseNameUrl(text)
    markCapture(nu.name)
    log.appendLine(TAG + ' -> element ref: name=' + nu.name + ' url=' + nu.url)

    if (cfg('autoCloseTab', true)) {
      log.appendLine(TAG + ' -> close(save-to-tmp) sequence, then send')
      setTimeout(() => closeElementDoc(doc), 400)
      setTimeout(() => {
        void sendElementToDsh(nu.name, nu.url, text, null)
      }, 1100)
    } else {
      log.appendLine(TAG + ' -> autoCloseTab=off, 保留 tab')
      setTimeout(() => {
        void sendElementToDsh(nu.name, nu.url, text, null)
      }, 50)
    }
  }

  const onDocOpen = (doc) => {
    const u = doc.uri
    if (u.toString() === TMP_URI) {
      log.appendLine(TAG + ' · doc-open TMP echo (我们自己存的, skip)')
      return
    }
    const base = (u.path && u.path.split(/[\\/]/).pop()) || u.scheme
    let text = ''
    try { text = doc.getText() } catch { /* no text */ }
    if (text.indexOf(MARKER) !== -1) {
      intercept('编辑器文档打开(点 chip 触发, 瞬间)', [
        '载体: 内存文档, 尚未落盘',
        'uri: ' + u.toString(),
        'scheme: ' + u.scheme + '  base: ' + base + '  untitled: ' + doc.isUntitled,
      ], text)
      handleElementDoc(doc, text)
    } else {
      log.appendLine(TAG + ' · doc-open scheme=' + u.scheme + ' base=' + base + ' len=' + text.length)
    }
  }
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(onDocOpen))
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => {
    log.appendLine(TAG + ' · doc-close scheme=' + doc.uri.scheme + ' uri=' + doc.uri.toString())
  }))

  // ---------- C) workspace-root file watcher + content check (manual Save As) ----------
  const rootWatcher = vscode.workspace.createFileSystemWatcher('*')
  context.subscriptions.push(rootWatcher)
  const onRoot = (kind) => (uri) => {
    if (uri.scheme !== 'file') return
    const p = uri.fsPath
    let size = -1
    try { size = fs.statSync(p).size } catch { /* gone */ }
    log.appendLine(TAG + ' · root-' + kind + ' path=' + p + ' size=' + size)
    if (size > 0 && size < 200 * 1024) {
      try {
        const t = fs.readFileSync(p, 'utf8')
        if (t.indexOf(MARKER) !== -1) {
          intercept('工作区文件保存(手动 Save As)', ['文件: ' + p], t)
        }
      } catch { /* unreadable */ }
    }
  }
  rootWatcher.onDidCreate(onRoot('create'), undefined, context.subscriptions)
  rootWatcher.onDidChange(onRoot('change'), undefined, context.subscriptions)

  // ---------- D) name watcher + chatInput + dump + ping (kept for testing) ----------
  const nameWatcher = vscode.workspace.createFileSystemWatcher('**/' + NAME_PREFIX + '*')
  context.subscriptions.push(nameWatcher)
  const onName = (kind) => (uri) => log.appendLine(TAG + ' · fs-' + kind + ' path=' + uri.fsPath)
  nameWatcher.onDidCreate(onName('create'), undefined, context.subscriptions)
  nameWatcher.onDidChange(onName('change'), undefined, context.subscriptions)
  nameWatcher.onDidDelete(onName('delete'), undefined, context.subscriptions)

  let lastChangeLog = 0
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.scheme !== 'chatSessionInput') return
    const now = Date.now()
    if (now - lastChangeLog < 800) return
    lastChangeLog = now
    log.appendLine(TAG + ' · chatInput change len=' + e.document.getText().length)
  }))

  context.subscriptions.push(vscode.commands.registerCommand('dshReview.dumpDocs', () => {
    const docs = vscode.workspace.textDocuments
    log.appendLine(TAG + ' --- dump ' + docs.length + ' docs ---')
    for (const d of docs) {
      log.appendLine(TAG + ' doc ' + d.uri.scheme + ':' + d.uri.toString() + ' len=' + safeLen(d))
    }
    log.appendLine(TAG + ' --- dump done ---')
  }))

  context.subscriptions.push(vscode.commands.registerCommand('dshReview.elementWatcherPing', () => {
    log.appendLine(TAG + ' ping ' + VERSION + ' at=' + stamp() + ' (watcher alive)')
  }))

  // ---------- test: verify save-to-tmp -> silent close -> unlink (no prompt) ----------
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.testAutoClose3', async () => {
    log.appendLine(TAG + ' t3: 创建带内容的 untitled 文档 → save(tmp) → close → unlink')
    const doc = await vscode.workspace.openTextDocument({
      language: 'plaintext',
      content: 'dsh save-close test @ ' + new Date().toISOString() + '\n' + 'x'.repeat(400),
    })
    log.appendLine(TAG + ' t3: 初始 isUntitled=' + doc.isUntitled + ' isDirty=' + doc.isDirty)
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false })
    await sleep(400)
    let saved = false
    try {
      saved = !!(await doc.save(vscode.Uri.file(TMP_FILE)))
    } catch (e) {
      log.appendLine(TAG + ' t3: save(tmp) 失败: ' + ((e && e.message) || e))
    }
    log.appendLine(TAG + ' t3: save 后 saved=' + saved + ' isUntitled=' + doc.isUntitled + ' isDirty=' + doc.isDirty + ' uri=' + doc.uri.toString())
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    let dismiss = null
    await sleep(700)
    if (vscode.workspace.textDocuments.some((d) => d === doc || d.uri.toString() === TMP_URI)) {
      dismiss = await bridge.dismissPrompt()
      log.appendLine(TAG + ' t3: 仍打开, dismiss -> ' + JSON.stringify(dismiss))
      await sleep(500)
    }
    const gone = !vscode.workspace.textDocuments.some((d) => d === doc || d.uri.toString() === TMP_URI)
    try { fs.unlinkSync(TMP_FILE) } catch { /* noop */ }
    log.appendLine(TAG + ' t3: 结果 = ' + (gone ? 'CLEAN — save(tmp)+close 无弹框, tmp 已删' : 'STILL OPEN — 弹框了? 告诉我'))
  }))

  // ---------- test B: dirty + preview-mode close — does it prompt? ----------
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.testAutoClose4', async () => {
    log.appendLine(TAG + ' t4: 创建 dirty untitled → 普通打开 → 强制 preview → close')
    const doc = await vscode.workspace.openTextDocument({
      language: 'plaintext',
      content: 'dsh preview-close test @ ' + new Date().toISOString() + '\n' + 'x'.repeat(400),
    })
    log.appendLine(TAG + ' t4: 初始 isUntitled=' + doc.isUntitled + ' isDirty=' + doc.isDirty)
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false })
    await sleep(400)
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false })
    await sleep(300)
    log.appendLine(TAG + ' t4: 已切 preview — closeActiveEditor')
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    await sleep(700)
    const open = vscode.workspace.textDocuments.some((d) => d === doc)
    let dismiss = null
    if (open) {
      dismiss = await bridge.dismissPrompt()
      log.appendLine(TAG + ' t4: 仍打开(弹框?) dismiss -> ' + JSON.stringify(dismiss))
      await sleep(500)
    }
    const gone = !vscode.workspace.textDocuments.some((d) => d === doc)
    log.appendLine(TAG + ' t4: 结果 = ' + (gone ? 'CLEAN — dirty+preview 关闭无弹框, B 可行' : 'STILL OPEN — 弹框了, B 不可行'))
  }))

  log.appendLine(TAG + VERSION + ' armed — 关闭=存 tmp(' + TMP_FILE + ') → 关 → 删 tmp(机制上无弹框); 快路径发送 + jsonl 兜底')
}

module.exports = { startElementContextWatcher }
