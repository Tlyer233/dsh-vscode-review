'use strict'

/**
 * v18 — CDP element-chip auto-clicker (immediate commit + hint + prompt dismissal).
 *
 * v18 fixes:
 *  - REMOVED 'probing' state (it deadlocked without the old 2s scan: the
 *    second scan never came when the DOM went quiet -> 15s waits).
 *  - 'never' commits IMMEDIATELY on first visibility. New chips are
 *    discriminated by a baseline HINT: the element-attachment count of the
 *    newest chatSessions jsonl at connect time (VS Code's own flush lags,
 *    so chips beyond the hint are genuinely new selections).
 *  - window.__dshDismissPrompt(): clicks "Don't Save" on the VS Code modal
 *    (only when the dialog text mentions Attached Element Context/Untitled).
 *    Registered on the shared element-bridge for the watcher.
 *  - Hot path unchanged: MO 200ms debounce, 50ms click, watchdog 45s.
 */

const vscode = require('vscode')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const bridge = require('./element-bridge')

const CDP_PORT = 9223
const TAG = '[cdp]'
const CHIP_PREFIX = '__DSH_CHIP__'

const OBSERVER_JS = `(() => {
  if (window.__dshChipSniffer) return 'already'
  window.__dshChipSniffer = true
  const seenEls = new WeakSet()
  let state = 'never'
  let visibleCount = 0
  let lastHb = Date.now()
  let lastErr = 0

  function chatRoot() {
    let cands = Array.from(document.querySelectorAll('[class*="chat-viewpane" i]'))
    let best = null
    for (const c of cands) {
      const r = c.getBoundingClientRect()
      if (r.width < 100 || r.height < 60) continue
      const area = r.width * r.height
      if (!best || area > best.score) best = { el: c, score: area }
    }
    if (best) return best.el
    cands = Array.from(document.querySelectorAll('[class*="chat" i]'))
    best = null
    for (const c of cands) {
      const r = c.getBoundingClientRect()
      if (r.width < 150 || r.height < 80) continue
      const hasEditor = !!c.querySelector('[class*="monaco-editor"], [contenteditable="true"]')
      const score = r.width * r.height * (hasEditor ? 2 : 1)
      if (!best || score > best.score) best = { el: c, score }
    }
    return best ? best.el : null
  }

  function findElementChips(root) {
    const els = Array.from(root.querySelectorAll('.chat-attached-context-attachment'))
    const out = []
    for (const el of els) {
      const label = el.getAttribute('aria-label') || ''
      if (label.indexOf('Attached element') !== 0) continue
      const name = label.replace(/^Attached element,\\s*/, '').replace(/\\s*\\(Delete\\)$/, '').slice(0, 90)
      out.push({ el, name, cls: String(el.className).slice(0, 80) })
    }
    return out
  }

  function log(obj) {
    try { console.log('__DSH_CHIP__' + JSON.stringify(obj)) } catch (e) { /* noop */ }
  }

  function clickChip(chip, why) {
    setTimeout(() => {
      try {
        chip.el.click()
        log({ ev: 'CLICKED', what: chip.name, why })
      } catch (e) {
        log({ ev: 'click-err', e: String((e && e.message) || e) })
      }
      if (window.__dshCleanChip) {
        setTimeout(() => {
          try {
            const x = chip.el.querySelector('a[aria-label*="Remove from context"], a[class*="codicon-close"]')
            if (x) { x.click(); log({ ev: 'chip-cleaned', what: chip.name }) }
          } catch (e) {
            log({ ev: 'clean-err', e: String((e && e.message) || e) })
          }
        }, 600)
      }
    }, 50)
  }

  // Auto-dismiss the "save changes?" modal that appears when we close the
  // dirty untitled element-context doc. ONLY for our dialogs.
  window.__dshDismissPrompt = function () {
    try {
      const dlg = document.querySelector('.monaco-dialog-box, [role="dialog"]')
      if (!dlg) return 'no-dialog'
      const txt = (dlg.textContent || '')
      if (!/attached element context|untitled/i.test(txt)) return 'skip-not-ours: ' + txt.slice(0, 60)
      const btns = Array.from(dlg.querySelectorAll('a, button, [role="button"]'))
      const target = btns.find((b) => {
        const t = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).replace(/\\u2019/g, "'")
        return /don'?t save|do not save/i.test(t)
      })
      if (!target) return 'no-dontsave: ' + btns.slice(0, 6).map((b) => (b.textContent || '').trim().slice(0, 20)).join('|')
      target.click()
      return 'dismissed'
    } catch (e) { return 'err: ' + String((e && e.message) || e) }
  }

  function maybeHb(n) {
    const now = Date.now()
    if (now - lastHb > 30000) {
      lastHb = now
      log({ ev: 'hb', state, n })
    }
  }

  function scan() {
    try {
      heal()
      const root = chatRoot()
      if (!root) {
        if (state === 'visible') {
          state = 'hidden'
          log({ ev: 'hidden', count: visibleCount })
        }
        return
      }
      const chips = findElementChips(root)
      const n = chips.length
      if (state === 'never') {
        state = 'visible'
        visibleCount = n
        chips.forEach((c) => seenEls.add(c.el))
        const hint = (typeof window.__dshBaselineHint === 'number') ? window.__dshBaselineHint : -1
        if (hint >= 0 && n > hint && (n - hint) <= 5) {
          const newest = chips[n - 1]
          log({ ev: 'NEW-after-injection', n, hint, what: newest.name, cls: newest.cls })
          clickChip(newest, 'after-injection')
        } else {
          log({ ev: 'BASELINE', n, hint, list: chips.slice(0, 8).map((c) => c.name) })
        }
        return
      }
      if (state === 'hidden') {
        state = 'visible'
        if (n > visibleCount) {
          const newest = chips[n - 1]
          log({ ev: 'NEW-after-hidden', n, added: n - visibleCount, what: newest.name, cls: newest.cls })
          if (!seenEls.has(newest.el)) { seenEls.add(newest.el); clickChip(newest, 'after-hidden') }
          visibleCount = n
        } else {
          visibleCount = n
          chips.forEach((c) => seenEls.add(c.el))
          log({ ev: 'visible-again', n })
        }
        return
      }
      // state === 'visible'
      if (n > visibleCount) {
        const newest = chips[n - 1]
        log({ ev: 'NEW', n, added: n - visibleCount, what: newest.name, cls: newest.cls })
        if (!seenEls.has(newest.el)) { seenEls.add(newest.el); clickChip(newest, 'count-up') }
        visibleCount = n
      } else if (n < visibleCount) {
        visibleCount = n
        log({ ev: 'fp', n, note: 'chip removed' })
      }
      maybeHb(n)
    } catch (e) {
      const now = Date.now()
      if (now - lastErr > 5000) {
        lastErr = now
        log({ ev: 'err', e: String((e && e.stack || e.message || e)).slice(0, 200) })
      }
    }
  }

  // MutationObserver with self-heal (body can be replaced by the workbench)
  let moT = 0
  let mo = null
  let moTarget = null
  function attachMo() {
    try { if (mo) mo.disconnect() } catch (e) { /* noop */ }
    mo = new MutationObserver(() => {
      const now = Date.now()
      if (now - moT > 200) { moT = now; scan() }
    })
    moTarget = document.body
    mo.observe(moTarget, { childList: true, subtree: true, characterData: true })
  }
  function heal() {
    if (!mo || moTarget !== document.body || !moTarget || !moTarget.isConnected) attachMo()
  }
  attachMo()
  window.addEventListener('focus', heal, true)
  document.addEventListener('visibilitychange', heal)
  scan()
  log({ ev: 'installed' })
  return 'installed'
})()`

