/**
 * dsh-review jobs bridge (server side).
 *
 * Exposes the current workspace's background jobs over the dsh web server so
 * the dsh-review-vscode extension can render each job in a read-only
 * Pseudoterminal and kill it by id:
 *
 *   exact  GET  /dsh-review/events            SSE: `job` + `output` frames
 *   prefix /dsh-review/jobs
 *            GET  /dsh-review/jobs            → [{ id, kind, label, status, cwd? }]
 *            POST /dsh-review/jobs/<id>/kill  → { ok: true, result }
 *
 * The dsh jobs service changed shape in 0.2.0, so the bridge feature-detects
 * and wires one of two paths (the HTTP/SSE surface above is identical):
 *
 * Modern path (0.2.0-rc.2+, `jobs.events.subscribe` + `jobs.readAt`):
 * - `jobs.events.subscribe({ owners: 'scope' }, …)` delivers `registered /
 *   progress / stopping / settled / removed` lifecycle events (→ `job`
 *   frames via status diff) and `output` events (id + ring total; the
 *   400ms pump pulls the delta with the NON-CONSUMING `readAt(id, cursor,
 *   caller)`). The registry's single consuming cursor stays with
 *   `job_output` — the bridge never touches `read`, and `reported` cannot
 *   be suppressed.
 * - Owner Agents for the session fence (`readAt/kill(id, caller)` are
 *   owner-fenced) are resolved from `ctx.get('agents')?.get(event.job.owner)`.
 *
 * Legacy path (dsh ≤ 0.1.x, `onJobsChanged` + consuming `read`):
 * - The pump (400ms) CONSUMES the shared cursor via the ORIGINAL `read`
 *   (caller = the recorded owner Agent, so the fence passes) and appends
 *   every delta to a bounded per-job log (256K chars, drop oldest) whose
 *   new content is broadcast as `output` frames.
 * - `ctx.jobs.read` is wrapped once (symbol-flagged, idempotent): the agent
 *   path calls the original as-is and gets the log delta since its reader
 *   position — union of pump- and agent-consumed bytes, no loss, no
 *   duplication.
 * - `onJobsChanged(owner)` + `list(owner)` diff → `job` frames, and records
 *   jobId → owner Agent for the kill fence.
 *
 * Auth: browser session cookie, verified with the same algorithm as
 * dsh-review-vscode/lib/dsh-auth-proxy.js (HMAC-SHA256 over the
 * `$DSH_HOME/.credentials.yaml` client-connection/browser-session secret).
 * Fail closed: no verifiable secret → 401.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import path from 'node:path'

/** Marks a legacy `jobs.read` already wrapped by this module (idempotency flag). */
const TEE = Symbol.for('dsh-review.jobsTee')
/** Marks a jobs registry instance already fully wired by this module. */
const WIRED = Symbol.for('dsh-review.jobsWired')

const LOG_CHARS = 256 * 1024 // legacy per-job output tail window (character cap)
const PUMP_MS = 400
const HEARTBEAT_MS = 20000
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_VERSION = 1
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const TERMINAL = new Set(['completed', 'killed', 'failed'])

function b64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

/** Strict base64url decode (round-trip checked); undefined on malformed input. */
function b64urlDecode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return undefined
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4), 'base64')
  return b64url(decoded) === value ? decoded : undefined
}

/**
 * Bounded per-job output log with positional reads (legacy path). Every
 * output byte passes through exactly once (whoever consumed the shared
 * cursor — pump or agent) and is appended here exactly once, so `since(pos)`
 * gives each reader its delta with no loss and no duplication.
 */
function makeLog() {
  const chunks = []
  let head = 0
  let tail = 0
  return {
    head: () => head,
    tail: () => tail,
    push(text) {
      if (!text) return
      chunks.push({ pos: tail, text })
      tail += text.length
      while (tail - head > LOG_CHARS && chunks.length > 1) {
        const c = chunks.shift()
        head = c.pos + c.text.length
      }
      if (chunks.length === 1 && chunks[0].text.length > LOG_CHARS) {
        const t = chunks[0].text
        const cut = t.length - LOG_CHARS
        chunks[0] = { pos: head + cut, text: t.slice(cut) }
        head = chunks[0].pos
      }
    },
    since(pos) {
      const from = Math.max(pos, head)
      let out = ''
      for (const c of chunks) {
        const end = c.pos + c.text.length
        if (end <= from) continue
        if (c.pos >= from) out += c.text
        else out += c.text.slice(from - c.pos)
      }
      return out
    },
  }
}

