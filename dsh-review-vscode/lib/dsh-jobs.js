'use strict'

/**
 * dsh jobs → read-only VSCode terminals (extension host side).
 *
 * Pairs with the dsh-review server plugin, which over the dsh web server
 * (127.0.0.1:<dshPort>) exposes:
 *
 *   GET  /dsh-review/events             SSE: `job` + `output` frames
 *   GET  /dsh-review/jobs               → [{ id, kind, label, status, cwd? }]
 *   POST /dsh-review/jobs/<id>/kill     → { ok: true, result }
 *
 * Auth is the same browser-session cookie the sidebar auth proxy mints
 * (HMAC-SHA256 over the $DSH_HOME browser-session secret) — see
 * dsh-auth-proxy.js. We mint it ourselves for the `127.0.0.1:<port>`
 * authority and attach it to every request.
 *
 * Behaviour:
 * - node:http opens the SSE stream (the extension host has no EventSource)
 *   and parses `event:`/`data:` frames incrementally (streaming TextDecoder).
 * - On connect AND on every reconnect we first GET /dsh-review/jobs and open
 *   a terminal for each already-running job in the current workspace — the
 *   server does not replay history over SSE, so this reconciles the gap.
 * - `job` frame: status=running && cwd === current workspace folder ⇒
 *   createTerminal({ pty }) with a read-only Pseudoterminal (handleInput is
 *   a no-op). Terminals are deduped by job id.
 * - `output` frame ⇒ pty.write; terminal `job` frame ⇒ `[done: <status>]` tail.
 * - User closing the tab (pty.close) or the killDshJob command ⇒ POST kill.
 *
 * All failures are logged to the passed `log` sink; nothing throws out.
 */

const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const vscode = require('vscode')
const { mintCookie } = require('./dsh-auth-proxy.js')
const { dshPort } = require('./dsh-process.js')

// Whale icon (same SVG as the sidebar dsh view) for terminal tabs.
// Fixed blue: visible on both dark and light terminal tab backgrounds.
function whaleIconUri() {
  return vscode.Uri.file(path.join(__dirname, '..', 'media', 'dsh-blue.svg'))
}

const DONE = new Set(['completed', 'killed', 'failed'])
const BACKOFF_START_MS = 1000
const BACKOFF_MAX_MS = 30000

/**
 * @param {{ log?: (msg: string) => void }} opts
 * @returns {{ connect: () => void, disconnect: () => void, kill: (id: string) => void, killActive: () => (string | null) }}
 */
