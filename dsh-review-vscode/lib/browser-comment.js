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
const VERSION = 'v9'
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
  if (window.__dshProbe && window.__dshProbe.version === 'v9') return 'already'
  if (window.__dshProbe) { try { delete window.__dshProbe } catch (e) { window.__dshProbe = null } } // 0.1.77: v8 replaced state(); the old guard kept the stale probe installed forever
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
    version: 'v9',
    ping: function () { return 'v9 ' + location.href },
    state: function () {
      var out = { url: location.href, title: document.title || '', pins: [], helpers: null, pickHost: null, helperSrc: '', commentPins: [], roots: 0 }
      // 0.1.79: the element-comment pins live in a CLOSED shadow root (preload-browserView.js:
      // div[data-vscode-pick-host].attachShadow({mode:'closed'})) — invisible to the page world
      // and to CDP pierce. The bootstrap hook records every closed root into
      // window.__dshShadowRoots, which is how we count and later click the real pins.
      try {
        var roots = window.__dshShadowRoots || []
        out.roots = roots.length
        for (var ri = 0; ri < roots.length; ri++) {
          var rt = roots[ri]
          if (!rt || !rt.querySelectorAll) continue
          var ps = rt.querySelectorAll('.comment-pin')
          for (var pi = 0; pi < ps.length && out.commentPins.length < 20; pi++) {
            var pr = null
            try { pr = ps[pi].getBoundingClientRect() } catch (e) {}
            var num = ''
            try { var nn = ps[pi].querySelector('.comment-pin-number'); num = nn ? String(nn.textContent || '').trim() : String(ps[pi].textContent || '').trim() } catch (e) {}
            out.commentPins.push({ n: num, at: pr ? Math.round(pr.left) + ',' + Math.round(pr.top) : '?', size: pr ? Math.round(pr.width) + 'x' + Math.round(pr.height) : '?', bubbles: rt.querySelectorAll('.comment-pin-bubble').length })
          }
        }
      } catch (e) { out.commentPins = 'ERR' }
      function walk(root, where) {
        var els = []
        try { els = Array.prototype.slice.call(root.querySelectorAll('*')) } catch (e) { return }
        for (var i = 0; i < els.length && i < 9000; i++) {
          var el = els[i]
          var id = '', cls = '', data = ''
          try {
            id = el.id || ''
            cls = typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class') || '')
            for (var j = 0; el.attributes && j < el.attributes.length && j < 12; j++) {
              var at = el.attributes[j]
              if (/comment|element|pin|marker|vscode/i.test(at.name)) data += ' ' + at.name + '=' + String(at.value).slice(0, 24)
            }
          } catch (e) {}
          var blob = (id + ' ' + cls + data).toLowerCase()
          var txt = ''
          try { txt = String(el.textContent || '').trim().slice(0, 8) } catch (e) {}
          var pos = ''
          try { var st = getComputedStyle(el); pos = st.position } catch (e) {}
          if (out.pins.length < 14 && (/pin|marker|comment|annotation|element-selection|vscode/.test(blob) || (/^[0-9]{1,3}$/.test(txt) && (pos === 'fixed' || pos === 'absolute')))) {
            var r = null
            try { r = el.getBoundingClientRect() } catch (e) {}
            out.pins.push(where + ' ' + el.tagName.toLowerCase() + (id ? '#' + id : '') + (cls ? '.' + String(cls).trim().split(/\s+/)[0] : '') + (data ? ' ' + data.trim() : '') + ' text=' + JSON.stringify(txt) + ' ' + pos + (r ? ' @' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) : ''))
          }
          if (el.shadowRoot) walk(el.shadowRoot, where + '>' + el.tagName.toLowerCase() + '#sr')
        }
      }
      walk(document, 'doc')
      // 0.1.78: the pins ARE in this page (proved by a CDP screenshot of the page's own
      // renderer), but they are not absolutely positioned and their class carries no keyword —
      // a page screenshot showed SVG-ish round badges with a number. Find them by shape:
      // small, roughly square, visible, text is 1-3 digits.
      try {
        var cand = []
        var els = document.querySelectorAll('*')
        for (var z = 0; z < els.length; z++) {
          var e2 = els[z]
          var tx = ''
          try { tx = String(e2.textContent || '').trim() } catch (err2) {}
          if (!/^[0-9]{1,3}$/.test(tx)) continue
          var b = null
          try { b = e2.getBoundingClientRect() } catch (err2) { continue }
          if (!(b.width >= 8 && b.width <= 60 && b.height >= 8 && b.height <= 60)) continue
          var vis = true
          try { var st2 = getComputedStyle(e2); vis = st2.visibility !== 'hidden' && st2.display !== 'none' && Number(st2.opacity) > 0.05 } catch (err2) {}
          if (!vis) continue
          var cn = ''
          try { cn = (typeof e2.className === 'string' ? e2.className : (e2.getAttribute && e2.getAttribute('class') || '')) + ' ' + (e2.parentElement && e2.parentElement.tagName || '') + '.' + (e2.parentElement && typeof e2.parentElement.className === 'string' ? e2.parentElement.className : '') } catch (err2) {}
          if (cand.length < 12) cand.push({ n: tx, at: Math.round(b.left) + ',' + Math.round(b.top), size: Math.round(b.width) + 'x' + Math.round(b.height), cls: String(cn).replace(/\s+/g, ' ').slice(0, 60) })
        }
        out.pinCandidates = cand
      } catch (e) { out.pinCandidates = 'ERR' }
      // 0.1.76: the real pin layer is VS Code's own host inside the page — count what is in it.
      try {
        var host = document.querySelector('[data-vscode-pick-host]')
        if (!host) {
          var all = document.querySelectorAll('*')
          for (var z = 0; z < all.length; z++) {
            for (var y = 0; all[z].attributes && y < all[z].attributes.length; y++) {
              if (/vscode.*(pick|comment|element|overlay)/i.test(all[z].attributes[y].name)) { host = all[z]; break }
            }
            if (host) break
          }
        }
        if (host) {
          var kids = []
          try { kids = Array.prototype.slice.call(host.querySelectorAll('*')) } catch (e) {}
          var sample = []
          for (var q = 0; q < kids.length && sample.length < 6; q++) {
            var kr = null
            try { kr = kids[q].getBoundingClientRect() } catch (e) {}
            sample.push(kids[q].tagName.toLowerCase() + (kids[q].id ? '#' + kids[q].id : '') + ' text=' + JSON.stringify(String(kids[q].textContent || '').trim().slice(0, 10)) + (kr ? ' @' + Math.round(kr.left) + ',' + Math.round(kr.top) + ' ' + Math.round(kr.width) + 'x' + Math.round(kr.height) : ''))
          }
          out.pickHost = { children: kids.length, hostText: String(host.textContent || '').trim().slice(0, 40), sample: sample }
        } else { out.pickHost = null }
      } catch (e) { out.pickHost = 'ERR' }
      try { var h = window.__vscode_helpers; out.helpers = h ? Object.keys(h).slice(0, 20).join(',') : null
        if (h) { try { out.helperSrc = String(h.getElement || '').slice(0, 160) } catch (e) { out.helperSrc = '' } }
      } catch (e) { out.helpers = 'ERR' }
      try { out.globals = Object.getOwnPropertyNames(window).filter(function (k) { return /vscode|comment|element|pin|__dsh/i.test(k) }).slice(0, 16).join(',') } catch (e) {}
      return JSON.stringify(out)
    },
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