/**
 * Wire the jobs bridge into one plugin context. Idempotent: safe to call
 * again after a plugin reload (symbol flags on the jobs instance; duplicate
 * route registration would throw and is contained).
 * @param {object} ctx plugin context exposing `jobs` + `webServer`
 * @param {{ get: () => object, set: (patch: object) => object }=} settingsHooks host settings channel
 * @returns {null|{ jobs: object }}
 */
export function installJobsBridge(ctx, settingsHooks) {
  const jobs = ctx && ctx.jobs
  const webServer = ctx && ctx.webServer
  const hasModern = Boolean(
    jobs && typeof jobs.list === 'function' && typeof jobs.kill === 'function'
    && typeof jobs.readAt === 'function' && jobs.events && typeof jobs.events.subscribe === 'function',
  )
  const hasLegacy = Boolean(
    jobs && typeof jobs.read === 'function' && typeof jobs.kill === 'function'
    && typeof jobs.onJobsChanged === 'function',
  )
  if ((!hasModern && !hasLegacy) || !webServer || typeof webServer.register !== 'function') {
    console.warn('[dsh-review] jobs bridge skipped: ctx.jobs/ctx.webServer not available')
    return null
  }
  if (jobs[WIRED]) return null // already wired for this registry instance
  jobs[WIRED] = true

  /** jobId → per-job pump state (legacy: {log,pumpLast,readers}; modern: {cursor}). */
  const jobState = new Map()
  /** jobId → owner Agent (undefined = unowned job); needed for the kill/read fence. */
  const owners = new Map()
  /** jobId → last broadcast `job` frame (status-diff source + GET list source). */
  const tracked = new Map()
  /** Connected SSE clients. */
  const clients = new Set()
  /** TEMP instrumentation: surface the first pump broadcasts / early failures. */
  let pumpFails = 0
  const pumpSpoke = new Set()

  const stateFor = (id, make) => {
    let st = jobState.get(id)
    if (!st) {
      st = make()
      jobState.set(id, st)
    }
    return st
  }

  const writeFrame = (res, event, data) => {
    try {
      if (res.writableEnded || res.destroyed) {
        clients.delete(res)
        return
      }
      res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')
    } catch {
      clients.delete(res)
    }
  }
  const broadcast = (event, data) => {
    for (const res of [...clients]) writeFrame(res, event, data)
  }

  /** dsh session workbench = owner.session.header.cwd (same as index.js). */
  const cwdOf = (owner) => {
    const cwd = owner && owner.session && owner.session.header && owner.session.header.cwd
    return typeof cwd === 'string' && cwd ? cwd : undefined
  }

  const frameOf = (snap, owner) => {
    const frame = { id: snap.id, kind: snap.kind, label: snap.label, status: snap.status }
    const cwd = cwdOf(owner)
    if (cwd) frame.cwd = cwd
    if (snap.detail) frame.detail = snap.detail
    // Real env prefix of the shell that runs the command: the dsh server
    // process IS the environment the executor inherits (bash `env` is
    // verbatim pass-through), so conda/venv activation is whatever the
    // server actually has — never hardcoded. Per-call env overrides are not
    // in the JobView snapshot and are not shown.
    const env = process.env
    const venv = env.VIRTUAL_ENV ? path.basename(String(env.VIRTUAL_ENV)) : ''
    const envLabel = env.CONDA_DEFAULT_ENV || venv
    if (envLabel) frame.envLabel = '(' + envLabel + ')'
    return frame
  }

  /**
   * Emit a `job` frame when the status moved; record the fence owner.
   * `owner` is the owner Agent for the cwd (legacy path; rc.2 events carry
   * only a SessionId). `fenceOwner` is what `readAt/kill` must be called
   * with: the rc.2 fence compares `job.owner.id !== caller` — a plain
   * SessionId string; the legacy fence wants the Agent object itself.
   */
  const trackFrame = (snap, owner, fenceOwner = owner) => {
    if (fenceOwner !== undefined && !owners.has(snap.id)) owners.set(snap.id, fenceOwner)
    const prev = tracked.get(snap.id)
    if (prev && prev.status === snap.status) return prev
    const frame = frameOf(snap, owner)
    tracked.set(snap.id, frame)
    broadcast('job', frame)
    return frame
  }

  // ---- wiring per capability ------------------------------------------------

  let pump = null
  let offChanged = null

  if (hasModern) {
    // Modern (0.2.0-rc.2): events.subscribe + non-consuming readAt pulls.
    const dirty = new Set()
    const resolveOwner = (sessionId) => {
      if (sessionId === undefined) return undefined
      try {
        const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
        return agents ? agents.get(sessionId) : undefined
      } catch {
        return undefined
      }
    }
    const pull = (id) => {
      const st = jobState.get(id)
      if (!st) return
      let res
      try {
        res = jobs.readAt(id, st.cursor, owners.get(id))
      } catch (e) {
        if (pumpFails < 3) console.warn('[dsh-review] pump readAt FAILED for', id, ':', (e && e.message) || e)
        pumpFails++
        return // fence/unknown job: skip this tick
      }
      const chunks = res && res.chunks
      const text = Array.isArray(chunks) && chunks.length
        ? chunks.map((c) => (typeof c.text === 'string' ? c.text : '')).join('')
        : ''
      if (typeof res.next === 'number') st.cursor = res.next
      if (text) {
        if (!pumpSpoke.has(id)) {
          pumpSpoke.add(id)
          console.info('[dsh-review] pump first broadcast for', id, '(' + text.length + ' chars)')
        }
        broadcast('output', { id, text })
      }
    }
    pump = setInterval(() => {
      for (const id of [...dirty]) {
        const frame = tracked.get(id)
        if (frame && TERMINAL.has(frame.status)) {
          dirty.delete(id)
          continue
        }
        dirty.delete(id)
        pull(id)
      }
    }, PUMP_MS)
    offChanged = jobs.events.subscribe({ owners: 'scope' }, (event) => {
      try {
        if (event.type === 'output') {
          stateFor(event.id, () => ({ cursor: 0 }))
          if (event.owner !== undefined && !owners.has(event.id)) owners.set(event.id, event.owner)
          dirty.add(event.id)
          return
        }
        const snap = event.job
        if (!snap) return
        if (event.type === 'removed') {
          jobState.delete(snap.id)
          dirty.delete(snap.id)
          return
        }
        if (event.type === 'registered') stateFor(snap.id, () => ({ cursor: 0 }))
        if (event.type === 'settled') {
          // Drain the tail BEFORE announcing the terminal status: output
          // frames must precede the footer so the footer always sits at
          // the bottom of the round in the terminal.
          pull(snap.id)
          jobState.delete(snap.id)
          dirty.delete(snap.id)
        }
        // Fence caller = the raw SessionId string (rc.2); the Agent is
        // resolved only to fill frame.cwd for the extension filter.
        trackFrame(snap, resolveOwner(snap.owner), snap.owner)
      } catch (e) {
        console.warn('[dsh-review] jobs event failed:', (e && e.message) || e)
      }
    })
  } else {
    // Legacy (dsh ≤ 0.1.x): read-tee + consuming-read pump + onJobsChanged diff.
    const legacyState = () => ({ log: makeLog(), pumpLast: 0, readers: new Map() })
    const originalRead = jobs.read
    if (!originalRead[TEE]) {
      const wrapped = function read(id, caller) {
        const result = originalRead.call(jobs, id, caller)
        try {
          if (caller !== undefined && !owners.has(id)) owners.set(id, caller)
          const st = stateFor(id, legacyState)
          const delta = result && result.text
          if (typeof delta === 'string' && delta) st.log.push(delta)
          const key = caller && caller.id != null ? String(caller.id) : 'anon'
          const last = st.readers.get(key) ?? st.log.head()
          result.text = st.log.since(last)
          st.readers.set(key, st.log.tail())
        } catch {
          /* union shaping must never break the agent read path */
        }
        return result
      }
      wrapped[TEE] = true
      jobs.read = wrapped
    }
    pump = setInterval(() => {
      for (const [id, st] of jobState) {
        const frame = tracked.get(id)
        if (frame && TERMINAL.has(frame.status)) continue
        let res
        try {
          res = originalRead.call(jobs, id, owners.get(id))
        } catch (e) {
          if (pumpFails < 3) console.warn('[dsh-review] pump read FAILED for', id, ':', (e && e.message) || e)
          pumpFails++
          continue // fence/unknown job: skip this tick
        }
        const text = res && res.text
        if (text) st.log.push(text)
        const delta = st.log.since(st.pumpLast)
        if (delta) {
          if (!pumpSpoke.has(id)) {
            pumpSpoke.add(id)
            console.info('[dsh-review] pump first broadcast for', id, '(' + delta.length + ' chars)')
          }
          st.pumpLast = st.log.tail()
          broadcast('output', { id, text: delta })
        }
      }
    }, PUMP_MS)
    offChanged = jobs.onJobsChanged((owner) => {
      try {
        for (const snap of jobs.list(owner)) {
          if (snap.status === 'running' || snap.status === 'stopping') stateFor(snap.id, legacyState)
          const frame = trackFrame(snap, owner)
          if (TERMINAL.has(snap.status) && frame && frame.status === snap.status && jobState.has(snap.id)) {
            // Final drain: deliver any remaining bytes (stream tail, or the
            // full output of a final-output job) before dropping the state.
            const st = jobState.get(snap.id)
            try {
              const finalRes = originalRead.call(jobs, snap.id, owners.get(snap.id))
              const finalText = finalRes && finalRes.text
              if (finalText) st.log.push(finalText)
              const delta = st.log.since(st.pumpLast)
              if (delta) broadcast('output', { id: snap.id, text: delta })
            } catch { /* noop */ }
            jobState.delete(snap.id) // output done; keep owners for the kill fence
          }
        }
      } catch (e) {
        console.warn('[dsh-review] jobs diff failed:', (e && e.message) || e)
      }
    })
  }
  if (pump && typeof pump.unref === 'function') pump.unref()

  // Comment frames: ignored by every SSE parser, keep proxies/sockets alive.
  const heartbeat = setInterval(() => {
    for (const res of [...clients]) {
      try {
        if (!res.writableEnded && !res.destroyed) res.write(':hb\n\n')
      } catch {
        clients.delete(res)
      }
    }
  }, HEARTBEAT_MS)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  // ---- browser session cookie auth (same algorithm as dsh-auth-proxy) ------

  let secret = null
  let secretTried = false
  const sessionSecret = () => {
    if (secretTried) return secret
    secretTried = true
    try {
      const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
      const text = readFileSync(path.join(home, '.credentials.yaml'), 'utf8')
      const m = text.match(/client-connection\/browser-session:[\s\S]{0,600}?\bsecret:\s*([A-Za-z0-9_-]{40,})/)
      if (m) {
        const decoded = b64urlDecode(m[1])
        if (decoded && decoded.byteLength === 32) secret = decoded
      }
    } catch {
      /* fail closed: routes answer 401 */
    }
    return secret
  }

  const unauthorized = (res) => {
    res.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
    res.end('dsh web authentication required\n')
  }

  const authorized = (req) => {
    const s = sessionSecret()
    if (!s) return false
    let authority
    try {
      authority = new URL('http://' + String(req.headers.host || '')).host
    } catch {
      return false
    }
    const cookieHeader = req.headers.cookie
    if (typeof cookieHeader !== 'string') return false
    const name = COOKIE_PREFIX + b64url(createHash('sha256').update(authority).digest())
    let value
    for (const seg of cookieHeader.split(';')) {
      const at = seg.indexOf('=')
      if (at > 0 && seg.slice(0, at).trim() === name) {
        value = seg.slice(at + 1).trim()
        break
      }
    }
    if (!value) return false
    const parts = value.split('.')
    if (parts.length !== 3 || parts[0] !== 'v' + COOKIE_VERSION) return false
    const body = b64urlDecode(parts[1])
    const sig = b64urlDecode(parts[2])
    if (!body || !sig) return false
    const expected = createHmac('sha256', s).update(parts[1]).digest()
    if (sig.byteLength !== expected.byteLength || !timingSafeEqual(sig, expected)) return false
    let payload
    try {
      payload = JSON.parse(body.toString('utf8'))
    } catch {
      return false
    }
    const now = Date.now()
    return Boolean(
      payload && payload.version === COOKIE_VERSION && payload.authority === authority
      && Number.isSafeInteger(payload.issuedAt) && Number.isSafeInteger(payload.expiresAt)
      && payload.issuedAt <= now && payload.expiresAt > now
      && payload.expiresAt - payload.issuedAt <= MAX_AGE_MS,
    )
  }

  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }

  // ---- HTTP/SSE routes (identical on both paths) ---------------------------

  const disposers = []
  try {
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-review/events',
      handler: (req, res) => {
        if (!authorized(req)) { unauthorized(res); return }
        if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method not allowed' }); return }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write(': connected\n\n')
        clients.add(res)
        res.on('close', () => clients.delete(res))
      },
    }))

    disposers.push(webServer.register({
      kind: 'prefix',
      path: '/dsh-review/jobs',
      handler: (req, res) => {
        if (!authorized(req)) { unauthorized(res); return }
        let pathname
        try {
          pathname = new URL(req.url || '/', 'http://x').pathname
        } catch {
          json(res, 400, { ok: false, error: 'bad request' })
          return
        }
        if (req.method === 'GET' && pathname === '/dsh-review/jobs') {
          json(res, 200, [...tracked.values()])
          return
        }
        if (req.method === 'POST') {
          const m = pathname.match(/^\/dsh-review\/jobs\/([^/]+)\/kill$/)
          if (!m) {
            json(res, 404, { ok: false, error: 'not found' })
            return
          }
          const id = decodeURIComponent(m[1])
          const owner = owners.get(id) // undefined = unowned job (open to any caller)
          let result
          try {
            result = jobs.kill(id, owner)
          } catch (e) {
            json(res, 404, { ok: false, error: (e && e.message) || String(e) })
            return
          }
          json(res, 200, { ok: true, result })
          return
        }
        json(res, 405, { ok: false, error: 'method not allowed' })
      },
    }))

    // Plugin settings channel (same browser-session cookie auth). The rc.2
    // web profile has no settings persistence provider, so the card reads
    // and writes through this route instead of the official settings plane.
    if (settingsHooks && typeof settingsHooks.get === 'function' && typeof settingsHooks.set === 'function') {
      disposers.push(webServer.register({
        kind: 'exact',
        path: '/dsh-review/settings',
        handler: (req, res) => {
          if (!authorized(req)) { unauthorized(res); return }
          if (req.method === 'GET') { json(res, 200, settingsHooks.get()); return }
          if (req.method === 'POST') {
            let body = ''
            req.on('data', (c) => { body += c; if (body.length > 65536) { json(res, 413, { ok: false, error: 'too large' }); req.destroy() } })
            req.on('end', () => {
              let parsed
              try { parsed = JSON.parse(body || '{}') } catch { json(res, 400, { ok: false, error: 'bad json' }); return }
              try { json(res, 200, settingsHooks.set(parsed)) } catch (e) { json(res, 500, { ok: false, error: (e && e.message) || String(e) }) }
            })
            return
          }
          json(res, 405, { ok: false, error: 'method not allowed' })
        },
      }))
    }
  } catch (e) {
    // e.g. duplicate route on a shared webserver: leave the prior wiring in place.
    for (const dispose of disposers) { try { dispose() } catch { /* noop */ } }
    jobs[WIRED] = false
    console.warn('[dsh-review] jobs bridge route registration failed:', (e && e.message) || e)
    return null
  }

  console.info('[dsh-review] jobs bridge ready (' + (hasModern ? 'events/readAt' : 'legacy read-tee') + '): /dsh-review/events (SSE) + /dsh-review/jobs (list/kill)')

  // teardown on plugin scope disposal (clears timers, routes, listeners).
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        if (pump) clearInterval(pump)
        clearInterval(heartbeat)
        try { if (offChanged) offChanged() } catch { /* noop */ }
        for (const dispose of disposers) { try { dispose() } catch { /* noop */ } }
        clients.clear()
        jobState.clear()
        jobs[WIRED] = false
      }, 'dsh-review:jobs-bridge')
    } catch (e) {
      console.warn('[dsh-review] jobs bridge teardown registration failed:', (e && e.message) || e)
    }
  }
  return { jobs }
}
