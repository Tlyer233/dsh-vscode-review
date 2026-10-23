'use strict'

/**
 * Integrated-browser element annotations -> dsh (our own in-place comment box).
 *
 * Why our own box — measured on VS Code 1.142, not guessed: the built-in
 * "Comment on Elements" box is unreachable. 9223 only exposes the main window's
 * 4 targets; with the box open and the user typing, all four kept the same node
 * counts, the typed marker text appeared nowhere in their DOM (shadow roots and
 * child frames included), elementFromPoint over the box returned
 * `div.browser-placeholder-screenshot`, and a workbench screenshot did not show
 * the box at all. Copilot's own input sits in that same unreachable layer. So we
 * can neither intercept its keypress nor read its text; the only on-disk copy of
 * a built-in comment is the chatSessions jsonl, which exists only after the
 * comment has been sent to Copilot.
 *
 * So this module injects its own picker + in-place box into each browser page
 * (CDP — the same channel already proven here: attached + injected). Submitting
 * writes a markdown file and inserts ONE native file chip into the dsh composer:
 * Copilot is never touched, no untitled doc, no Save prompt, no launch flag.
 *
 * Needs CDP on 9223; install.sh writes "remote-debugging-port" into argv.json so
 * a normal Dock launch works. dshReview.browserComment.sendToDsh=false removes
 * the injection entirely and leaves the page untouched.
 */

const vscode = require('vscode')
const http = require('node:http')

const CDP_PORT = 9223
const TAG = '[browser-comment]'
const PREFIX = '__DSH_BCC__'
const VERSION = 'v4'
const RESCAN_MS = 2500

