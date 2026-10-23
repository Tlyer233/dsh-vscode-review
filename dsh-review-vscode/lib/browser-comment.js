'use strict'

/**
 * Integrated-browser element comments -> dsh composer (Shift+Enter).
 *
 * VS Code's "Comment on Elements" (workbench.action.browser.addElementCommentToChat,
 * ⌥⌘C) injects its comment box INSIDE the page (the numbered pins and the input
 * are page DOM, not workbench DOM — verified: the workbench bundle has no such
 * widget classes, and issue #328518 describes pins "on the page"). So the only
 * extension-side way to read a comment is CDP into that page, the same channel
 * cdp-element-source.js already uses for the chat pane.
 *
 * Keys are split on purpose (user decision): Enter stays VS Code's (goes to
 * Copilot); Shift+Enter is ours -> the comment + the element land in the dsh
 * composer as one element chip plus the comment as plain text, unsent.
 *
 * Every browser page target gets its own connection, so all integrated-browser
 * tabs work, not just the first one. Requires VS Code started with
 * --remote-debugging-port=9223 (same prerequisite as the element-context feature).
 */

const vscode = require('vscode')
const http = require('node:http')

const CDP_PORT = 9223
const TAG = '[browser-comment]'
const PREFIX = '__DSH_BCC__'
const VERSION = 'v1'
const RESCAN_MS = 2500

/** Page-side: capture Shift+Enter in VS Code's comment box and report the payload. */
const INJECT_JS = `(() => {
  if (window.__dshBcc) { window.__dshBcc.ping = Date.now(); return 'already' }
  const P = '${PREFIX}'
  function log(o) { try { console.log(P + JSON.stringify(o)) } catch (e) { /* noop */ } }
  function clamp(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s }

  // VS Code labels the picked element next to the input, e.g. "span#mv-pcie 304 × 32".
  // It doubles as our proof that this is VS Code's box (not a field of the app)
  // and as the element identity.
  const LABEL_RE = /([a-zA-Z][a-zA-Z0-9-]*(?:[.#][a-zA-Z0-9_-]+)*)\\s+([0-9]{1,5})\\s*[\\u00d7xX*]\\s*([0-9]{1,5})/

  function editableOf(node) {
    let n = node
    for (let i = 0; i < 8 && n; i++) {
      const tag = String(n.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return n
      try { if (n.isContentEditable) return n } catch (e) { /* noop */ }
      n = n.parentElement
    }
    return null
  }

  function commentBox() {
    const ed = editableOf(document.activeElement)
    if (!ed) return null
    let box = ed, depth = 0
    while (box && depth < 10) {
      let st = null
      try { st = getComputedStyle(box) } catch (e) { /* noop */ }
      if (st && (st.position === 'fixed' || st.position === 'absolute')) break
      box = box.parentElement
      depth++
    }
    const scope = box || null
    if (!scope) {
      // No floating container found: this field belongs to the page's own UI.
      // Only treat it as VS Code's box when the element label sits directly next
      // to it — otherwise Shift+Enter in the user's app would be hijacked while
      // an unrelated comment box happens to be open elsewhere on the page.
      const p1 = ed.parentElement
      const near = String((p1 && p1.innerText) || '') + '\\n' + String((p1 && p1.parentElement && p1.parentElement.innerText) || '')
      const nm = LABEL_RE.exec(near)
      if (!nm) return null
      return { ed: ed, label: nm[1], w: +nm[2], h: +nm[3], tier: 'near-label' }
    }
    const text = String(scope.innerText || scope.textContent || '')
    const m = LABEL_RE.exec(text)
    if (m) return { ed: ed, label: m[1], w: +m[2], h: +m[3], tier: 'label' }
    // No label: only accept boxes that still look like the VS Code comment
    // widget, otherwise Shift+Enter in the user's own app would be hijacked.
    const looksComment = /[\\w-]*comment[\\w-]*/i.test(String(scope.className || '')) ||
      !!scope.querySelector('[class*="comment" i], [aria-label*="comment" i]')
    if (!looksComment) return null
    const anyLabel = LABEL_RE.exec(String(document.body.innerText || ''))
    return { ed: ed, label: anyLabel ? anyLabel[1] : '', w: anyLabel ? +anyLabel[2] : 0, h: anyLabel ? +anyLabel[3] : 0, tier: anyLabel ? 'body-label' : 'no-label' }
  }

  function selectorFor(label) {
    // "span#mv-pcie" / "div.card.metric" / "div" -> CSS selector + fallbacks.
    const parts = String(label || '').split(/(?=[.#])/)
    const tag = parts[0].replace(/^[.#]/, '')
    const out = [String(label)]
    if (tag) {
      const rest = parts.slice(1).join('')
      if (rest) out.push(tag + rest)
      out.push(tag)
    }
    const only = parts.filter((p) => /^[.#]/.test(p)).join('')
    if (only) out.unshift((tag || '*') + only)
    return out
  }

  function resolveElement(label, w, h) {
    if (!label) return null
    let best = null, tier = ''
    for (const sel of selectorFor(label)) {
      let found = []
      try { found = Array.from(document.querySelectorAll(sel)) } catch (e) { found = [] }
      if (!found.length) continue
      if (found.length === 1) return { el: found[0], used: sel, tier: 'unique' }
      const sized = found.filter((e) => {
        const r = e.getBoundingClientRect()
        return Math.abs(r.width - w) <= 1 && Math.abs(r.height - h) <= 1
      })
      if (sized.length === 1) return { el: sized[0], used: sel, tier: 'size' }
      const pool = sized.length ? sized : found
      pool.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
        return ra.width * ra.height - rb.width * rb.height
      })
      if (!best) { best = pool[0]; tier = 'smallest'; }
      if (pool.length && !best) { best = pool[0]; tier = 'first' }
    }
    return best ? { el: best, used: String(label), tier: tier } : null
  }

  function elementBits(el) {
    const r = el.getBoundingClientRect()
    const ancestors = []
    let n = el.parentElement
    for (let i = 0; n && i < 6; i++) {
      const cls = String(n.className || '').split(/\\s+/).filter(Boolean).slice(0, 3).join('.')
      ancestors.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (cls ? '.' + cls : ''))
      n = n.parentElement
    }
    const attrs = {}
    for (const a of Array.from(el.attributes || []).slice(0, 15)) attrs[a.name] = clamp(a.value, 80)
    return {
      tag: String(el.tagName || '').toLowerCase(),
      id: el.id || '',
      classes: String(el.className || '').split(/\\s+/).filter(Boolean).slice(0, 8),
      attributes: attrs,
      ancestors: ancestors,
      innerText: clamp(el.innerText || el.textContent || '', 300),
      outerHTML: clamp(el.outerHTML || '', 4000),
      bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    }
  }

  function selftest() {
    const cb = commentBox()
    if (!cb) return { ok: false, why: 'no comment box focused (click one, then run again)' }
    const hit = resolveElement(cb.label, cb.w, cb.h)
    return { ok: true, label: cb.label, tier: hit ? hit.tier : cb.tier, size: cb.w + 'x' + cb.h, tag: hit && hit.el ? elementBits(hit.el).tag : '' }
  }

  window.__dshBcc = { version: '${VERSION}', ping: Date.now(), selftest: selftest }

  window.addEventListener('keydown', function (e) {
    try {
      if (e.key !== 'Enter' || !e.shiftKey || e.isComposing) return
      const cb = commentBox()
      if (!cb) return
      const ed = cb.ed
      const text = String(typeof ed.value === 'string' ? ed.value : (ed.innerText || ed.textContent || '')).trim()
      e.preventDefault()
      try { e.stopImmediatePropagation() } catch (err) { e.stopPropagation() }
      const hit = resolveElement(cb.label, cb.w, cb.h)
      const payload = {
        ev: 'comment',
        text: text,
        label: cb.label,
        locate: hit ? hit.tier : cb.tier,
        selector: hit ? hit.used : cb.label,
        url: location.href,
        title: document.title,
        size: cb.w + 'x' + cb.h,
      }
      if (hit && hit.el) Object.assign(payload, elementBits(hit.el))
      log(payload)
    } catch (err) {
      log({ ev: 'err', e: String((err && err.message) || err) })
    }
  }, true)

  log({ ev: 'installed', url: location.href, title: document.title })
  return 'installed'
})()`