function connectDshJobs(opts) {
  const log = typeof opts.log === 'function' ? opts.log : () => { }

  const authority = () => '127.0.0.1:' + String(dshPort())
  const workspaceRoot = () => {
    const folders = vscode.workspace.workspaceFolders
    return folders && folders.length ? folders[0].uri.fsPath : ''
  }

  let closed = false
  let gen = 0
  let timer = null
  let backoff = BACKOFF_START_MS
  let currentReq = null
  /** jobId → { terminal, id, write } (dedup source). */
  const terminals = new Map()

  // ---- read-only Pseudoterminals -----------------------------------------

  /**
   * Open (or focus) the read-only terminal for a job. Pre-`open()` output is
   * buffered and flushed once the terminal host calls open().
   * @param {string} id
   * @param {{ id: string, label?: string }} frame
   */
  function ensureTerminal(id, frame) {
    const existing = terminals.get(id)
    if (existing) {
      try { existing.terminal.show(true) } catch { /* noop */ }
      return existing
    }
    let writer = null
    let opened = false
    let preBuffer = ''
    const pty = {
      onDidWrite: (cb) => { writer = cb; return { dispose: () => { } } },
      onDidClose: () => ({ dispose: () => { } }),
      onDidResize: () => ({ dispose: () => { } }),
      open: () => {
        opened = true
        if (preBuffer) {
          const t = preBuffer
          preBuffer = ''
          if (writer) { try { writer(t) } catch { /* noop */ } }
        }
      },
      close: () => {
        // User closed the tab ⇒ kill the job (pty.close is the primary kill
        // trigger; onDidCloseTerminal is redundant with it).
        if (terminals.has(id)) kill(id)
      },
      // Read-only: never handle input.
      handleInput: () => { },
    }
    let terminal
    try {
      // Custom whale SVG on the tab (1.138: iconPath accepts a file Uri).
      // If the host rejects it, fall back to the default icon.
      try {
        terminal = vscode.window.createTerminal({ name: 'dsh ' + id, pty, iconPath: whaleIconUri() })
      } catch (e1) {
        log('[jobs] whale icon rejected: ' + String((e1 && e1.message) || e1))
        terminal = vscode.window.createTerminal({ name: 'dsh ' + id, pty })
      }
    } catch (e) {
      log('[jobs] createTerminal failed for ' + id + ': ' + String((e && e.message) || e))
      return null
    }
    const entry = {
      terminal,
      id,
      write: (text) => {
        if (!text) return
        // A real PTY has termios ONLCR post-processing (\n -> \r\n); a
        // Pseudoterminal feeds xterm raw, so LF-only line breaks land the
        // cursor in the same column (staircase output). Normalize to CRLF.
        const data = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
        if (opened && writer) { try { writer(data) } catch { /* noop */ } }
        else { preBuffer += data }
      },
    }
    terminals.set(id, entry)
    // Show the agent's input as a real-shell prompt line (green PS1 look,
    // `(base) user@host dir %` + the command) before the first output byte.
    // SSE is ordered, so the job frame (and this header) always precede the
    // job's output frames; the prompt line doubles as the per-round
    // divider when a tab is reopened on a status frame.
    entry.write(promptLine(id, frame) + '\n')
    try { terminal.show(true) } catch { /* noop */ }
    log('[jobs] open terminal for ' + id + (frame && frame.label ? ' (' + frame.label + ')' : ''))
    return entry
  }

  // ---- SSE frame handling -------------------------------------------------

  const DONE_MARK = { completed: '✔ completed', failed: '✘ failed', killed: '■ killed' }

  /** Real-terminal prompt: `<env> user@host dir %` (green) + the command. */
  function promptLine(id, frame) {
    const user = os.userInfo().username
    const host = os.hostname().replace(/\.local$/, '')
    const dir = path.basename(String((frame && frame.cwd) || '~'))
    // envLabel comes from the dsh server's real environment (conda/venv);
    // no label → no prefix, never a made-up "(base)".
    const envLabel = frame && frame.envLabel ? String(frame.envLabel) + ' ' : ''
    const prompt = '\x1b[32m' + envLabel + user + '@' + host + ' ' + dir + ' %\x1b[0m '
    const label = frame && frame.label
    return prompt + (label ? String(label) : '(job ' + id + ')')
  }

  function onJobFrame(frame) {
    if (!frame || !frame.id) return
    const id = frame.id
    if (frame.status === 'running') {
      // Scope: only jobs whose cwd is the current workspace folder.
      if (frame.cwd && frame.cwd === workspaceRoot()) ensureTerminal(id, frame)
      return
    }
    const entry = terminals.get(id)
    if (entry && DONE.has(frame.status)) {
      const detail = typeof frame.detail === 'string' && frame.detail ? ' · ' + frame.detail : ''
      entry.write('\n' + (DONE_MARK[frame.status] || '[done: ' + frame.status + ']') + detail + '\n')
    }
  }

  function onOutputFrame(frame) {
    if (!frame || !frame.id || !frame.text) return
    const entry = terminals.get(frame.id)
    if (entry) entry.write(frame.text)
  }

  function handleFrame(event, data) {
    let obj
    try { obj = JSON.parse(data) } catch { return }
    if (event === 'job') onJobFrame(obj)
    else if (event === 'output') onOutputFrame(obj)
  }

  // ---- kill ---------------------------------------------------------------

  /**
   * POST /dsh-review/jobs/<id>/kill and drop our terminal.
   * @param {string} id
   */
  function kill(id) {
    if (!id) return
    let cookie
    try {
      cookie = mintCookie(authority())
    } catch (e) {
      log('[jobs] kill ' + id + ': cannot mint cookie: ' + String((e && e.message) || e))
      return
    }
    const req = http.request({
      host: '127.0.0.1',
      port: dshPort(),
      path: '/dsh-review/jobs/' + encodeURIComponent(id) + '/kill',
      method: 'POST',
      headers: { cookie, 'content-length': 0 },
    }, (res) => {
      res.on('data', () => { /* drain */ })
      res.on('end', () => log('[jobs] kill ' + id + ' -> ' + String(res.statusCode)))
    })
    req.on('error', (e) => log('[jobs] kill ' + id + ' failed: ' + String((e && e.message) || e)))
    req.end()
    const entry = terminals.get(id)
    if (entry) {
      terminals.delete(id)
      try { entry.terminal.dispose() } catch { /* noop */ }
    }
  }

  /**
   * Kill the job bound to the active terminal, if it is one of ours.
   * @returns {string | null} the killed job id (null if the active terminal is not a dsh job).
   */
  function killActive() {
    const active = vscode.window.activeTerminal
    if (!active) return null
    for (const [id, entry] of terminals) {
      if (entry.terminal === active) {
        kill(id)
        return id
      }
    }
    return null
  }

  // ---- SSE client (node:http + incremental parse) -------------------------

  /**
   * @param {(event: string, data: string) => void} onEvent
   */
  function makeSseParser(onEvent) {
    const decoder = new TextDecoder('utf-8')
    let pending = ''
    let curEvent = ''
    let dataLines = []
    return {
      feed(chunk) {
        pending += decoder.decode(chunk, { stream: true })
        let nl
        while ((nl = pending.indexOf('\n')) !== -1) {
          let line = pending.slice(0, nl)
          pending = pending.slice(nl + 1)
          if (line.endsWith('\r')) line = line.slice(0, -1)
          if (line === '') {
            if (dataLines.length > 0) onEvent(curEvent || 'message', dataLines.join('\n'))
            curEvent = ''
            dataLines = []
            continue
          }
          if (line.charAt(0) === ':') continue // comment / heartbeat
          const colon = line.indexOf(':')
          const field = colon === -1 ? line : line.slice(0, colon)
          let value = colon === -1 ? '' : line.slice(colon + 1)
          if (value.startsWith(' ')) value = value.slice(1)
          if (field === 'event') curEvent = value
          else if (field === 'data') dataLines.push(value)
        }
      },
    }
  }

  /**
   * @param {string} cookie
   * @returns {Promise<string[]>}
   */
  function getJobs(cookie) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: dshPort(),
        path: '/dsh-review/jobs',
        method: 'GET',
        headers: { cookie, accept: 'application/json' },
      }, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          if (res.statusCode === 401) { reject(new Error('401')); return }
          if (!res.statusCode || res.statusCode >= 400) { reject(new Error('status ' + res.statusCode)); return }
          try { resolve(JSON.parse(body)) } catch { resolve([]) }
        })
      })
      req.on('error', reject)
      req.end()
    })
  }

  /** Reconcile already-running jobs (server does not replay SSE history). */
  function reconcileJob(job) {
    if (job && job.status === 'running' && job.cwd && job.cwd === workspaceRoot()) {
      ensureTerminal(job.id, job)
    }
  }

  function openSse(cookie, myGen) {
    const parser = makeSseParser((event, data) => {
      if (myGen !== gen) return
      handleFrame(event, data)
    })
    if (currentReq) { try { currentReq.destroy() } catch { /* noop */ } }
    const req = http.request({
      host: '127.0.0.1',
      port: dshPort(),
      path: '/dsh-review/events',
      method: 'GET',
      headers: { cookie, accept: 'text/event-stream', 'cache-control': 'no-cache' },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        if (myGen === gen) {
          log('[jobs] /events status ' + String(res.statusCode) + ', reconnecting')
          scheduleReconnect()
        }
        return
      }
      if (myGen === gen) {
        backoff = BACKOFF_START_MS
        log('[jobs] SSE connected')
      }
      res.on('data', (chunk) => parser.feed(chunk))
      res.on('end', () => { if (myGen === gen) scheduleReconnect() })
      res.on('close', () => { if (myGen === gen) scheduleReconnect() })
    })
    req.on('error', (e) => {
      if (myGen === gen) {
        log('[jobs] SSE error: ' + String((e && e.message) || e) + ', reconnecting')
        scheduleReconnect()
      }
    })
    currentReq = req
    req.end()
  }

  function scheduleReconnect() {
    if (closed || timer) return
    const delay = backoff
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    timer = setTimeout(() => {
      timer = null
      connect()
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function connect() {
    if (closed) return
    gen += 1
    const myGen = gen
    let cookie
    try {
      cookie = mintCookie(authority())
    } catch (e) {
      log('[jobs] cannot mint cookie: ' + String((e && e.message) || e))
      scheduleReconnect()
      return
    }
    getJobs(cookie)
      .then((list) => {
        if (closed || myGen !== gen) return
          ; (Array.isArray(list) ? list : []).forEach(reconcileJob)
      })
      .catch((e) => log('[jobs] list jobs failed: ' + String((e && e.message) || e)))
      .then(() => {
        if (closed || myGen !== gen) return
        openSse(cookie, myGen)
      })
  }

  function disconnect() {
    closed = true
    gen += 1
    if (timer) { clearTimeout(timer); timer = null }
    if (currentReq) { try { currentReq.destroy() } catch { /* noop */ } }
    for (const entry of terminals.values()) {
      try { entry.terminal.dispose() } catch { /* noop */ }
    }
    terminals.clear()
  }

  connect()

  return {
    connect,
    disconnect,
    kill,
    killActive,
  }
}

module.exports = { connectDshJobs }