const DUMP_JS = `(() => {
  const cands = Array.from(document.querySelectorAll('[class*="chat-viewpane" i]'))
  let pane = null
  for (const c of cands) {
    const r = c.getBoundingClientRect()
    if (r.width < 100 || r.height < 60) continue
    if (!pane || r.width * r.height > pane.area) pane = { el: c, area: r.width * r.height }
  }
  if (!pane) return { err: 'chat-viewpane not found (chat open?)' }
  const all = Array.from(pane.el.querySelectorAll('.chat-attached-context-attachment'))
  return {
    paneCls: String(pane.el.className).slice(0, 120),
    attachments: all.map((el) => ({
      label: (el.getAttribute('aria-label') || '').slice(0, 120),
      cls: String(el.className).slice(0, 100),
      html: (el.outerHTML || '').slice(0, 300),
    })),
  }
})()`

function fetchCdpTargets(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 2500 }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error('bad json: ' + e.message)) }
      })
    })
    req.on('error', (e) => reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function findWorkbenchPage(targets) {
  const pages = (targets || []).filter((t) => t.type === 'page')
  return (
    pages.find((t) => /workbench/.test(String(t.url))) ||
    pages.find((t) => /vscode|code/.test(String(t.url))) ||
    pages[0]
  )
}

function readPayload(ev) {
  const p = (ev && typeof ev.data !== 'undefined') ? ev.data : ev
  return typeof p === 'string' ? p : (p && p.toString ? p.toString() : String(p))
}

function getCleanChip() {
  try { return !!vscode.workspace.getConfiguration('dshReview.elementContext').get('cleanChip', false) } catch { return false }
}

/**
 * Baseline hint: unique element-attachment count in the NEWEST chatSessions
 * jsonl. VS Code's flush lags selections, so chips beyond this count are
 * genuinely new (selected after the last flush). -1 = unknown.
 */
function getBaselineHint(context) {
  try {
    if (!context.storageUri) return -1
    const sessDir = path.join(path.dirname(context.storageUri.fsPath), 'chatSessions')
    const files = fs.readdirSync(sessDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, m: fs.statSync(path.join(sessDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    if (!files.length) return -1
    const raw = fs.readFileSync(path.join(sessDir, files[0].f), 'utf8')
    const ids = new Set()
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      let atts = null
      if (o.kind === 0 && o.v && o.v.inputState && Array.isArray(o.v.inputState.attachments)) atts = o.v.inputState.attachments
      else if (o.kind === 1 && Array.isArray(o.k) && o.k[0] === 'inputState' && o.k[1] === 'attachments' && Array.isArray(o.v)) atts = o.v
      if (atts) for (const a of atts) if (a && a.kind === 'element' && a.id) ids.add(a.id)
    }
    return ids.size
  } catch {
    return -1
  }
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').OutputChannel} log
 */
function startCdpProbe(context, log) {
  let WS
  let wsKind
  if (typeof globalThis.WebSocket === 'function') {
    WS = globalThis.WebSocket; wsKind = 'native'
  } else {
    WS = require('ws'); wsKind = 'ws@' + require('ws/package.json').version
  }
  log.appendLine(TAG + ' v18 — 立即提交(无 probing 死锁) + jsonl hint 识别新 chip + Don\'t Save 自动点击')

  let stopped = false
  let ws = null
  let currentTarget = null
  let seq = 0
  let lastNoCdp = 0
  let dumpPending = null
  let lastExcLog = 0
  let watchdog = null
  let probe = null
  const pending = new Map()

  function send(method, params) {
    if (!ws || ws.readyState !== 1) return null
    const id = ++seq
    try { ws.send(JSON.stringify({ id, method, params: params || {} })) } catch (e) { return null }
    return id
  }

  function evalOnce(expression, tag) {
    const id = send('Runtime.evaluate', { expression, returnByValue: true, timeout: 3000 })
    if (id === null) { log.appendLine(TAG + ' ' + tag + ': send failed'); return }
    const to = setTimeout(() => pending.delete(id), 8000)
    pending.set(id, { tag, to })
  }

  function evalOncePromise(expression, tag) {
    return new Promise((resolve) => {
      const id = send('Runtime.evaluate', { expression, returnByValue: true, timeout: 3000 })
      if (id === null) { resolve({ ok: false, why: 'send-failed' }); return }
      const to = setTimeout(() => { pending.delete(id); resolve({ ok: false, why: 'timeout' }) }, 8000)
      pending.set(id, { tag, to, resolve: (v) => resolve({ ok: true, value: v }) })
    })
  }

  function armWatchdog() {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      watchdog = null
      if (stopped || !ws || probe) return
      log.appendLine(TAG + ' liveness: CDP 静默 45s — probe 1+1')
      const id = send('Runtime.evaluate', { expression: '1+1', returnByValue: true, timeout: 3000 })
      if (id === null) {
        log.appendLine(TAG + ' liveness: probe send failed — 强制重连')
        teardown()
        return
      }
      probe = {
        id,
        timer: setTimeout(() => {
          probe = null
          log.appendLine(TAG + ' liveness: probe 5s 无响应 — 强制重连(zombie ws)')
          teardown()
        }, 5000),
      }
    }, 45000)
  }

  function logChip(d) {
    if (d.ev === 'installed') log.appendLine(TAG + ' observer installed')
    else if (d.ev === 'BASELINE') log.appendLine(TAG + ' BASELINE n=' + d.n + ' hint=' + d.hint + ' ' + JSON.stringify(d.list))
    else if (d.ev === 'NEW') log.appendLine(TAG + ' >>> NEW #' + d.n + ' (+' + d.added + ') ' + String(d.what).trim() + ' [' + d.cls + ']')
    else if (d.ev === 'NEW-after-hidden') log.appendLine(TAG + ' >>> NEW-after-hidden #' + d.n + ' (+' + d.added + ') ' + String(d.what).trim() + ' [' + d.cls + ']')
    else if (d.ev === 'NEW-after-injection') log.appendLine(TAG + ' >>> NEW-after-injection #' + d.n + ' (hint=' + d.hint + ') ' + String(d.what).trim() + ' [' + d.cls + ']')
    else if (d.ev === 'visible-again') log.appendLine(TAG + ' chat visible again, n=' + d.n)
    else if (d.ev === 'CLICKED') log.appendLine(TAG + ' CLICKED: ' + String(d.what).trim() + ' (why=' + d.why + ')')
    else if (d.ev === 'click-err') log.appendLine(TAG + ' click error: ' + d.e)
    else if (d.ev === 'chip-cleaned') log.appendLine(TAG + ' chip cleaned: ' + String(d.what).trim())
    else if (d.ev === 'clean-err') log.appendLine(TAG + ' clean error: ' + d.e)
    else if (d.ev === 'hidden') log.appendLine(TAG + ' chat hidden (count=' + d.count + ')')
    else if (d.ev === 'fp') log.appendLine(TAG + ' fp n=' + d.n + (d.note ? ' (' + d.note + ')' : ''))
    else if (d.ev === 'hb') log.appendLine(TAG + ' hb: state=' + d.state + ' n=' + d.n)
    else if (d.ev === 'err') log.appendLine(TAG + ' OBSERVER ERR: ' + d.e)
    else log.appendLine(TAG + ' chip ev: ' + JSON.stringify(d).slice(0, 300))
  }

  function onMessage(ev) {
    let msg
    try { msg = JSON.parse(readPayload(ev)) } catch (e) { return }
    armWatchdog()
    if (probe && msg.id === probe.id) {
      clearTimeout(probe.timer)
      probe = null
      log.appendLine(TAG + ' liveness: probe ok — ws alive')
      return
    }
    const pe = pending.get(msg.id)
    if (pe) {
      pending.delete(msg.id)
      clearTimeout(pe.to)
      const val = msg.result && msg.result.result && msg.result.result.value
      if (pe.resolve) pe.resolve(val)
      log.appendLine(TAG + ' ' + pe.tag + ': ' + JSON.stringify(val))
      return
    }
    if (msg.id && dumpPending && msg.id === dumpPending.id) {
      const val = msg.result && msg.result.result && msg.result.result.value
      const done = dumpPending
      dumpPending = null
      if (msg.error || !val) log.appendLine(TAG + ' dump failed: ' + ((msg.error && msg.error.message) || 'no value'))
      else if (val.err) log.appendLine(TAG + ' dump: ' + val.err)
      else {
        log.appendLine(TAG + ' dump pane=' + val.paneCls + ' attachments=' + (val.attachments || []).length)
        for (const a of val.attachments || []) {
          log.appendLine(TAG + '   LABEL=[' + a.label + '] CLS=' + a.cls)
          log.appendLine(TAG + '   HTML: ' + a.html)
        }
      }
      done.resolve()
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const arg = msg.params && msg.params.args && msg.params.args[0] && msg.params.args[0].value
      if (typeof arg === 'string' && arg.indexOf(CHIP_PREFIX) === 0) {
        let d
        try { d = JSON.parse(arg.slice(CHIP_PREFIX.length)) } catch (e) { return }
        logChip(d)
      }
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const now = Date.now()
      if (now - lastExcLog < 5000) return
      const det = msg.params && msg.params.exceptionDetails
      const text = det && ((det.exception && (det.exception.description || det.exception.value)) || det.text)
      if (typeof text === 'string' && /chip|__dsh|chatRoot|findElementChips/i.test(text)) {
        lastExcLog = now
        log.appendLine(TAG + ' renderer exception: ' + String(text).slice(0, 200))
      }
    }
  }

  function teardown() {
    if (watchdog) { clearTimeout(watchdog); watchdog = null }
    if (probe) { clearTimeout(probe.timer); probe = null }
    pending.forEach((p) => clearTimeout(p.to))
    pending.clear()
    if (ws) {
      try { ws.onmessage = null } catch (e) { /* noop */ }
      try { ws.onerror = null } catch (e) { /* noop */ }
      try { ws.onclose = null } catch (e) { /* noop */ }
      try { ws.close() } catch (e) { /* noop */ }
    }
    ws = null
    currentTarget = null
  }

  async function connect() {
    if (stopped || ws) return
    let targets
    try {
      targets = await fetchCdpTargets(CDP_PORT)
    } catch (e) {
      const now = Date.now()
      if (now - lastNoCdp > 60000) {
        lastNoCdp = now
        log.appendLine(TAG + ' CDP not reachable (' + ((e && e.code) || e.message) + ') — 需要 --remote-debugging-port=' + CDP_PORT)
      }
      return
    }
    const page = findWorkbenchPage(targets)
    if (!page || !page.webSocketDebuggerUrl) return
    if (currentTarget === page.id) return
    teardown()
    ws = new WS(page.webSocketDebuggerUrl)
    currentTarget = page.id
    ws.onopen = () => {
      const clean = getCleanChip()
      const hint = getBaselineHint(context)
      log.appendLine(TAG + ' connected ' + String(page.id).slice(0, 12) + ' — injecting (cleanChip=' + clean + ', hint=' + hint + ')')
      send('Runtime.enable')
      send('Runtime.evaluate', {
        expression: 'window.__dshCleanChip = ' + JSON.stringify(clean)
          + '; window.__dshBaselineHint = ' + JSON.stringify(hint) + ';' + '\n' + OBSERVER_JS,
        awaitPromise: false, returnByValue: true, timeout: 8000,
      })
      armWatchdog()
      setTimeout(() => {
        if (ws && !stopped) evalOnce('window.__dshChipSniffer ? "alive" : "dead"', 'observer-liveness')
      }, 10000)
    }
    ws.onmessage = onMessage
    ws.onerror = (e) => {
      log.appendLine(TAG + ' ws error: ' + ((e && e.message) || 'unknown'))
      teardown()
    }
    ws.onclose = () => {
      if (!stopped) log.appendLine(TAG + ' ws closed — will reconnect')
      teardown()
    }
  }

  // expose prompt dismissal to the watcher via the shared bridge
  bridge.setDismissPrompt(() => evalOncePromise(
    'window.__dshDismissPrompt ? window.__dshDismissPrompt() : "observer-not-installed"',
    'dismiss-prompt',
  ))

  const dumpCmd = vscode.commands.registerCommand('dshReview.cdpChipDump', () => {
    if (!ws || ws.readyState !== 1) { log.appendLine(TAG + ' dump: not connected'); return }
    const id = send('Runtime.evaluate', {
      expression: DUMP_JS, awaitPromise: false, returnByValue: true, timeout: 8000,
    })
    if (id === null) { log.appendLine(TAG + ' dump: send failed'); return }
    log.appendLine(TAG + ' dump requested')
    const to = setTimeout(() => {
      if (dumpPending && dumpPending.id === id) { dumpPending = null; log.appendLine(TAG + ' dump timeout') }
    }, 10000)
    dumpPending = { id, resolve: () => clearTimeout(to) }
  })
  context.subscriptions.push(dumpCmd)

  const pingCmd = vscode.commands.registerCommand('dshReview.cdpPing', () => {
    if (!ws || ws.readyState !== 1) { log.appendLine(TAG + ' ping: not connected (ws=' + (ws ? ws.readyState : 'null') + ')'); return }
    evalOnce('Date.now()', 'ping')
  })
  context.subscriptions.push(pingCmd)

  connect()
  // disconnect-only retry: zero cost while connected, not a hot path
  const t = setInterval(() => { if (!ws) connect() }, 5000)
  context.subscriptions.push({ dispose: () => { stopped = true; clearInterval(t); teardown() } })
}

module.exports = { startCdpProbe }
