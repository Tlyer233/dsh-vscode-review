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
 * Wiring (all in this file; dsh core untouched):
 * - Output is a single consumption cursor shared by the agent and the pump.
 *   The pump (400ms) consumes it via the ORIGINAL `read` (caller = the
 *   recorded owner Agent, so the session fence passes) and appends every
 *   delta to a bounded per-job log (256K chars, drop oldest) whose new
 *   content is broadcast as `output` frames — the VSCode terminal gets
 *   output in real time, without the agent reading.
 * - `ctx.jobs.read` is wrapped once (symbol-flagged, idempotent): the agent
 *   path calls the original as-is (throws propagate untouched), appends its
 *   delta to the same log, and returns the log delta since that reader's
 *   last position — the union of pump-consumed and agent-consumed bytes.
 *   No loss, no duplication.
 * - `reported` safety: settle() captures its snapshot synchronously (no
 *   await) and the completion notice consumes that captured snapshot, so a
 *   later pump tick setting `reported` cannot suppress the agent's notice.
 *   The pump also skips already-terminal jobs.
 * - `onJobsChanged(owner)` + `list(owner)` diff → `job` frames (new job /
 *   status change) and records jobId → owner Agent so `kill` can pass the
 *   session fence.
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

/** Marks a `jobs.read` already wrapped by this module (idempotency flag). */
const TEE = Symbol.for('dsh-review.jobsTee')
/** Marks a jobs registry instance already fully wired by this module. */
const WIRED = Symbol.for('dsh-review.jobsWired')

const LOG_CHARS = 256 * 1024 // per-job output tail window (character cap)
const PUMP_MS = 400
const HEARTBEAT_MS = 20000
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_VERSION = 1
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

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
 * Bounded per-job output log with positional reads. Every output byte
 * passes through exactly once (whoever consumed the shared cursor — pump or
 * agent) and is appended here exactly once, so `since(pos)` gives each
 * reader its delta with no loss and no duplication. Offsets are character
 * positions; over-cap drops the oldest. Never blocks the main path.
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
 * @returns {null|{ jobs: object }}
 */
export function installJobsBridge(ctx) {
  const jobs = ctx && ctx.jobs
  const webServer = ctx && ctx.webServer
  if (
    !jobs || typeof jobs.read !== 'function' || typeof jobs.list !== 'function'
    || typeof jobs.kill !== 'function' || typeof jobs.onJobsChanged !== 'function'
    || !webServer || typeof webServer.register !== 'function'
  ) {
    console.warn('[dsh-review] jobs bridge skipped: ctx.jobs/ctx.webServer not available')
    return null
  }
  if (jobs[WIRED]) return null // already wired for this registry instance
  jobs[WIRED] = true

  /** jobId → { log, pumpLast, readers: Map<readerKey, pos> } (bounded tail window). */
  const jobState = new Map()
  /** jobId → owner Agent (undefined = unowned job); needed for the kill fence. */
  const owners = new Map()
  /** jobId → last broadcast `job` frame (status-diff source + GET list source). */
  const tracked = new Map()
  /** Connected SSE clients. */
  const clients = new Set()

  const stateFor = (id) => {
    let st = jobState.get(id)
    if (!st) {
      st = { log: makeLog(), pumpLast: 0, readers: new Map() }
      jobState.set(id, st)
    }
    return st
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
    return frame
  }

  // 1) wrap ctx.jobs.read once. The original is called as-is (throws
  //    propagate untouched); the delta is appended to the log and the
  //    result text is replaced with this reader's union delta (everything
  //    since its last position — covers bytes the pump consumed in between).
  const originalRead = jobs.read
  if (!originalRead[TEE]) {
    const wrapped = function read(id, caller) {
      const result = originalRead.call(jobs, id, caller)
      try {
        if (caller !== undefined && !owners.has(id)) owners.set(id, caller)
        const st = stateFor(id)
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

  // 2) SSE broadcast + 400ms pump. The pump CONSUMES the shared cursor via
  //    the original read (caller = recorded owner, fence passes) and
  //    broadcasts the log delta — real-time terminal output. It skips
  //    terminal jobs, and `reported` is safe: settle() captures its
  //    snapshot synchronously, before any later pump tick can run.
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
  // TEMP instrumentation: surface the first pump failures/broadcasts.
  let pumpFails = 0
  const pumpSpoke = new Set()
  const pump = setInterval(() => {
    for (const [id, st] of jobState) {
      const frame = tracked.get(id)
      if (frame && (frame.status === 'completed' || frame.status === 'killed' || frame.status === 'failed')) continue
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
  if (typeof pump.unref === 'function') pump.unref()
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

  // 3) `job` frames: onJobsChanged + list diff. list() is pure (no output
  //    cursor advance) and is called with the exact changed owner, so the
  //    fence passes. Status diff suppresses duplicate frames (unowned jobs
  //    reappear in several owners' views).
  const offChanged = jobs.onJobsChanged((owner) => {
    try {
      for (const snap of jobs.list(owner)) {
        if (!owners.has(snap.id)) owners.set(snap.id, owner)
        // Give every running job pump state, even one nobody has read —
        // otherwise the pump (which iterates jobState) never follows it.
        if (snap.status === 'running') stateFor(snap.id)
        const prev = tracked.get(snap.id)
        if (!prev || prev.status !== snap.status) {
          tracked.set(snap.id, frameOf(snap, owner))
          broadcast('job', tracked.get(snap.id))
          if (snap.status === 'completed' || snap.status === 'killed' || snap.status === 'failed') {
            // Final drain: deliver any remaining bytes (stream tail, or the
            // full output of a final-output job) before dropping the state.
            const st = jobState.get(snap.id)
            if (st) {
              try {
                const finalRes = originalRead.call(jobs, snap.id, owners.get(snap.id))
                const finalText = finalRes && finalRes.text
                if (finalText) st.log.push(finalText)
                const delta = st.log.since(st.pumpLast)
                if (delta) broadcast('output', { id: snap.id, text: delta })
              } catch { /* noop */ }
            }
            jobState.delete(snap.id) // output done; keep owners for the kill fence
          }
        }
      }
    } catch (e) {
      console.warn('[dsh-review] jobs diff failed:', (e && e.message) || e)
    }
  })

  // 4) browser session cookie auth (same algorithm as dsh-auth-proxy).
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
  } catch (e) {
    // e.g. duplicate route on a shared webserver: leave the prior wiring in place.
    for (const dispose of disposers) { try { dispose() } catch { /* noop */ } }
    jobs[WIRED] = false
    console.warn('[dsh-review] jobs bridge route registration failed:', (e && e.message) || e)
    return null
  }

  console.info('[dsh-review] jobs bridge ready: /dsh-review/events (SSE) + /dsh-review/jobs (list/kill)')

  // 5) teardown on plugin scope disposal (clears timers, routes, listeners).
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        clearInterval(pump)
        clearInterval(heartbeat)
        try { offChanged() } catch { /* noop */ }
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