function fetchTargets(port) {
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

/** Browser tabs are http(s) pages; the workbench renderer is a file:// page. */
function isBrowserPage(t) {
  if (!t || t.type !== 'page') return false
  const url = String(t.url || '')
  if (!/^https?:\/\//i.test(url)) return false
  if (/workbench|vscode-webview|^file:\/\//i.test(url)) return false
  return true
}

/**
 * @param {{ context: import('vscode').ExtensionContext, log: {appendLine:(s:string)=>void},
 *          onComment: (p: object) => void }} opts
 */
function startBrowserComment(opts) {
  const { context, log, onComment } = opts
  let WS
  if (typeof globalThis.WebSocket === 'function') WS = globalThis.WebSocket
  else WS = require('ws')

  const conns = new Map() // targetId -> { ws, url }
  let stopped = false
  let lastAbsent = 0
  let lastSeenCount = -1
  let absentNoticed = false

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
    if (why) log.appendLine(TAG + ' drop ' + id.slice(0, 8) + ' (' + why + ')')
  }

  function attach(target) {
    const ws = new WS(target.webSocketDebuggerUrl)
    conns.set(target.id, { ws, url: target.url })
    ws.onopen = () => {
      log.appendLine(TAG + ' attached ' + String(target.id).slice(0, 8) + ' ' + String(target.url).slice(0, 70))
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable', params: {} }))
      ws.send(JSON.stringify({
        id: 2, method: 'Runtime.evaluate',
        params: { expression: INJECT_JS, returnByValue: true, timeout: 5000 },
      }))
    }
    ws.onmessage = (ev) => {
      let raw = ev && ev.data
      if (raw && typeof raw !== 'string') { try { raw = String(raw) } catch { return } }
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      // selftest replies come back as evaluate results, not console lines.
      if (msg.id >= 900 && msg.result && msg.result.result) {
        log.appendLine(TAG + ' selftest ' + String(target.id).slice(0, 8) + ': ' +
          String(msg.result.result.value == null ? '-' : msg.result.result.value).slice(0, 200))
      }
      if (msg.method !== 'Runtime.consoleAPICalled') return
      const arg = msg.params && msg.params.args && msg.params.args[0] && msg.params.args[0].value
      if (typeof arg !== 'string' || arg.indexOf(PREFIX) !== 0) return
      let d
      try { d = JSON.parse(arg.slice(PREFIX.length)) } catch { return }
      if (d.ev === 'installed') log.appendLine(TAG + ' injected ' + String(d.url || '').slice(0, 70))
      else if (d.ev === 'err') log.appendLine(TAG + ' page error: ' + String(d.e).slice(0, 160))
      else if (d.ev === 'comment') {
        log.appendLine(TAG + ' comment label=' + (d.label || '-') + ' locate=' + (d.locate || '-') +
          ' chars=' + String(d.text || '').length + ' ' + String(d.url || '').slice(0, 60))
        try { onComment(d) } catch (e) { log.appendLine(TAG + ' onComment failed: ' + String((e && e.message) || e)) }
      }
    }
    ws.onclose = () => closeOne(target.id, 'closed')
    ws.onerror = (e) => closeOne(target.id, 'error ' + String((e && e.message) || ''))
  }

  async function scan() {
    if (stopped || !enabled()) return
    let targets
    try {
      targets = await fetchTargets(CDP_PORT)
    } catch (e) {
      const now = Date.now()
      if (now - lastAbsent > 60000) {
        lastAbsent = now
        log.appendLine(TAG + ' cdp=absent (' + String((e && e.code) || e.message) + ') — 需要 --remote-debugging-port=' + CDP_PORT)
        if (!absentNoticed) {
          absentNoticed = true
          try {
            void vscode.window.showInformationMessage('dsh: 元素批注需要 VS Code 以 --remote-debugging-port=' + CDP_PORT + ' 启动')
          } catch { /* noop */ }
        }
      }
      return
    }
    absentNoticed = false
    const pages = (targets || []).filter(isBrowserPage)
    if (pages.length !== lastSeenCount) {
      lastSeenCount = pages.length
      log.appendLine(TAG + ' targets=' + pages.length + ' connected=' + conns.size)
    }
    for (const t of pages) {
      const c = conns.get(t.id)
      if (c && c.ws && (c.ws.readyState === 1 || c.ws.readyState === 0)) continue
      if (c) closeOne(t.id, '')
      if (t.webSocketDebuggerUrl) attach(t)
    }
    for (const id of Array.from(conns.keys())) {
      if (!pages.some((p) => p.id === id)) closeOne(id, 'target gone')
    }
  }

  context.subscriptions.push(vscode.commands.registerCommand('dshReview.browserComment.status', () => {
    const lines = [
      TAG + ' ' + VERSION + ' sendToDsh=' + enabled() + ' port=' + CDP_PORT +
      ' connected=' + conns.size + ' targets=' + lastSeenCount,
    ]
    for (const [id, c] of conns) lines.push('  ' + id.slice(0, 8) + ' ready=' + (c.ws ? c.ws.readyState : 'null') + ' ' + String(c.url).slice(0, 80))
    log.appendLine(lines.join('\n'))
    void vscode.window.showInformationMessage('dsh 元素批注: 开关=' + enabled() + ' 已连接页面=' + conns.size + '（详情见 dsh review 输出）')
  }))

  context.subscriptions.push(vscode.commands.registerCommand('dshReview.browserComment.selftest', async () => {
    // Runs window.__dshBcc.selftest() in every attached page: tells us whether
    // the comment box is detected and how the element was located.
    const list = Array.from(conns.entries()).filter(([, c]) => c.ws && c.ws.readyState === 1)
    if (!list.length) {
      log.appendLine(TAG + ' selftest: no connected page (开关关 / cdp=absent / 浏览器 tab 未开)')
      void vscode.window.showWarningMessage('dsh 元素批注: 没有可测的浏览器页面（看输出面板）')
      return
    }
    list.forEach(([id, c], i) => {
      setTimeout(() => {
        try {
          c.ws.send(JSON.stringify({
            id: 900 + i, method: 'Runtime.evaluate',
            params: { expression: 'window.__dshBcc ? JSON.stringify(window.__dshBcc.selftest()) : "not-installed"', returnByValue: true, timeout: 3000 },
          }))
        } catch { /* noop */ }
      }, i * 120)
    })
    log.appendLine(TAG + ' selftest sent to ' + list.length + ' page(s) — 结果在 console 回传（把评论框聚焦后再跑一次最准）')
  }))

  const timer = setInterval(() => { void scan() }, RESCAN_MS)
  context.subscriptions.push({ dispose: () => { stopped = true; clearInterval(timer); for (const id of Array.from(conns.keys())) closeOne(id, '') } })
  log.appendLine(TAG + ' ' + VERSION + ' armed (sendToDsh=' + enabled() + ')')
  void scan()
}

module.exports = { startBrowserComment }
