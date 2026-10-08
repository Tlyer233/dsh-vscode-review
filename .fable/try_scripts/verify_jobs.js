#!/usr/bin/env node
'use strict'
// VERIFY tool for the dsh-review jobs-over-SSE + kill feature.
// Drives a RUNNING dsh server (web profile with the dsh-review plugin) through
// the HOOK CONTRACT routes and writes a fixed report.
//
// Usage:
//   node verify_jobs.js --port=3080 --job=bash-1 --seconds=6 [--dsh-home=$HOME/.dsh]
//
// Parameters:
//   --port      dsh web server port (default 3080)
//   --job       target job id, e.g. bash-1 (must be a LIVE job producing output)
//   --seconds   total SSE capture window in seconds (default 6); kill fires at 50%
//   --dsh-home  DSH_HOME for cookie minting (default $DSH_HOME or ~/.dsh)
//
// Output (overwritten each run): try_scripts/out/verify_jobs.txt
// Exit code: 0 = PASS, 1 = FAIL
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const args = Object.fromEntries(
  process.argv.slice(2).map((s) => {
    const i = s.indexOf('=')
    return [s.slice(2, i), s.slice(i + 1)]
  }),
)
const PORT = Number(args.port) || 3080
const JOB_ID = args.job
const SECONDS = Number(args.seconds) || 6
const DSH_HOME = args['dsh-home'] || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const OUT = path.join(__dirname, 'out', 'verify_jobs.txt')

if (!JOB_ID) {
  console.error('missing --job')
  process.exit(1)
}

// ---- cookie minting (same algorithm as dsh-review-vscode/lib/dsh-auth-proxy.js) ----
function b64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}
function mintCookie(authority) {
  const file = path.join(DSH_HOME, '.credentials.yaml')
  const text = fs.readFileSync(file, 'utf8')
  const m = text.match(/client-connection\/browser-session:[\s\S]{0,600}?\bsecret:\s*([A-Za-z0-9_-]{40,})/)
  if (!m) throw new Error('browser-session secret not found in ' + file)
  const secret = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (secret.byteLength !== 32) throw new Error('unexpected secret size')
  const issuedAt = Date.now()
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 29 * 24 * 3600 * 1000 }), 'utf8'))
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest())
  const name = 'dsh-auth-' + b64url(crypto.createHash('sha256').update(authority).digest())
  return name + '=v1.' + body + '.' + sig
}

function request(method, urlPath, cookie, body) {
  return new Promise((resolveP, rejectP) => {
    const headers = { host: '127.0.0.1:' + PORT }
    if (cookie) headers.cookie = cookie
    if (body != null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(body)
    }
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: urlPath, headers }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolveP({ status: res.statusCode, body: data }))
    })
    req.on('error', rejectP)
    if (body != null) req.write(body)
    req.end()
  })
}

const lines = []
const log = (s) => { lines.push(s); console.log(s) }

async function main() {
  log('VERIFY dsh-review jobs (port=' + PORT + ' job=' + JOB_ID + ' seconds=' + SECONDS + ')')

  // 1. cookie
  let cookie = ''
  try {
    cookie = mintCookie('127.0.0.1:' + PORT)
    log('[cookie] minted ok for 127.0.0.1:' + PORT)
  } catch (e) {
    log('[cookie] mint FAILED (continuing without): ' + e.message)
  }

  // 2. jobs list
  let jobs = []
  try {
    const r = await request('GET', '/dsh-review/jobs', cookie)
    log('[jobs] HTTP ' + r.status)
    try {
      jobs = JSON.parse(r.body)
      const hit = jobs.find((j) => j && j.id === JOB_ID)
      log('[jobs] ' + jobs.length + ' job(s); target ' + JOB_ID + ' = ' + (hit ? hit.status + ' "' + hit.label + '" cwd=' + (hit.cwd || '?') : 'NOT IN LIST'))
    } catch {
      log('[jobs] body not JSON: ' + r.body.slice(0, 200))
    }
  } catch (e) {
    log('[jobs] request failed: ' + e.message)
  }

  // 3. SSE capture (kill fires at 50% of the window)
  const events = { job: [], output: [] }
  const sse = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: '/dsh-review/events', headers: { host: '127.0.0.1:' + PORT, accept: 'text/event-stream', ...(cookie ? { cookie } : {}) } })
  let sseStatus = 0
  let buf = ''
  sse.on('response', (res) => {
    sseStatus = res.statusCode
    res.on('data', (c) => {
      buf += c.toString('utf8')
      let idx
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        let event = 'message'
        let data = ''
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim()
          else if (line.startsWith('data: ')) data += line.slice(6)
        }
        if (!data) continue
        try {
          const parsed = JSON.parse(data)
          if (parsed.id === JOB_ID) (events[event] || events.output).push(parsed)
        } catch { /* non-JSON frame */ }
      }
    })
  })
  sse.on('error', (e) => log('[sse] error: ' + e.message))
  await new Promise((r) => sse.end(r))

  const halfMs = (SECONDS / 2) * 1000
  const endMs = SECONDS * 1000
  const t0 = Date.now()
  await new Promise((r) => setTimeout(r, halfMs))
  let killRes = null
  try {
    killRes = await request('POST', '/dsh-review/jobs/' + encodeURIComponent(JOB_ID) + '/kill', cookie, JSON.stringify({}))
    log('[kill] HTTP ' + killRes.status + ' ' + killRes.body.slice(0, 120))
  } catch (e) {
    log('[kill] request failed: ' + e.message)
  }
  const remaining = endMs - (Date.now() - t0)
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining))
  try { sse.destroy() } catch { /* noop */ }

  const outEvents = events.output
  const totalChars = outEvents.reduce((n, e) => n + String(e.text || '').length, 0)
  log('[sse] HTTP ' + sseStatus + '; target events: job=' + events.job.length + ' output=' + outEvents.length + ' (chars=' + totalChars + ')')
  if (outEvents.length) {
    log('[sse] first="' + outEvents[0].text.replace(/\n/g, '') + '" last="' + outEvents[outEvents.length - 1].text.replace(/\n/g, '') + '"')
  }
  const finalJob = events.job[events.job.length - 1]
  log('[final] target last status via sse: ' + (finalJob ? finalJob.status : 'none'))

  // 4. verdict
  const checks = {
    'jobs list contains target': jobs.some((j) => j && j.id === JOB_ID),
    'sse delivered target output': outEvents.length > 0 && totalChars > 0,
    'kill accepted': !!killRes && killRes.status === 200 && /"ok":true/.test(killRes.body),
    'target reached terminal status': !!finalJob && ['killed', 'completed', 'failed'].includes(finalJob.status),
  }
  const pass = Object.values(checks).every(Boolean)
  for (const [k, v] of Object.entries(checks)) log('  [' + (v ? 'ok' : 'FAIL') + '] ' + k)
  log(pass ? 'PASS' : 'FAIL')

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
  console.log('report -> ' + OUT)
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('verify crashed: ' + (e && e.stack || e))
  process.exit(1)
})
