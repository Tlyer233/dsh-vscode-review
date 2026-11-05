'use strict'

/**
 * CDP driver for the element-annotation mirror (Comment on Elements → dsh).
 *
 * The extension host cannot reach the VS Code workbench DOM directly, so it
 * talks to the workbench over CDP (VS Code is launched with
 * --remote-debugging-port=9223 by install.sh). This module:
 *   1. Finds THIS window's workbench target: the dsh composer webview (matched
 *      by its host:port) lives inside a vscode-webview iframe whose parent is
 *      the workbench page. Walking parentId up to the vscode-file page scopes
 *      us to the right window (not a sibling SSH window).
 *   2. Injects the workbench-side observer (anno-observer.js) — event-driven
 *      MutationObserver, no polling.
 *   3. Captures the observer's console beacons (Runtime.consoleAPICalled) and
 *      reports the chip+line state to the extension.
 *   4. Exposes deleteChip(name): a real click on the Copilot chip's ✕, which
 *      truly triggers the native deletion (attachmentModel.delete → the
 *      @ref line is removed → the page pin is removed/renumbered).
 *
 * Re-attach is event-driven (WebSocket close → bounded retry), never polling.
 */

const { observerSource } = require('./anno-observer.js')

const PREFIX = '__DSH_ANNO_WB__'
const MAX_RETRY = 5
const RETRY_MS = 1000

/** Minimal WebSocket CDP client (global WebSocket; Node 21+ / modern Electron). */
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Map()
    this.onClose = null
  }
  connect() {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket === 'undefined') {
        reject(new Error('global WebSocket unavailable (Node < 21)'))
        return
      }
      let settled = false
      const ws = new WebSocket(this.wsUrl)
      this.ws = ws
      const to = setTimeout(() => { if (!settled) { settled = true; reject(new Error('CDP connect timeout')) } }, 5000)
      ws.addEventListener('open', () => { if (!settled) { settled = true; clearTimeout(to); resolve() } }, { once: true })
      ws.addEventListener('error', () => { if (!settled) { settled = true; clearTimeout(to); reject(new Error('CDP ws error')) } }, { once: true })
      ws.addEventListener('close', () => { if (this.onClose) this.onClose() })
      ws.addEventListener('message', (ev) => {
        let msg
        try { msg = JSON.parse(String(ev.data)) } catch { return }
        if (msg.id && this.pending.has(msg.id)) {
          const h = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          h(msg.result || null, msg.error)
        } else if (msg.method) {
          const cbs = this.listeners.get(msg.method)
          if (cbs) for (const cb of [...cbs]) { try { cb(msg.params) } catch { /* listener error */ } }
        }
      })
    })
  }
  send(method, params) {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== 1) { resolve(null); return }
      const id = ++this.seq
      const to = setTimeout(() => { this.pending.delete(id); resolve(null) }, 15000)
      this.pending.set(id, (result) => { clearTimeout(to); resolve(result) })
      try {
        this.ws.send(JSON.stringify({ id, method, params: params || {} }))
      } catch (e) {
        clearTimeout(to); this.pending.delete(id); resolve(null)
      }
    })
  }
  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(cb)
  }
  close() {
    try { if (this.ws) this.ws.close() } catch { /* noop */ }
    this.ws = null
  }
}

/** @returns {Promise<object[]>} CDP targets from /json/list. */
async function listTargets(port) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(2500) })
  return res.json()
}

/**
 * Find the workbench (vscode-file page) that owns the dsh composer at hostPort.
 * @param {object[]} targets
 * @param {string} hostPort e.g. "127.0.0.1:3081"
 * @returns {object|null}
 */
