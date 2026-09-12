'use strict'

/**
 * Local authenticating reverse proxy for the dsh sidebar webview.
 *
 * dsh web requires a browser session (`dsh web authentication required`). The
 * sidebar is a cross-site iframe (its parent is `vscode-webview://`), so the
 * SameSite=Strict session cookie is never sent and `/api` would look
 * cross-site. This proxy listens on its own loopback authority, injects the
 * signed session cookie server-side, and forwards everything to dsh — so the
 * iframe talks to a same-origin endpoint that always authenticates.
 *
 * The cookie is signed with dsh's persisted browser-session secret
 * (`$DSH_HOME/.credentials.yaml`), so no launch token and no dsh restart is
 * needed, and it stays valid across dsh restarts (dsh keeps the secret).
 */

const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const COOKIE_PREFIX = 'dsh-auth-'
const PAYLOAD_VERSION = 1
/** Slightly under dsh's 30-day cookie lifetime. */
const MAX_AGE_MS = 29 * 24 * 60 * 60 * 1000
const SECRET_FILE = '.credentials.yaml'

/**
 * @param {Buffer|string} value
 * @returns {string}
 */
function b64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

/**
 * @returns {string}
 */
function credentialsPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, SECRET_FILE)
}

/**
 * Read the persisted browser-session signing secret.
 * @returns {Buffer}
 */
function readSecret() {
  const file = credentialsPath()
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    throw new Error('cannot read ' + file + ': ' + String((e && e.message) || e))
  }
  const m = text.match(/client-connection\/browser-session:[\s\S]{0,600}?\bsecret:\s*([A-Za-z0-9_-]{40,})/)
  if (!m) throw new Error('browser-session secret not found in ' + file)
  const secret = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (secret.byteLength !== 32) throw new Error('browser-session secret in ' + file + ' has an unexpected size')
  return secret
}

/**
 * Mint the session cookie dsh accepts for one authority.
 * @param {string} authority host:port the browser sees.
 * @returns {string} `name=value`
 */
function mintCookie(authority) {
  const secret = readSecret()
  const issuedAt = Date.now()
  const payload = { version: PAYLOAD_VERSION, authority, issuedAt, expiresAt: issuedAt + MAX_AGE_MS }
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = b64url(crypto.createHmac('sha256', secret).update(body).digest())
  const name = COOKIE_PREFIX + b64url(crypto.createHash('sha256').update(authority).digest())
  return name + '=v1.' + body + '.' + signature
}

/**
 * Start the proxy.
 * @param {{ listenPort: number, targetPort: number, log?: (msg: string) => void }} opts
 * @returns {{ url: string, close: () => void, refresh: () => void }}
 */
function startAuthProxy(opts) {
  const listenPort = Number(opts.listenPort)
  const targetPort = Number(opts.targetPort)
  const log = typeof opts.log === 'function' ? opts.log : () => { }
  const authority = '127.0.0.1:' + String(listenPort)
  let cookie = ''

  const refresh = () => {
    cookie = mintCookie(authority)
    log('minted session cookie for ' + authority)
  }
  try {
    refresh()
  } catch (e) {
    log('cannot mint session cookie: ' + String((e && e.message) || e))
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  const forward = (req, res) => {
    const headers = Object.assign({}, req.headers)
    if (cookie) headers.cookie = cookie
    const up = http.request({
      host: '127.0.0.1',
      port: targetPort,
      method: req.method,
      path: req.url,
      headers,
    }, (upRes) => {
      // A stale cookie (rotated secret / expired) is re-minted for later requests.
      if (upRes.statusCode === 401) {
        try {
          refresh()
        } catch (e) {
          log('re-mint failed: ' + String((e && e.message) || e))
        }
      }
      res.writeHead(upRes.statusCode || 502, upRes.headers)
      upRes.pipe(res)
    })
    up.on('error', (e) => {
      log('upstream error: ' + String((e && e.message) || e))
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh is not reachable on 127.0.0.1:' + String(targetPort) + '\n')
    })
    req.pipe(up)
  }

  const server = http.createServer((req, res) => forward(req, res))

  // Upgrades (the Remote stream WebSocket) pass through with the same cookie.
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(targetPort, '127.0.0.1', () => {
      const headers = Object.assign({}, req.headers)
      if (cookie) headers.cookie = cookie
      const lines = [String(req.method) + ' ' + String(req.url) + ' HTTP/1.1']
      for (const key of Object.keys(headers)) lines.push(key + ': ' + String(headers[key]))
      up.write(lines.join('\r\n') + '\r\n\r\n')
      if (head && head.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
  })

  server.on('error', (e) => log('listen failed: ' + String((e && e.message) || e)))
  server.listen(listenPort, '127.0.0.1', () => log('listening on http://' + authority + ' -> 127.0.0.1:' + String(targetPort)))

  return {
    url: 'http://' + authority,
    refresh,
    close: () => { try { server.close() } catch { /* noop */ } },
  }
}

module.exports = { startAuthProxy, mintCookie }
