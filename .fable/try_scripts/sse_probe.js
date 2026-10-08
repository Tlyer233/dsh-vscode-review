'use strict'
// Stand-in SSE client: mints the same browser-session cookie the extension
// mints, opens /dsh-review/events, and dumps the raw frame stream to a file.
// Usage: node sse_probe.js <seconds>
const fs = require('fs')
const http = require('http')
const crypto = require('crypto')
const os = require('os')

const DUR = Number(process.argv[2] || 40) * 1000
const OUT = '/Volumes/SAMSUNG_1T/Documents/CodeBeach/project/dsh-review-plugin/.fable/try_scripts/out/sse_capture.txt'

function b64url(v) { return Buffer.from(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '') }
function b64d(v) { return Buffer.from(v.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - v.length % 4) % 4), 'base64') }

const text = fs.readFileSync((process.env.DSH_HOME || os.homedir() + '/.dsh') + '/.credentials.yaml', 'utf8')
const m = text.match(/client-connection\/browser-session:[\s\S]{0,600}?\bsecret:\s*([A-Za-z0-9_-]{40,})/)
if (!m) { console.error('no browser-session secret found'); process.exit(1) }
const secret = b64d(m[1])

const authority = '127.0.0.1:3080'
const name = 'dsh-auth-' + b64url(crypto.createHash('sha256').update(authority).digest())
const issuedAt = Date.now()
const expiresAt = issuedAt + 3600e3
const body = b64url(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }))
const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest())
const cookie = name + '=v1.' + body + '.' + sig

const out = fs.openSync(OUT, 'w')
fs.writeSync(out, '# sse probe @ ' + new Date().toISOString() + ' (dur ' + DUR / 1000 + 's)\n')
const req = http.request({
  host: '127.0.0.1', port: 3080, path: '/dsh-review/events', method: 'GET',
  headers: { cookie, accept: 'text/event-stream', 'cache-control': 'no-cache' },
}, (res) => {
  fs.writeSync(out, 'HTTP ' + res.statusCode + '\n')
  res.on('data', (c) => fs.writeSync(out, c))
  res.on('end', () => { fs.writeSync(out, '\n[stream ended]\n'); try { fs.closeSync(out) } catch { } ; process.exit(0) })
})
req.on('error', (e) => { console.error('sse error:', e.message); process.exit(1) })
req.end()
setTimeout(() => { try { fs.closeSync(out) } catch { }; process.exit(0) }, DUR)