/** Page-side: floating trigger, element picker, in-place comment box. */
const INJECT_JS = `(() => {
  const HOST_ID = '__dsh_bcc_host'
  const P = '${PREFIX}'
  const seen = window.__dshBcc
  if (seen) {
    seen.ping = Date.now()
    // SPA navigations can replace <body>; re-attach if our host got dropped.
    if (seen.host && !seen.host.isConnected && document.documentElement) document.documentElement.appendChild(seen.host)
    return 'already'
  }
  if (document.documentElement && document.documentElement.classList.contains('dsh-vscode-iframe')) return 'skipped:dsh-gui'
  if (!document.documentElement) return 'no-dom'

  const send = (o) => { try { console.log(P + JSON.stringify(o)) } catch (e) { /* noop */ } }
  const clamp = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s }

  // ---- one shadow root: the page's CSS cannot reach us, we leak nothing back ----
  const host = document.createElement('div')
  host.id = HOST_ID
  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = [
    ':host { all: initial; }',
    '.btn { position: fixed; right: 14px; bottom: 14px; z-index: 2147483646; padding: 6px 10px;',
    '  font: 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #eee;',
    '  background: rgba(30,30,30,.92); border: 1px solid #0a84ff; border-radius: 14px; cursor: pointer;',
    '  opacity: .7; transition: opacity .15s; }',
    '.btn:hover, .btn.on { opacity: 1; }',
    '.btn.on { background: #0a84ff; color: #fff; }',
    '.mark { position: fixed; z-index: 2147483645; pointer-events: none; display: none;',
    '  border: 2px solid #0a84ff; border-radius: 3px; box-shadow: 0 0 0 1px rgba(10,132,255,.35); }',
    '.panel { position: fixed; z-index: 2147483647; display: none; width: 320px; padding: 6px;',
    '  background: rgba(38,38,38,.97); border: 1px solid #454545; border-radius: 6px;',
    '  box-shadow: 0 6px 22px rgba(0,0,0,.45); font: 12px/1.35 -apple-system, BlinkMacSystemFont, sans-serif; color: #eee; }',
    '.pill { display: block; margin-bottom: 5px; padding: 2px 6px; max-width: 100%; overflow: hidden;',
    '  text-overflow: ellipsis; white-space: nowrap; background: #0a84ff; color: #fff; border-radius: 3px;',
    '  font: 11px/1.4 ui-monospace, Menlo, monospace; }',
    '.row { display: flex; gap: 6px; align-items: flex-end; }',
    'textarea { flex: 1 1 auto; min-height: 40px; max-height: 160px; resize: vertical; padding: 5px 6px;',
    '  background: #252526; color: #eee; border: 1px solid #454545; border-radius: 4px;',
    '  font: 12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; outline: none; }',
    'textarea:focus { border-color: #0a84ff; }',
    '.go { flex: 0 0 auto; width: 28px; height: 30px; background: #0a84ff; color: #fff; border: 0;',
    '  border-radius: 4px; font-size: 16px; cursor: pointer; }',
    '.hint { margin-top: 4px; color: #999; font-size: 10px; }',
  ].join('\\n')
  const btn = document.createElement('button')
  btn.className = 'btn'
  btn.type = 'button'
  btn.textContent = 'dsh \\u270e'
  btn.title = 'dsh: \\u6279\\u6ce8\\u5143\\u7d20 \\u2192 dsh\\uff08\\u4e0d\\u8fdb Copilot\\uff09'
  const mark = document.createElement('div')
  mark.className = 'mark'
  const panel = document.createElement('div')
  panel.className = 'panel'
  const pill = document.createElement('div')
  pill.className = 'pill'
  const ta = document.createElement('textarea')
  ta.placeholder = '\\u5199\\u6279\\u6ce8'
  const go = document.createElement('button')
  go.className = 'go'
  go.type = 'button'
  go.textContent = '+'
  const hint = document.createElement('div')
  hint.className = 'hint'
  hint.textContent = 'Enter \\u2192 dsh \\u00b7 Shift+Enter \\u6362\\u884c \\u00b7 Esc \\u53d6\\u6d88'
  const row = document.createElement('div')
  row.className = 'row'
  row.appendChild(ta)
  row.appendChild(go)
  panel.appendChild(pill)
  panel.appendChild(row)
  panel.appendChild(hint)
  root.appendChild(style)
  root.appendChild(btn)
  root.appendChild(mark)
  root.appendChild(panel)
  document.documentElement.appendChild(host)

  // Our own UI fires document-level events retargeted to the host, so one check
  // is enough to keep the picker from selecting the picker.
  const inside = (node) => {
    if (!node) return false
    if (node === host) return true
    const rn = node.getRootNode && node.getRootNode()
    return rn === root
  }

  let mode = 'idle' // idle | pick
  let picked = null
  // 0.1.30: a successful send used to look like nothing happened ("页面也没有标注,
  // 输入的内容也没有了" — we clear the box). Every note now leaves a numbered pin on
  // the element, the panel confirms the send, and the button shows the count.
  const notes = []
  const pins = []
  const pageTok = Math.random().toString(36).slice(2, 6)
  // 0.1.31 the user asked: (a) leave the page alone once sent, (b) clicking a pin
  // must show and let me fix the note. So a note carries a stable nid: 更新 rewrites
  // the SAME markdown file (dsh keeps its single chip), 删除 removes it, and
  // 另存为新一条 sends a fresh one. The element payload is kept on the note so a
  // resend needs no re-pick.
  function nidFor(n) { return pageTok + n }

  function sendNote(kind, n, text) {
    send(Object.assign({ ev: kind, nid: n.nid, text: text, label: n.label, url: location.href, title: document.title, size: (n.bits && n.bits.bounds ? n.bits.bounds.width + 'x' + n.bits.bounds.height : '') }, n.bits))
  }
  const pinStyle = document.createElement('style')
  pinStyle.textContent = '.pin { position: fixed; z-index: 2147483647; width: 18px; height: 18px;' +
    ' border-radius: 50%; background: #0a84ff; color: #fff; border: 1px solid #fff;' +
    ' font: 11px/16px -apple-system, BlinkMacSystemFont, sans-serif; text-align: center;' +
    ' cursor: help; box-shadow: 0 1px 4px rgba(0,0,0,.5); }'
  root.appendChild(pinStyle)

  function positionPins() {
    for (let i = pins.length - 1; i >= 0; i--) {
      const p = pins[i]
      if (!p.el || !p.el.isConnected) { try { p.node.remove() } catch (e) { /* noop */ } pins.splice(i, 1); continue }
      const r = p.el.getBoundingClientRect()
      p.node.style.left = Math.round(Math.max(0, r.left - 7)) + 'px'
      p.node.style.top = Math.round(Math.max(0, r.top - 9)) + 'px'
      p.node.style.display = (r.width || r.height) ? 'block' : 'none'
    }
  }

  function addPin(n) {
    const b = document.createElement('div')
    b.className = 'pin'
    b.textContent = String(n.n)
    b.title = '#' + n.n + ' ' + n.text
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); showCard(notes.indexOf(n)) })
    root.appendChild(b)
    n.node = b
    pins.push({ el: n.el, node: b, note: n })
    positionPins()
  }

  let card = null
  function ensureCard() {
    if (card) return card
    const st = document.createElement('style')
    st.textContent = '.card { position: fixed; z-index: 2147483647; width: 330px; padding: 8px; display: none;' +
      ' background: rgba(38,38,38,.98); border: 1px solid #454545; border-radius: 6px;' +
      ' box-shadow: 0 6px 22px rgba(0,0,0,.45); color: #eee; font: 12px/1.4 -apple-system, sans-serif; }' +
      '.card h4 { margin: 0 0 4px; font: 11px/1.4 ui-monospace, Menlo, monospace; color: #0a84ff; font-weight: 400; word-break: break-all; }' +
      '.card textarea { width: 100%; min-height: 62px; max-height: 200px; box-sizing: border-box; background: #252526;' +
      ' color: #eee; border: 1px solid #454545; border-radius: 4px; padding: 5px; font: 12px/1.4 -apple-system, sans-serif; resize: vertical; }' +
      '.btns { display: flex; gap: 6px; margin-top: 6px; }' +
      '.btns button { flex: 1 1 auto; padding: 4px 6px; border: 1px solid #454545; border-radius: 4px; background: #2d2d30;' +
      ' color: #eee; font: 11px/1.3 -apple-system, sans-serif; cursor: pointer; }' +
      '.btns button.pri { background: #0a84ff; border-color: #0a84ff; color: #fff; }'
    root.appendChild(st)
    const c = document.createElement('div')
    c.className = 'card'
    const h = document.createElement('h4')
    const t = document.createElement('textarea')
    const bar = document.createElement('div')
    bar.className = 'btns'
    const mk = (label, cls) => { const x = document.createElement('button'); x.type = 'button'; x.textContent = label; if (cls) x.className = cls; bar.appendChild(x); return x }
    const save = mk('更新到同一文件', 'pri')
    const again = mk('另存为新一条')
    const del = mk('删除')
    const cls = mk('关闭')
    c.appendChild(h); c.appendChild(t); c.appendChild(bar)
    root.appendChild(c)
    card = { c: c, h: h, t: t, idx: -1 }
    save.addEventListener('click', function () { updateNote(card.idx, card.t.value) })
    again.addEventListener('click', function () { resendNote(card.idx, card.t.value) })
    del.addEventListener('click', function () { deleteNote(card.idx) })
    cls.addEventListener('click', function () { hideCard() })
    for (const ty of ['keydown', 'keyup', 'keypress', 'mousedown', 'pointerdown']) {
      c.addEventListener(ty, function (e) { e.stopPropagation() })
    }
    return card
  }

  function showCard(idx) {
    const n = notes[idx]
    if (!n) return
    const c = ensureCard()
    c.idx = idx
    c.h.textContent = '#' + n.n + '  ' + n.label
    c.t.value = n.text
    const r = n.el.getBoundingClientRect()
    let x = r.left
    if (x + 340 > window.innerWidth) x = Math.max(8, window.innerWidth - 340)
    let y = r.bottom + 10
    if (y + 200 > window.innerHeight) y = Math.max(8, r.top - 200)
    c.c.style.left = Math.round(x) + 'px'
    c.c.style.top = Math.round(y) + 'px'
    c.c.style.display = 'block'
    c.t.focus()
  }

  function hideCard() { if (card) { card.c.style.display = 'none'; card.idx = -1 } }

  function updateNote(idx, text) {
    const n = notes[idx]
    if (!n) return
    const v = String(text || '').trim()
    if (!v) return
    n.text = v
    if (n.node) n.node.title = '#' + n.n + ' ' + v
    sendNote('update', n, v)
    hint.textContent = '已更新 #' + n.n + '（dsh 里那个 chip 指向同一文件）'
    hideCard()
  }

  function resendNote(idx, text) {
    const n = notes[idx]
    if (!n) return
    const v = String(text || '').trim()
    if (!v) return
    const nn = { text: v, label: n.label, n: notes.length + 1, nid: nidFor(notes.length + 1), el: n.el, bits: n.bits }
    notes.push(nn)
    addPin(nn)
    sendNote('comment', nn, v)
    btn.textContent = 'dsh ' + String.fromCharCode(0x270e) + ' ' + notes.length
    hint.textContent = '已送 dsh #' + nn.n
    hideCard()
  }

  function deleteNote(idx) {
    const n = notes[idx]
    if (!n) return
    sendNote('delete', n, '')
    try { if (n.node) n.node.remove() } catch (e) { /* noop */ }
    for (let i = pins.length - 1; i >= 0; i--) { if (pins[i].note === n) pins.splice(i, 1) }
    notes.splice(idx, 1)
    for (let i = 0; i < notes.length; i++) {
      notes[i].n = i + 1
      if (notes[i].node) { notes[i].node.textContent = String(i + 1); notes[i].node.title = '#' + (i + 1) + ' ' + notes[i].text }
    }
    btn.textContent = 'dsh ' + String.fromCharCode(0x270e) + (notes.length ? ' ' + notes.length : '')
    hideCard()
  }

  document.addEventListener('scroll', positionPins, true)
  window.addEventListener('resize', positionPins)
  setInterval(positionPins, 1000) // SPA re-renders move elements without scrolling

  function labelFor(el) {
    const r = el.getBoundingClientRect()
    const cls = String(el.className || '').split(/\\s+/).filter(Boolean)
    return String(el.tagName || '').toLowerCase() +
      (el.id ? '#' + el.id : '') +
      (cls.length ? '.' + cls[0] : '') +
      ' ' + Math.round(r.width) + ' \\u00d7 ' + Math.round(r.height)
  }

  function selectorFor(el) {
    if (el.id) return '#' + el.id
    const parts = []
    let n = el
    for (let i = 0; n && i < 5 && n.tagName; i++) {
      if (n.id) { parts.unshift(String(n.tagName).toLowerCase() + '#' + n.id); break }
      const cls = String(n.className || '').split(/\\s+/).filter(Boolean)
      let s = String(n.tagName).toLowerCase()
      if (cls.length) s += '.' + cls[0]
      const p = n.parentElement
      if (p) {
        const same = Array.from(p.children).filter((c) => c.tagName === n.tagName)
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'
      }
      parts.unshift(s)
      n = p
    }
    return parts.join(' > ')
  }

  function elementBits(el) {
    const r = el.getBoundingClientRect()
    const ancestors = []
    let n = el.parentElement
    for (let i = 0; n && i < 6; i++) {
      const cls = String(n.className || '').split(/\\s+/).filter(Boolean).slice(0, 3).join('.')
      ancestors.push(String(n.tagName || '').toLowerCase() + (n.id ? '#' + n.id : '') + (cls ? '.' + cls : ''))
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
      selector: selectorFor(el),
      innerText: clamp(el.innerText || el.textContent || '', 400),
      outerHTML: clamp(el.outerHTML || '', 4000),
      bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    }
  }

  // In-place like VS Code's own box: next to the element, flipped when clipped.
  function place(el) {
    const r = el.getBoundingClientRect()
    const W = 330, H = 120
    let x = r.right + 10
    if (x + W > window.innerWidth) x = Math.max(8, r.left - W - 10)
    if (x + W > window.innerWidth) x = Math.max(8, (window.innerWidth - W) / 2)
    let y = r.top
    if (y + H > window.innerHeight) y = Math.max(8, window.innerHeight - H - 8)
    panel.style.left = Math.round(x) + 'px'
    panel.style.top = Math.round(y) + 'px'
  }

  function openFor(el) {
    picked = el
    mode = 'idle'
    btn.classList.remove('on')
    btn.textContent = 'dsh \\u270e'
    mark.style.display = 'none'
    pill.textContent = labelFor(el)
    place(el)
    panel.style.display = 'block'
    ta.focus()
  }

  function closePanel() {
    panel.style.display = 'none'
    mark.style.display = 'none'
    picked = null
    ta.value = ''
  }

  function submit() {
    if (!picked) { closePanel(); return }
    const text = String(ta.value || '').trim()
    if (!text) { closePanel(); return }
    const bits = elementBits(picked)
    const n = { text: text, label: pill.textContent, n: notes.length + 1, nid: nidFor(notes.length + 1), el: picked, bits: bits }
    notes.push(n)
    addPin(n)
    sendNote('comment', n, text)
    btn.textContent = 'dsh ' + String.fromCharCode(0x270e) + ' ' + notes.length
    hint.textContent = '已送 dsh #' + n.n + '（点图钉可展开查看/修改；内容已存文件）'
    closePanel()
  }

  btn.addEventListener('click', function () {
    mode = mode === 'pick' ? 'idle' : 'pick'
    btn.classList.toggle('on', mode === 'pick')
    btn.textContent = mode === 'pick' ? '\\u70b9\\u51fb\\u9009\\u62e9\\u5143\\u7d20\\u2026' : 'dsh \\u270e'
    if (mode !== 'pick') closePanel()
  })

  document.addEventListener('mouseover', function (e) {
    if (mode !== 'pick') return
    const t = e.target
    if (!t || inside(t) || t === document.documentElement || t === document.body) return
    const r = t.getBoundingClientRect ? t.getBoundingClientRect() : null
    if (!r || !r.width || !r.height) return
    mark.style.display = 'block'
    mark.style.left = Math.round(r.left) + 'px'
    mark.style.top = Math.round(r.top) + 'px'
    mark.style.width = Math.round(r.width) + 'px'
    mark.style.height = Math.round(r.height) + 'px'
  }, true)

  document.addEventListener('click', function (e) {
    if (mode !== 'pick') return
    const t = e.target
    if (!t || inside(t)) return
    e.preventDefault()
    e.stopPropagation()
    openFor(t)
  }, true)

  ta.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      e.stopPropagation()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closePanel()
    }
  }, true)
  // Keep the page's own shortcuts from eating typing inside our box — in the
  // BUBBLE phase. Capturing on the panel stops the event before it reaches the
  // textarea, i.e. our own Enter handler never runs (the 0.1.28 jsdom probe caught
  // exactly that: '+' submitted, Enter did nothing).
  for (const t of ['keydown', 'keyup', 'keypress', 'mousedown', 'pointerdown']) {
    panel.addEventListener(t, function (e) { e.stopPropagation() })
  }
  go.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); submit() })

  function selftest() {
    return {
      ok: !!document.getElementById(HOST_ID),
      attached: host.isConnected,
      mode: mode,
      hasPicked: !!picked,
      panelOpen: panel.style.display === 'block',
      textChars: String(ta.value || '').length,
      notes: notes.length,
      pins: pins.length,
      cardOpen: !!(card && card.c.style.display === 'block'),
    }
  }

  window.__dshBcc = { version: '${VERSION}', ping: Date.now(), host: host, selftest: selftest }
  send({ ev: 'installed', url: location.href, title: document.title })
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

/** Browser tabs are http(s) page targets; the workbench is a vscode-file:// page. */
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
        log.appendLine(TAG + ' comment label=' + (d.label || '-') + ' chars=' + String(d.text || '').length +
          ' ' + String(d.url || '').slice(0, 60))
        try { onComment(d) } catch (e) { log.appendLine(TAG + ' onComment failed: ' + String((e && e.message) || e)) }
      }
    }
    ws.onclose = () => closeOne(target.id, 'closed')
    ws.onerror = (e) => closeOne(target.id, 'error ' + String((e && e.message) || ''))
  }

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
        log.appendLine(TAG + ' cdp=absent (' + String((e && e.code) || e.message) + ') — 需要 argv.json 里 \"remote-debugging-port\": \"9223\"（install.sh 已写，Cmd+Q 后生效）')
        if (!absentNoticed) {
          absentNoticed = true
          try {
            void vscode.window.showInformationMessage('dsh: 元素批注需要 CDP（argv.json 的 remote-debugging-port=9223，Cmd+Q 重启后生效）')
          } catch { /* noop */ }
        }
      }
      return
    }
    absentNoticed = false
    const pages = (targets || []).filter(isBrowserPage)
    if (pages.length !== lastSeenCount) {
      lastSeenCount = pages.length
      log.appendLine(TAG + ' ' + VERSION + ' targets=' + pages.length + ' connected=' + conns.size)
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
    void vscode.window.showInformationMessage('dsh 元素批注: 开关=' + enabled() + ' 已注入页面=' + conns.size + '（页面右下角 dsh ✎）')
  }))

  context.subscriptions.push(vscode.commands.registerCommand('dshReview.browserComment.selftest', () => {
    // Asks each injected page whether the box is attached / open / holding text.
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
    log.appendLine(TAG + ' selftest sent to ' + list.length + ' page(s) — 结果在 dsh review 输出')
  }))

  const timer = setInterval(() => { void scan() }, RESCAN_MS)
  context.subscriptions.push({ dispose: () => { stopped = true; clearInterval(timer); for (const id of Array.from(conns.keys())) closeOne(id, '') } })
  log.appendLine(TAG + ' ' + VERSION + ' armed (sendToDsh=' + enabled() + ')')
  void scan()
}

module.exports = { startBrowserComment }