// Runs before any page script on the next navigation: records closed shadow roots so the
// pin layer becomes reachable. Pure CDP injection — no VS Code file is modified.
const SHADOW_HOOK = [
  "(function () {",
  "  if (window.__dshShadowRoots) return 'dup'",
  "  window.__dshShadowRoots = []",
  "  var orig = Element.prototype.attachShadow",
  "  Element.prototype.attachShadow = function (init) {",
  "    var root = orig.call(this, init)",
  "    try {",
  "      if (init && init.mode === 'closed') { window.__dshShadowRoots.push(root); try { Object.defineProperty(this, '__dshClosedRoot', { value: root, configurable: true }) } catch (e) {} }",
  "    } catch (e) {}",
  "    return root",
  "  }",
  "  return 'ok'",
  "})()",
].join('\n')

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
      // 0.1.79: the hook must exist before VS Code's own preload creates its closed shadow
      // host, so it goes in as a new-document script (page reloads pick it up automatically).
      ws.send(JSON.stringify({ id: 3, method: 'Page.enable', params: {} }))
      ws.send(JSON.stringify({ id: 4, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: SHADOW_HOOK } }))
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
      // 0.1.82: an injection sent while the page is reloading is thrown away, and we only
      // sent it once per attach — that is why the log showed 元素详情没拿到 / 探针没答（null）
      // after the user refreshed the browser page. Each new execution context means a fresh
      // document, so re-send the probe then (no polling).
      if (msg.method === 'Runtime.executionContextCreated') {
        try {
          ws.send(JSON.stringify({ id: 5, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: PROBE_JS } }))
        } catch { /* noop */ }
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
  async function probePageState(url) {
    const c = pickConn(url)
    if (!c || !c.ws || c.ws.readyState !== 1) return null
    const id = ++rpcSeq
    const expr = '(window.__dshProbe ? window.__dshProbe.state() : null)'
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve(null) }, 3000)
      pending.set(id, (val) => { clearTimeout(timer); resolve(val) })
      try {
        c.ws.send(JSON.stringify({ id: id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, timeout: 2500 } }))
      } catch (e) { clearTimeout(timer); pending.delete(id); resolve(null) }
    })
  }
  bridge.setPageStateProbe(probePageState)
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
      bridge.setPageStateProbe(null)
      bridge.setPageUrlProvider(null)
      for (const id of Array.from(conns.keys())) closeOne(id, '')
    },
  })
  log.appendLine(TAG + ' ' + VERSION + ' armed (sendToDsh=' + enabled() + ')')
  void scan()
}

module.exports = { startBrowserComment }
