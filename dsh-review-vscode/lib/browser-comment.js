'use strict'

/**
 * Browser pages over CDP: probe elements on demand.
 *
 * 0.1.49: this module used to draw our own annotation UI in the page (a "dsh ✎" button, a
 * pick mode, an in-place box, numbered pins). That whole path is gone — VS Code's native
 * ⌥⌘C comment flow now feeds dsh (the watcher reads the composer document), so the page
 * side only has to answer one question: "give me everything about the element the user just
 * commented on". No UI, no clicks intercepted, no globals except one probe object.
 *
 * Requires VS Code started with remote-debugging-port (argv.json, written by install.sh).
 */
const vscode = require('vscode')
const bridge = require('./element-bridge')

const CDP_PORT = 9223
const TAG = '[browser-comment]'
const PREFIX = '__DSH_BCC__'
const VERSION = 'v7'
const RESCAN_MS = 2500

async function fetchTargets(port) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(2500) })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

function isBrowserPage(t) {
  if (!t || t.type !== 'page') return false
  const u = String(t.url || '')
  if (!/^https?:\/\//.test(u)) return false
  if (u.indexOf('workbench.html') !== -1) return false
  if (u.indexOf('vscode-webview://') !== -1) return false
  if (u.indexOf('vscode-file://') === 0) return false
  return true
}

/**
 * Page-side script: one lookup function, no UI. Written with string concatenation and
 * without backticks because it lives inside a template literal here and ships as text.
 */
const PROBE_JS = `(function () {
  if (window.__dshProbe && window.__dshProbe.version === 'v7') return 'already'
  var CSS_KEYS = ['color', 'background-color', 'font-size', 'font-weight', 'font-family', 'line-height',
    'display', 'position', 'top', 'left', 'width', 'height', 'margin', 'padding', 'border', 'border-radius',
    'z-index', 'opacity', 'text-align', 'cursor', 'overflow']

  function clsOf(el) {
    // SVG elements expose className as an SVGAnimatedString object, so String(el.className)
    // printed "[object SVGAnimatedString]" into the label and the class list.
    var c = ''
    try { c = (typeof el.getAttribute === 'function' && el.getAttribute('class')) || '' } catch (e) { c = '' }
    if (!c && typeof el.className === 'string') c = el.className
    return String(c).split(/\\s+/).filter(Boolean)
  }

  function labelFor(el) {
    var r = el.getBoundingClientRect()
    var cls = clsOf(el)
    return String(el.tagName || '').toLowerCase() +
      (el.id ? '#' + el.id : '') +
      (cls.length ? '.' + cls[0] : '') +
      ' ' + Math.round(r.width) + ' \\u00d7 ' + Math.round(r.height)
  }

  function selectorFor(el) {
    if (el.id) return '#' + el.id
    var parts = []
    var node = el
    for (var depth = 0; node && node.tagName && depth < 5; depth++) {
      var name = node.tagName.toLowerCase()
      var cls = clsOf(node)
      if (cls.length) name += '.' + cls[0]
      var parent = node.parentElement
      if (parent) {
        var sibs = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName })
        if (sibs.length > 1) name += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')'
      }
      parts.unshift(name)
      if (node.id) break
      node = parent
    }
    return parts.join(' > ')
  }

  function bits(el) {
    var r = el.getBoundingClientRect()
    var cs = window.getComputedStyle(el)
    var anc = []
    var n = el.parentElement
    for (var i = 0; n && i < 6; i++) {
      anc.push(String(n.tagName || '').toLowerCase() + (n.id ? '#' + n.id : '') + (clsOf(n).length ? '.' + clsOf(n)[0] : ''))
      n = n.parentElement
    }
    var at = {}
    for (var j = 0; j < el.attributes.length && j < 15; j++) {
      var a = el.attributes[j]
      at[a.name] = String(a.value).slice(0, 80)
    }
    var css = {}
    for (var k = 0; k < CSS_KEYS.length; k++) {
      try { css[CSS_KEYS[k]] = String(cs.getPropertyValue(CSS_KEYS[k]) || '').slice(0, 120) } catch (e) { /* noop */ }
    }
    var html = String(el.outerHTML || '')
    if (html.length > 4000) html = html.slice(0, 4000) + ' …(截断)'
    return {
      tag: String(el.tagName || '').toLowerCase(),
      id: el.id || '',
      classes: clsOf(el).slice(0, 10),
      attributes: at,
      ancestors: anc,
      selector: selectorFor(el),
      innerText: String(el.innerText || el.textContent || '').slice(0, 400),
      outerHTML: html,
      bounds: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      computed: css,
      devicePixelRatio: window.devicePixelRatio || 1,
    }
  }

  function find(q) {
    q = String(q || '').trim()
    if (!q) return null
    var el = null
    try { el = document.querySelector(q) } catch (e) { el = null }
    if (el) return el
    var tok = q.split(/\\s+/)[0]
    if (tok && tok !== q) { try { el = document.querySelector(tok) } catch (e) { el = null } }
    if (el) return el
    // last resort: match the label we print (tag#id.cls W × H) against every node
    var all = document.querySelectorAll('*')
    var limit = Math.min(all.length, 4000)
    for (var i = 0; i < limit; i++) {
      try { if (labelFor(all[i]) === q) return all[i] } catch (e) { /* noop */ }
    }
    return null
  }

  window.__dshProbe = {
    version: 'v7',
    ping: function () { return 'v7 ' + location.href },
    lookup: function (q) {
      var el = find(q)
      if (!el) return JSON.stringify({ ok: false, q: q, url: location.href })
      var b = bits(el)
      b.ok = true
      b.label = labelFor(el)
      b.url = location.href
      b.title = document.title || ''
      return JSON.stringify(b)
    },
  }
  try { console.log('${PREFIX}' + JSON.stringify({ ev: 'installed', url: location.href, probe: VERSION })) } catch (e) { /* noop */ }
  return 'installed'
})()`

function startBrowserComment(opts) {
  const { context, log } = opts
  let WS
  if (typeof globalThis.WebSocket === 'function') WS = globalThis.WebSocket
  else WS = require('ws')

  const conns = new Map() // targetId -> { ws, url, since }
  const pending = new Map() // rpc id -> callback
  let rpcSeq = 400
  let stopped = false
  let lastAbsent = 0
  let lastSeenCount = -1

  function enabled() {
    try {
      return !!vscode.workspace.getConfiguration('dshReview.browserComment').get('sendToDsh', true)
    } catch { return false }
  }

  function closeOne(id, why) {
    const c = conns.get(id)
    if (!c) return
    conns.delete(id)
    try { c.ws.onmessage = null; c.ws.onclose = null; c.ws.onerror = null } catch { /* noop */ }
    try { c.ws.close() } catch { /* noop */ }
    if (why) log.appendLine(TAG + ' drop ' + String(id).slice(0, 8) + ' (' + why + ')')
  }

  function attach(target) {
    const ws = new WS(target.webSocketDebuggerUrl)
    conns.set(target.id, { ws, url: String(target.url || ''), since: Date.now() })
    ws.onopen = () => {
      log.appendLine(TAG + ' attached ' + String(target.id).slice(0, 8) + ' ' + String(target.url).slice(0, 70))
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable', params: {} }))
      ws.send(JSON.stringify({
        id: 2, method: 'Runtime.evaluate',
        params: { expression: PROBE_JS, returnByValue: true, timeout: 5000 },
      }))
    }
    ws.onmessage = (ev) => {
      let raw = ev && ev.data
      if (raw && typeof raw !== 'string') { try { raw = String(raw) } catch { return } }
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (pending.has(msg.id)) {
        const cb = pending.get(msg.id)
        pending.delete(msg.id)
        const v = msg.result && msg.result.result && msg.result.result.value
        let parsed = null
        try { parsed = typeof v === 'string' ? JSON.parse(v) : v } catch { parsed = null }
        cb(parsed)
        return
      }
      if (msg.method !== 'Runtime.consoleAPICalled') return
      const arg = msg.params && msg.params.args && msg.params.args[0] && msg.params.args[0].value
      if (typeof arg !== 'string' || arg.indexOf(PREFIX) !== 0) return
      let d
      try { d = JSON.parse(arg.slice(PREFIX.length)) } catch { return }
      if (d.ev === 'installed') log.appendLine(TAG + ' probe ' + VERSION + ' ready ' + String(d.url || '').slice(0, 70))
      else if (d.ev === 'err') log.appendLine(TAG + ' page error: ' + String(d.e).slice(0, 160))
    }
    ws.onclose = () => closeOne(target.id, 'closed')
    ws.onerror = (e) => closeOne(target.id, 'error ' + String((e && e.message) || ''))
  }

  function pickConn(url) {
    const want = String(url || '')
    let first = null
    for (const [, c] of conns) {
      if (!first) first = c
      if (want && c.url && (c.url === want || c.url.indexOf(want) !== -1 || want.indexOf(c.url) !== -1)) return c
    }
    return first
  }

  /** Ask the page for everything about an element, by selector / label / @reference text. */
  async function probeElement(url, query) {
    const c = pickConn(url)
    if (!c || !c.ws || c.ws.readyState !== 1) return null
    const id = ++rpcSeq
    const expr = '(window.__dshProbe ? window.__dshProbe.lookup(' + JSON.stringify(String(query || '')) + ') : null)'
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve(null) }, 3000)
      pending.set(id, (val) => { clearTimeout(timer); resolve(val) })
      try {
        c.ws.send(JSON.stringify({ id: id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, timeout: 2500 } }))
      } catch (e) {
        clearTimeout(timer); pending.delete(id); resolve(null)
      }
    })
  }
  bridge.setElementProbe(probeElement)

  bridge.setPageUrlProvider(() => {
    for (const [, c] of conns) {
      const u = String(c.url || '')
      if (/^https?:\/\//.test(u)) return u
    }
    return ''
  })

  async function scan() {
    if (stopped) return
    if (!enabled()) {
      for (const id of Array.from(conns.keys())) closeOne(id, 'sendToDsh=false')
      return
    }
    let targets
    try {
      targets = await fetchTargets(CDP_PORT)
    } catch (e) {
      const now = Date.now()
      if (now - lastAbsent > 60000) {
        lastAbsent = now
        log.appendLine(TAG + ' cdp=absent (' + String((e && e.code) || e.message) + ') — 需要 argv.json 里 "remote-debugging-port": "9223"（install.sh 已写，Cmd+Q 后生效）')
      }
      return
    }
    const pages = (targets || []).filter(isBrowserPage)
    if (pages.length !== lastSeenCount) {
      lastSeenCount = pages.length
      log.appendLine(TAG + ' ' + VERSION + ' targets=' + pages.length + ' connected=' + conns.size)
    }
    const live = new Set(pages.map((p) => String(p.id)))
    for (const id of Array.from(conns.keys())) {
      if (!live.has(id)) closeOne(id, 'target gone')
    }
    for (const t of pages) {
      if (!conns.has(String(t.id)) && t.webSocketDebuggerUrl) {
        try { attach(t) } catch (e) { log.appendLine(TAG + ' attach failed: ' + String((e && e.message) || e)) }
      }
    }
  }

  const sub = vscode.commands.registerCommand('dshReview.browserComment.status', () => {
    const lines = [TAG + ' ' + VERSION + ' sendToDsh=' + enabled() + ' conns=' + conns.size]
    for (const [, c] of conns) lines.push('  ' + String(c.url).slice(0, 90))
    log.appendLine(lines.join('\n'))
    void vscode.window.showInformationMessage('dsh 元素探针: ' + conns.size + ' 个页面已连接（详情见 Output → dsh review）')
  })

  const sub2 = vscode.commands.registerCommand('dshReview.browserComment.selftest', async () => {
    const urls = []
    for (const [, c] of conns) urls.push(String(c.url).slice(0, 60))
    log.appendLine(TAG + ' selftest pages=' + urls.length + ' ' + urls.join(' | ').slice(0, 160))
    const one = await probeElement('', 'body')
    log.appendLine(TAG + ' selftest probe(body) -> ' + (one && one.ok ? 'ok ' + one.tag + ' ' + one.bounds.width + 'x' + one.bounds.height : 'miss'))
  })

  const timer = setInterval(() => { void scan() }, RESCAN_MS)
  context.subscriptions.push(sub, sub2)
  context.subscriptions.push({
    dispose: () => {
      stopped = true
      clearInterval(timer)
      bridge.setElementProbe(null)
      bridge.setPageUrlProvider(null)
      for (const id of Array.from(conns.keys())) closeOne(id, '')
    },
  })
  log.appendLine(TAG + ' ' + VERSION + ' armed (sendToDsh=' + enabled() + ')')
  void scan()
}

module.exports = { startBrowserComment }
