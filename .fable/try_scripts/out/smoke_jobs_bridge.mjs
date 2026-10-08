#!/usr/bin/env node
// Smoke test for dsh-review/jobs.js with a mock ctx (jobs + webServer + cookie secret).
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'

const PLUGIN = '/Volumes/SAMSUNG_1T/Documents/CodeBeach/project/dsh-review-plugin/dsh-review'

// ---- temp DSH_HOME with a real 32-byte browser-session secret (scratch in WS) ----
const tmpHome = path.join(path.dirname(new URL(import.meta.url).pathname), 'smoke-tmp-home')
mkdirSync(tmpHome, { recursive: true })
const secret = randomBytes(32)
const b64url = (v) => Buffer.from(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
writeFileSync(path.join(tmpHome, '.credentials.yaml'),
  `client-connection/browser-session:\n  kind: grant\n  payload:\n    version: 1\n    secret: ${b64url(secret)}\n`, 'utf8')
process.env.DSH_HOME = tmpHome

const { installJobsBridge } = await import(path.join(PLUGIN, 'jobs.js'))

// ---- mock jobs registry (fence semantics copied from dsh-jobs-local) ----
const owner = { id: 'session-1', session: { header: { cwd: '/Volumes/ws/current' } } }
const other = { id: 'session-2', session: { header: { cwd: '/Volumes/ws/other' } } }
const full = 'tick 1\ntick 2\ntick 3\n'
const state = { status: 'running', cursor: 0, reported: false }
const changed = new Set()
const jobs = {
  read(id, caller) {
    if (owner && owner.id !== caller?.id) throw new Error(`job ${id} belongs to another session`)
    const text = full.slice(state.cursor)
    state.cursor = full.length
    if (state.status !== 'running') state.reported = true
    return { text, snapshot: { id, kind: 'bash', label: 'tick loop', status: state.status, reported: state.reported } }
  },
  list(caller) {
    const session = caller?.id
    return session === owner.id ? [{ id: 'bash-1', kind: 'bash', label: 'tick loop', status: state.status, reported: state.reported }] : []
  },
  kill(id, caller, reason) {
    if (owner.id !== caller?.id) throw new Error(`job ${id} belongs to another session`)
    if (state.status !== 'running') return 'already-finished'
    state.status = 'killed'
    state.reported = true
    for (const fn of changed) fn(owner)
    return 'requested'
  },
  onJobsChanged(fn) { changed.add(fn); return () => changed.delete(fn) },
}

// ---- mock webServer (duplicate (kind,path) throws, like dsh-host-webserver) ----
const routes = new Map()
const webServer = {
  register(route) {
    const key = route.kind + ':' + route.path
    if (routes.has(key)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    routes.set(key, route)
    return () => routes.delete(key)
  },
}

const cleanups = []
const ctx = { jobs, webServer, effect(execute, label) { cleanups.push({ label, fn: execute() }) } }

// ---- cookie minting (same algorithm as dsh-auth-proxy / client-connection) ----
const AUTH = '127.0.0.1:3080'
const cookieName = 'dsh-auth-' + b64url(createHash('sha256').update(AUTH).digest())
const issuedAt = Date.now()
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: AUTH, issuedAt, expiresAt: issuedAt + 29 * 24 * 3600 * 1000 }), 'utf8'))
const sig = b64url(createHmac('sha256', secret).update(body).digest())
const COOKIE = cookieName + '=v1.' + body + '.' + sig

// ---- mock req/res ----
function mockRes() {
  const res = new EventEmitter()
  res.status = 0
  res.body = ''
  res.headersSent = false
  res.writableEnded = false
  res.destroyed = false
  res.writeHead = (s, h) => { res.status = s; res.headers = h; res.headersSent = true }
  res.write = (chunk) => { res.body += chunk; return true }
  res.end = (chunk) => { if (chunk) res.body += chunk; res.writableEnded = true; res.emit('close') }
  return res
}
const req = (method, urlPath, { cookie = true } = {}) => ({
  method,
  url: urlPath,
  headers: { host: AUTH, ...(cookie ? { cookie: COOKIE } : {}) },
})

let failures = 0
const check = (name, cond, extra = '') => {
  console.log((cond ? '  [ok] ' : '  [FAIL] ') + name + (extra ? ' — ' + extra : ''))
  if (!cond) failures++
}

// ---- 1. wiring + idempotency ----
console.log('1. wiring')
const first = installJobsBridge(ctx)
check('first install wired', !!first)
check('routes registered: exact /dsh-review/events + prefix /dsh-review/jobs',
  routes.has('exact:/dsh-review/events') && routes.has('prefix:/dsh-review/jobs'))
const wrappedRead = jobs.read
check('jobs.read wrapped with TEE symbol', wrappedRead[Symbol.for('dsh-review.jobsTee')] === true)
const second = installJobsBridge(ctx)
check('second install is a no-op (idempotent)', second === null && jobs.read === wrappedRead)