function findWorkbenchForDsh(targets, hostPort, bootTs) {
  if (!hostPort && !bootTs) return null
  const byId = new Map(targets.map((t) => [t.id, t]))
  let dshTarget = null
  // (2.1.5) host:port ALONE cannot identify the owning window when TWO
  // remote windows proxy the same host (two SSH windows → both
  // 100.85.98.34:3082): the first driver grabbed the other window's
  // workbench and the real window stayed driverless ("Copilot anno not
  // carried on send"). The iframe src carries a per-window unique
  // `_dshVscode=<ts>` — match that first, host only as fallback.
  if (bootTs) {
    const needle = '_dshVscode=' + bootTs
    for (const t of targets) {
      if (t.type !== 'iframe') continue
      if (String(t.url || '').indexOf(needle) !== -1) { dshTarget = t; break }
    }
  }
  if (!dshTarget && hostPort) {
  for (const t of targets) {
    if (t.type !== 'iframe') continue
    const url = String(t.url || '')
    if (url.indexOf('http') !== 0) continue
    let host
    try { host = new URL(url).host } catch { continue }
    if (host === hostPort) { dshTarget = t; break }
  }
  }
  if (!dshTarget) return null
  let cur = dshTarget
  while (cur && cur.parentId) {
    const par = byId.get(cur.parentId)
    if (!par) break
    if (par.type === 'page' && String(par.url || '').indexOf('vscode-file') !== -1) return par
    cur = par
  }
  return null
}

/**
 * @param {{
 *   log: (s: string) => void,
 *   cdpPort?: number,
 *   getDshHostPort: () => Promise<string>,
 *   onState: (chips: object[], lines: object[]) => void,
 *   onOpened?: () => void,
 * }} opts
 */
class AnnoDriver {
  constructor(opts) {
    this.log = opts.log || (() => {})
    this.cdpPort = opts.cdpPort || 9223
    this.getDshHostPort = opts.getDshHostPort || (async () => '')
    this.onState = opts.onState || (() => {})
    this.onOpened = opts.onOpened || (() => {})
    this.cdp = null
    this.workbenchId = null
    this.closing = false
    this.retryCount = 0
    this._retryTimer = null
  }

  async start() {
    this.closing = false
    this.retryCount = 0
    return this._attach()
  }

  async _attach() {
    let targets
    try {
      targets = await listTargets(this.cdpPort)
    } catch (e) {
      this.log('CDP ' + this.cdpPort + ' unavailable: ' + ((e && e.message) || e))
      this._scheduleRetry()
      return false
    }
    const hostPort = await this.getDshHostPort()
    let bootTs = ''
    try { bootTs = this.getDshBootTs ? String(await this.getDshBootTs() || '') : '' } catch (e) { bootTs = '' }
    const wb = findWorkbenchForDsh(targets, hostPort, bootTs)
    if (!wb) {
      this.log('no workbench for dsh ' + (hostPort || '?') + ' (targets=' + targets.length + ')')
      this._scheduleRetry()
      return false
    }
    const cdp = new CDP(wb.webSocketDebuggerUrl)
    cdp.onClose = () => this._onWsClose()
    try {
      await cdp.connect()
    } catch (e) {
      this.log('CDP connect failed: ' + ((e && e.message) || e))
      this._scheduleRetry()
      return false
    }
    this.cdp = cdp
    this.workbenchId = wb.id
    this.retryCount = 0
    await cdp.send('Runtime.enable')
    cdp.on('Runtime.consoleAPICalled', (params) => this._onConsole(params))
    // (2.1.7) RELOAD-AWARE INJECTION. A page reload keeps this CDP socket
    // (no close event) but WIPES window.__dshAnnoWb — the driver then looks
    // healthy while the observer is gone: beacons stop, dock empties, sends
    // silently drop the Copilot anno (caught red-handed 13:36: DOM chip
    // 'Attached element, span (Delete)' present, observer NO-OBS).
    // Target id == root frame id (CDP contract): when THAT frame navigates,
    // re-inject. Page reload = exactly one such event.
    await cdp.send('Page.enable')
    cdp.on('Page.frameNavigated', (params) => {
      const f = params && params.frame
      if (this.closing || !this.cdp || !f) return
      if (String(f.id) !== String(this.workbenchId)) return
      if (this._navTimer) clearTimeout(this._navTimer)
      this._navTimer = setTimeout(() => {
        this._navTimer = null
        if (this.closing || !this.cdp) return
        this.cdp.send('Runtime.evaluate', { expression: observerSource(), returnByValue: true }).then((r) => {
          const v = (r && r.result && r.result.value) || 'failed'
          if (String(v).indexOf('page navigated') === -1) this.log('page navigated → observer re-inject → ' + v)
        }).catch(() => { /* socket raced a close; re-attach path covers it */ })
      }, 400)
    })
    const r = await cdp.send('Runtime.evaluate', { expression: observerSource(), returnByValue: true })
    this.log('observer inject → ' + ((r && r.result && r.result.value) || 'failed'))
    return true
  }

  _scheduleRetry() {
    if (this.closing || this._retryTimer) return
    if (this.retryCount >= MAX_RETRY) {
      this.log('giving up after ' + MAX_RETRY + ' retries (CDP/workbench unavailable)')
      return
    }
    this.retryCount++
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null
      if (!this.closing) this._attach().catch((e) => this.log('re-attach failed: ' + ((e && e.message) || e)))
    }, RETRY_MS)
  }

  /**
   * (2.1.7) On-demand revival: the 5×1s startup budget expires while the
   * dsh panel is still closed in a remote window; the first real use
   * (panel-resolve kick, chip read) re-attaches once, throttled to 20s.
   * @returns {Promise<boolean>} true when a live CDP session exists
   */
  async ensure() {
    if (this.cdp) return true
    const now = Date.now()
    if (this._lastEnsureAt && now - this._lastEnsureAt < 20000) return false
    this._lastEnsureAt = now
    this.retryCount = 0
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null }
    try { return await this._attach() } catch (e) {
      this.log('ensure attach failed: ' + ((e && e.message) || e))
      return false
    }
  }

  _onWsClose() {
    if (this.closing) return
    this.cdp = null
    this.log('workbench CDP closed (window reload?) — re-attaching')
    this._scheduleRetry()
  }

  _onConsole(params) {
    if (!params || params.type !== 'log') return
    const args = params.args || []
    for (const a of args) {
      const v = a && a.value
      if (typeof v !== 'string' || v.indexOf(PREFIX) !== 0) continue
      let payload
      try { payload = JSON.parse(v.slice(PREFIX.length)) } catch { continue }
      if (payload && payload.ev === 'state') {
        this.onState(payload.chips || [], payload.lines || [])
      } else if (payload && payload.ev === 'widget-opened') {
        // (0.1.117) Copilot panel (re)opened: arm the flash-back upstream.
        this.onOpened()
      }
    }
  }

  /**
   * Click the ✕ of the Copilot element chip named `name`, truly triggering the
   * native deletion. @param {string} name e.g. "div#count"
   * @returns {Promise<string>} "clicked:<name>" | "not-found:<name>" | ...
   */
  async deleteChip(name) {
    if (!this.cdp) return 'no-cdp'
    const expr = 'window.__dshAnnoWb && window.__dshAnnoWb.deleteChip(' + JSON.stringify(name) + ')'
    const r = await this.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
    return (r && r.result) ? String(r.result.value) : 'failed'
  }

  /**
   * Evaluate an expression in the workbench page and return the value.
   * @param {string} expression
   * @returns {Promise<any|null>} the value, or null when CDP is not attached
   */
  async eval(expression) {
    if (!this.cdp) return null
    try {
      const r = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true })
      return r && r.result ? r.result.value : null
    } catch (e) {
      return null
    }
  }

  stop() {
    this.closing = true
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null }
    if (this.cdp) { this.cdp.close(); this.cdp = null }
  }
}

module.exports = { AnnoDriver, CDP, listTargets, findWorkbenchForDsh, PREFIX }