// ---- 2. job frame via onJobsChanged ----
console.log('2. job frames')
const sseRes = mockRes()
routes.get('exact:/dsh-review/events').handler(req('GET', '/dsh-review/events'), sseRes)
check('sse connected (200 + text/event-stream)', sseRes.status === 200 && /text\/event-stream/.test(sseRes.headers['content-type'] || ''))

for (const fn of changed) fn(owner) // job started
await new Promise((r) => setTimeout(r, 500))
check('job frame broadcast (running + cwd)', /event: job\ndata: \{"id":"bash-1"[^\n]*"status":"running"[^\n]*"cwd":"\/Volumes\/ws\/current"/.test(sseRes.body), sseRes.body.slice(0, 200))

// ---- 3. tee + pump ----
console.log('3. tee + 400ms pump')
const agentResult = jobs.read('bash-1', owner)
check('agent read returns full delta, unmodified', agentResult.text === full)
check('agent read reported flag untouched (running)', agentResult.snapshot.reported === false)
await new Promise((r) => setTimeout(r, 900))
check('sse output frame carries the tee\'d delta', /event: output\ndata: \{"id":"bash-1","text":"tick 1\\ntick 2\\ntick 3\\n"\}/.test(sseRes.body))
const agentResult2 = jobs.read('bash-1', owner)
check('second agent read is empty (no dup, cursor intact)', agentResult2.text === '')

// ---- 4. GET list ----
console.log('4. GET /dsh-review/jobs')
const listRes = mockRes()
routes.get('prefix:/dsh-review/jobs').handler(req('GET', '/dsh-review/jobs'), listRes)
let list = []
try { list = JSON.parse(listRes.body) } catch { }
check('list 200 JSON with id/kind/label/status/cwd',
  listRes.status === 200 && list.length === 1 && list[0].id === 'bash-1' && list[0].kind === 'bash'
  && list[0].label === 'tick loop' && list[0].status === 'running' && list[0].cwd === '/Volumes/ws/current',
  listRes.body)

// ---- 5. kill route (fence passes with recorded owner) ----
console.log('5. kill route')
const killRes = mockRes()
routes.get('prefix:/dsh-review/jobs').handler(req('POST', '/dsh-review/jobs/bash-1/kill'), killRes)
check('kill 200 {ok:true,result:requested}', killRes.status === 200 && /"ok":true,"result":"requested"/.test(killRes.body), killRes.body)
await new Promise((r) => setTimeout(r, 500))
check('job frame with terminal status broadcast', /event: job\ndata: \{[^\n]*"status":"killed"/.test(sseRes.body))
const killRes2 = mockRes()
routes.get('prefix:/dsh-review/jobs').handler(req('POST', '/dsh-review/jobs/bash-1/kill'), killRes2)
check('kill idempotent → already-finished', killRes2.status === 200 && /"result":"already-finished"/.test(killRes2.body), killRes2.body)
const killOther = mockRes()
routes.get('prefix:/dsh-review/jobs').handler(req('POST', '/dsh-review/jobs/bash-9/kill'), killOther)
check('kill unknown id → 404 {ok:false}', killOther.status === 404 && /"ok":false/.test(killOther.body), killOther.body)

// ---- 6. auth ----
console.log('6. auth')
const noAuth = mockRes()
routes.get('prefix:/dsh-review/jobs').handler(req('GET', '/dsh-review/jobs', { cookie: false }), noAuth)
check('missing cookie → 401', noAuth.status === 401, noAuth.body.trim())
const badAuth = mockRes()
const badCookie = COOKIE.replace(/v1\./, 'v1.tampered.')
routes.get('prefix:/dsh-review/jobs').handler({ method: 'GET', url: '/dsh-review/jobs', headers: { host: AUTH, cookie: badCookie } }, badAuth)
check('tampered signature → 401', badAuth.status === 401)
const wrongHost = mockRes()
routes.get('exact:/dsh-review/events').handler({ method: 'GET', url: '/dsh-review/events', headers: { host: '127.0.0.1:9999', cookie: COOKIE } }, wrongHost)
check('cookie for other authority → 401', wrongHost.status === 401)

// ---- 7. teardown ----
console.log('7. teardown')
for (const c of cleanups) c.fn()
check('teardown unregisters routes', routes.size === 0)
check('teardown clears WIRED (re-wire allowed)', jobs[Symbol.for('dsh-review.jobsWired')] === false)
const third = installJobsBridge(ctx)
check('re-wire after teardown works', !!third)
for (const c of cleanups) if (c.fn) c.fn()

// cleanup temp home
try { rmSync(tmpHome, { recursive: true, force: true }) } catch { }
console.log(failures === 0 ? 'SMOKE PASS' : `SMOKE FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
